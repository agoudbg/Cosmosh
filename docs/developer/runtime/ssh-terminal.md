# SSH Terminal Implementation

## 1. Integration Overview (`ssh2` + `xterm.js`)

Cosmosh terminal path is split into control plane and data plane:

- **Control plane**: Renderer calls backend session creation through Main IPC bridge.
- **Data plane**: Renderer connects directly to backend WebSocket session endpoint and streams terminal I/O.

```mermaid
sequenceDiagram
  participant UI as Renderer SSH.tsx
  participant MAIN as Electron Main
  participant API as Backend SSH Route
  participant SSH as SshSessionService
  participant REM as Remote SSH Host

  UI->>MAIN: backend:ssh-create-session(serverId, cols, rows, term, connectTimeoutSec)
  MAIN->>API: POST /api/v1/ssh/sessions
  API->>SSH: createSession(input)
  SSH->>REM: ssh2 connect + shell()
  SSH-->>API: sessionId + wsUrl + wsToken
  API-->>UI: create-session response
  UI->>SSH: WebSocket /ws/ssh/{sessionId}?token=...
  UI-->>SSH: input/resize/ping/history-delete/completion-request
  SSH-->>UI: output/telemetry/history/completion-response/pong/exit
```

## 2. Backend Session Lifecycle

### Create Session

- Route: `POST /api/v1/ssh/sessions`
- Service: `SshSessionService.createSession`
- Request fields:
  - `cols` / `rows`: terminal viewport dimensions.
  - `connectTimeoutSec`: per-session SSH handshake timeout from Settings (`sshConnectionTimeoutSec`).
  - `strictHostKey`: explicit per-attempt host key policy propagated from SSH server configuration.
  - `enableSshCompression`: explicit per-attempt SSH transport compression policy propagated from SSH server configuration.
- Steps:
  1. Load server record + linked keychain encrypted credentials.
  2. Resolve trusted host fingerprints.
  3. Authenticate the primary SSH transport, complete optional pre-shell Remote Enhancements work on a temporary transport with the same connection policy, then open the primary shell through `ssh2.Client.shell` with a UTF-8 locale request.
  4. Write `SshLoginAudit` record:
     - `result = success` on successful session creation, with `sessionId` and `sessionStartedAt`.
     - `result = failed` on host-trust/auth/connect failures, with `failureReason`.
  5. Register live session state in memory (`Map<sessionId, SshLiveSession>`).
  6. Return short-lived attach token + WS endpoint.

Locale behavior:

- SSH shell creation requests `LANG=C.UTF-8` and `LC_CTYPE=C.UTF-8` through `ssh2` shell environment options, so UTF-8-aware terminal programs inherit a Unicode character type locale by default.
- `LC_ALL` is not set, leaving remote user preferences for time, collation, and numeric formatting intact.
- Cosmosh does not inject locale commands into the interactive shell stream. SSH servers may ignore these environment requests when their `sshd_config` does not accept them.

### Attach WebSocket

- Path: `/ws/ssh/{sessionId}?token=...`
- Invalid or malformed path encoding, token, or session is rejected (`1008`) without allowing URL decode errors to escape the connection boundary.
- Existing attached socket is replaced (`1012`) to support single active attach. Close/error events from the superseded socket are ignored after ownership moves to the new socket.
- Before attach, visible output and trusted helper events share one bounded arrival-ordered stream-frame queue (2,048 frames and 1 MiB). Attach sends `ready`, pending bootstrap statuses, and the current enhancement runtime status before flushing retained frames; overflow evicts the oldest whole frames without regrouping the remaining output and events.

### Close Session

- API-driven close: `DELETE /api/v1/ssh/sessions/{sessionId}`
- Transport-driven close: socket close/error, SSH stream close, SSH client error.
- Dispose behavior: send terminal `exit` event before marking the session disposed, then clear runtime ownership, close SSH stream/client, and close WS.
- Audit finalization: update matching `SshLoginAudit` with `sessionEndedAt` and `commandCount`.
- Main treats every non-disposed entry in the SSH session registry as active when evaluating a window/app close. If the user approves the renderer warning dialog, `DELETE /api/v1/runtime/active-connections` closes all SSH sessions through the same service disposal path before the window is destroyed.
- The General > Behavior `Ask Before Closing Window` setting defaults on. When disabled, Main skips the renderer dialog but still calls the bulk-close endpoint before continuing the close; setting read failures retain the warning.
- Local terminal sessions and SSH transports owned only by port-forwarding rules are not counted by this close warning.

## 2.1 Connection Audit and Last-Used Sorting

- Server list payload maps `lastLoginAudit` to the latest **successful** login audit (`result = success`).
- This keeps "sort by last used" aligned with actual successful connections instead of failed attempts.
- Failed attempts are still persisted in `SshLoginAudit` for future query/audit features.

## 2.2 Local-First Security Audit Integration

- SSH runtime now emits additional local-first `AuditEvent` records for security-core operations while preserving `SshLoginAudit` compatibility.
- Current SSH-adjacent audit categories include:
  - `ssh-session`: connect success/failure and close lifecycle events.
  - `ssh-host-trust`: explicit trust-fingerprint confirmation events.
  - `ssh-server` / `ssh-keychain`: server/keychain entity mutations in route layer.
- Correlation strategy:
  - `requestId` tracks request-scope action chains.
  - `sessionId` tracks runtime session continuity.
  - `relatedRecordId` links compatible records (for example existing login-audit IDs where applicable).
- Metadata is sanitized before persistence, so secret-like fields are redacted by key policy and size-capped.
- Audit emission is best-effort and does not fail SSH session creation/close flows when logging fails.

## 3. Data Stream Protocol

### Client → Server

- `input`: raw terminal input bytes as UTF-8 string.
- `resize`: terminal cols/rows with bounded normalization.
- `ping`: heartbeat.
- `close`: explicit disconnect request.
- `history-delete`: request backend to delete a selected command from remote shell history.
- `completion-request`: request ranked command suggestions for current command prefix and cursor position.

### Server → Client

- `ready`: attach acknowledged.
- `output`: shell stdout/stderr output.
- `telemetry`: CPU/memory/network + command history snapshot.
- `history`: history-only snapshot push for immediate UI sync.
- `completion-response`: ranked completion candidates for the active command token.
- `bootstrap-status`: remote bootstrap probe/download/install status from the backend side-channel installer.
- `remote-enhancement-runtime-status`: backend-owned `pending`, `active`, or `disabled` trust state plus the validated helper contract.
- `remote-shell-event`: helper shell state forwarded only through the active runtime gate.
- `pong`: ping response.
- `error`: protocol/runtime error.
- `exit`: terminal session closed with reason.

### 3.1 History Synchronization Model

- Backend command history is sourced from remote history probes and parsed shell history entries.
- On every SSH session creation, backend executes remote history probes and parses shell history into normalized commands.
- Remote history sources are probed in a compatibility order (shell builtin + common files), including Bash/Zsh/Fish/Ksh/Ash-style files and optional PowerShell PSReadLine history when available.
- Runtime-specific input stores (`.node_repl_history`, `.python_history`, `.sqlite_history`, `.mysql_history`, and `.lesshst`) are excluded from shell command history aggregation.
- SSH and local input handlers forward PTY bytes without retaining a command buffer or adding input to completion history. Password prompts and interactive programs share the same input stream, so Enter alone cannot establish a Shell command. History comes only from Shell-owned history sources; raw `cd` input does not change the completion directory.
- When an active trusted helper advertises `command-start`, backend treats each unique `commandId` as the authoritative command-count and delayed history-refresh trigger. Duplicate lifecycle events do not double count.
- Raw `input` line-submit characters (`\r` / `\n`) trigger the existing delayed + throttled history refresh only when the session has no active structured command lifecycle, preserving a conservative fallback for disabled/degraded helpers.
- History refresh and telemetry are decoupled: telemetry stays interval-based, while history can be pushed immediately through `history` events.
- Delete action in `SSH.tsx` sends `history-delete`; backend performs best-effort remote history file cleanup and then re-syncs history.

### 3.2 Auto-Complete Model

- Renderer queues typing-trigger autocomplete on local input and dispatches `completion-request` only after corresponding xterm output echo arrives (plus a short debounce). The configured focus shortcut triggers an immediate request when the list is empty; native `Tab` is preserved.
- Renderer gates autocomplete while xterm is in alternate screen buffer (for example `vim`, `less`, `top`) so shell completion does not hijack editor/TUI key handling.
- Renderer suppresses empty-input completion. Saved login password fill uses a separate action and never contributes completion items.
- Renderer keeps a per-pane local command-prefix shadow from xterm input events, so typing-trigger completion does not wait for remote shell echo before computing request prefix.
- Completion requests, output-echo wakeups, responses, and popup anchors carry an explicit pane id. Responses for a non-active pane or an older request id are discarded.
- When trusted `line-state` metadata is available, renderer calibrates the reconstructed prefix with `lineLength`, `cursorIndex`, and `promptGeneration`. It uses the cursor only when the reconstructed length and prompt generation agree; otherwise it keeps the conservative xterm/local-shadow result. The helper never sends the line buffer itself.
- After readline/history navigation control sequences (`ArrowUp`/`ArrowDown`/`Ctrl+P` style recall), renderer treats the next local input shadow as a suffix and reconciles it with the rendered xterm command line before sending completion requests. This keeps recalled commands such as `echo 1` in the completion prefix when the user continues typing.
- Command-start boundary detection no longer depends on a fixed prompt-token list. Renderer first parses shell command segment boundaries around cursor context (quotes + separators such as `;`, `&&`, `||`, `|`) and only then applies prompt-boundary heuristics.
- Prompt parsing is user-configurable via `terminalAutoCompletePromptRegex` (Settings > Terminal > Auto Complete). When set, this regex is applied as an override for prompt-prefix trimming; when empty or invalid, renderer falls back to built-in heuristics.
- Renderer also forwards source filter toggles in `completion-request` (`includeHistory`, `includeBuiltInCommands`, `includePathSuggestions`) based on Settings and defaults each source to enabled.
- Backend completion engine is shared by SSH and local-terminal session services and merges:
  - synchronized Shell history snapshots merged into the session's completion history cache,
  - command metadata imported from inshellisense/Fig resources (spec signal), generated from full command-path index rather than root-only subset,
  - runtime path providers composed in the same ranking pipeline.
- Token parsing is shell-aware in completion engine: SSH uses POSIX tokenization, local PowerShell/CMD sessions use Windows-friendly tokenization where backslash is preserved as a literal path character instead of generic escape.
- `packages/backend/scripts/generate-inshellisense.mjs` generates spec dataset plus locale resources with language-specific policy:
  - `packages/backend/src/terminal/completion/generated-inshellisense.ts` keeps command structure as a compact tuple payload and inflates it at module load; generated entries keep `descriptionI18nKey` references only (no duplicated raw description text payload).
  - `packages/i18n/locales/en/backend-inshellisense.json` is fully regenerated from upstream descriptions.
  - `packages/i18n/locales/zh-CN/backend-inshellisense.json` keeps only manually translated keys whose English source text is unchanged; new keys are not auto-filled, and keys are pruned when source text changes or is removed.
- Backend scope i18n merges `backend-inshellisense.json` into `backend.json`, so completion descriptions can be translated without mixing generated keys into base backend locale files.
- Generator sanitizes LS/PS Unicode separators (`U+2028`/`U+2029`) to keep generated TypeScript files free of unusual-line-terminator warnings.
- Ranking strategy in current implementation:
  - command-path-aware matching first (for example, `git push -` resolves against `git push` spec before falling back to root `git`),
  - prefix match first, then optional fuzzy subsequence match,
  - built-in command-spec candidates are prioritized above generic history matches,
  - history candidates are filtered by command context and receive dynamic recency bonus based on distance from latest run.
- Suggestions are rendered as full command paths (for example, `git push --force`).
- Source-specific toggles independently control history, built-in command, and path suggestions. The saved login password action has its own setting and remains visible in Settings when autocomplete is disabled.
- Option parsing is argument-aware:
  - repeated option combinations are supported without losing command context,
  - known value-taking options (from Fig `args` metadata) can surface value suggestions,
  - already used options are deprioritized/filtered to reduce noisy duplicates in the same command line.
- Path completion is provider-based and command-context-aware:
  - built-in path rules currently cover directory-first navigation (`cd`, `pushd`) and common file/path consumers (`cat`, `vim`, `vi`, `nvim`, `nano`, `less`, `more`, `head`, `tail`, `grep`, `rg`, `sed`, `awk`, `find`, `ls`, `touch`, `rm`, `cp`, `mv`, `chmod`, `chown`, `chgrp`, `ln`, `tar`, `unzip`, `zip`, `scp`, `sftp`, `rsync`), plus direct executable-style path prefixes (`./`, `../`, `/`, `~`) at command position,
  - relative-path partial input (for example, `cd ../../c`) is resolved against tracked session working directory and ranked with "prefix first, contains fallback" matching,
  - SSH home-relative input (`~` / `~/...`) expands against the original interactive Shell's confirmed `$HOME`; the typed prefix remains in candidates,
  - SSH paths require a fresh physical CWD paired with the current prompt. Prompt text, renderer hints and independent exec `$PWD` probes are never directory sources. Dot-parent components remain intact for remote symbolic-link resolution,
  - typing-trigger requests apply a short path-provider timeout budget so command/history/spec candidates are not blocked by slow filesystem probes; manual `Tab` trigger still uses full provider results,
  - SSH path completion uses a larger typing budget than local terminals because remote exec latency is network-bound; this keeps overseas/high-latency servers from returning empty runtime path suggestions merely because the first directory scan exceeded a local-filesystem budget,
  - remote SSH path scans use POSIX parameter expansion (`${p##*/}`) instead of GNU-specific `basename --`, so path completion remains portable across GNU/Linux, BSD/macOS, and BusyBox environments,
  - typing-trigger history scoring is bounded to a recent history window to keep completion latency stable when shell history snapshots are large,
  - when current token starts with `-`, option/value suggestions keep priority and path provider is gated off for that token.
- **Saved login password fill** is a separate explicit action. The backend recognizes common English password prompts in a bounded visible output tail; this heuristic does not establish the requesting program's identity. The button names the saved server login password so the user can decide whether it is appropriate. Local terminals and key-only sessions have no eligible password; a private-key passphrase is never used.
- The backend emits only an opaque one-use token and a 45-second expiry. Any input, new prompt, trusted command/prompt transition, or disposal invalidates the old offer. Cursor/erase controls and fragmented escapes discard retained prompt text; fresh visible text is required before another offer. Spaces and complete SGR styling cannot extend an existing offer's lifetime.
- A click sends `credential-fill { token }`. The backend checks the registered session, current open WebSocket, PTY, token, expiry, eligible password, and persisted permission again after awaiting settings. Replaced sockets are rejected at the shared message boundary. The token is consumed before writing, so concurrent clicks cannot fill twice.
- The action writes the exact saved login password without adding Enter. Values containing control characters or exceeding 8 KiB are ineligible. The renderer receives only offer/result metadata; credentials never enter completion responses, diagnostic history, or action logs. The user presses Enter manually after filling.
- The persisted key `terminalAutoCompletePasswordEnabled` is retained for compatibility, but now controls this independent action. Ordinary autocomplete may be disabled while the action remains enabled. Unsupported prompt formats simply expose no action.
- Acceptance replaces the active token segment by default (`replacePrefixLength`), and can optionally use per-item `replacePrefixLength` override (for example root history items that should replace full typed prefix).
- For partial-token history completion (for example `docker e` -> `docker exec`), item-level `replacePrefixLength` is calculated from current typed token length to avoid over-delete and duplicated command segments.
- For history candidates accepted at non-root token positions, backend returns the command suffix from current token to end (not only one token), so selection can complete the full historical command continuation in one accept action.
- `completion-response` contains base `replacePrefixLength` plus items (`label`, `insertText`, optional item `replacePrefixLength`, `detail`, `source`, `kind`, `score`).
- Completion `detail` is localized in backend session services before response emission, with fallback chain: translated `detailI18nKey` → localized source label (`History` / `Command spec` / runtime labels such as `Directory`, `File`).
- Suggestions appear passively. Until explicitly focused, `Tab`, arrows, `Enter`, and `Escape` retain their native terminal behavior.
- `terminalAutoCompleteFocusShortcut` selects the entry shortcut: `Ctrl+Shift+Space` (default), `Ctrl+Alt+Space`, or `Alt+/`. Clicking the menu also enters it; clicking a candidate fills that candidate.
- Only the focused list consumes unmodified arrows, `Escape`, and the configured apply keys (`terminalAutoCompleteAcceptKeys`: `Tab`, `Enter`, or both). An unconfigured `Enter` retains Shell submission behavior. Candidate application still uses the existing insertion path; verified editor application is a follow-up step of the approved terminal plan.
- Typing, modified keys, IME composition, pane/tab changes, blur, disconnect, and disabling autocomplete release list ownership. The first input event is forwarded unchanged, and invalidated request responses cannot reopen an old list. A pending manual request never owns ordinary terminal keys.
- The list exposes its active option through the xterm input's temporary combobox accessibility attributes. DOM focus remains in xterm so typing and composition continue normally; the original attributes are restored when the list closes.
- Suggestion panel layout constraints:
  - panel anchor is clamped to terminal viewport bounds and recomputed when its wrapper or pane resizes,
  - panel width is computed from current pane available space (capped at desktop width target) and anchor clamping uses the computed width to avoid horizontal overflow,
  - panel body uses max height + vertical scroll (`max-h`) to keep large candidate sets fully reachable,
  - long labels/details are truncated to avoid horizontal overflow.

```mermaid
flowchart LR
  XT[xterm.js onData] --> MSG[input JSON]
  MSG --> WS[WebSocket]
  WS --> SSH[ssh2 shell stream.write]
  SSH --> OUT[shell stdout/stderr]
  OUT --> WS2[WebSocket output event]
  WS2 --> XT2[xterm.write]
```

## 4. Host Verification & Trust Flow

- SSH connect uses `hostHash: 'sha256'` and `hostVerifier`.
- `strictHostKey=true`: host fingerprint must be trusted; unknown fingerprint returns `SSH_HOST_UNTRUSTED`.
- `strictHostKey=false`: unknown host fingerprint is accepted for that session attempt.
- If fingerprint is unknown:
  - backend returns `SSH_HOST_UNTRUSTED` payload.
  - renderer opens trust dialog.
  - user confirmation calls trust endpoint.
  - renderer retries create-session.

## 4.1 SSH Transport Compression

- SSH server records persist `enableSshCompression`, defaulting to `false`.
- The SSH server editor exposes this as a server-level switch under Security.
- When disabled, backend passes `algorithms.compress = ['none']` to `ssh2`, making the default "no transport compression" policy explicit.
- When enabled, backend prefers `zlib@openssh.com`, then `zlib`, and finally `none` as a compatibility fallback.
- SSH terminal session creation may carry an explicit `enableSshCompression` value so retry/split flows stay bound to the resolved server snapshot.
- SFTP sessions and port-forwarding starts read the same persisted server flag on the backend, so shell, file-system, and forwarding transports remain aligned.

## 5. Exception Handling & Reconnect

### Current Behavior (Implemented)

- Session attach timeout: 30s.
- Any socket close/error transitions UI state to failed.
- Retry is available manually through the UI retry button (`SSH.tsx`) and targets the active pane only. Its temporary target-readiness transition does not dispose or reconnect sibling pane runtimes.
- Retry is bound to the tab's latest resolved target snapshot and never re-reads global target selection.
- If the first connect fails before any snapshot is captured, manual retry falls back to fresh intent resolution for that tab.
- Each connect attempt has attempt identity (`attemptId`) with stale-result dropping and abortable pre-connect resolution.
- A pane keeps its xterm instance, loaded addons, renderer, dimensions, and event listeners across reconnect, but a replacement backend PTY is an explicit terminal-emulator session boundary. Renderer first invalidates the previous attempt, closes the previous WebSocket/backend session, drains queued old-session writes, and captures the normal buffer through `SerializeAddon` with `excludeAltBuffer` and `excludeModes` before creating the next backend session.
- The ordered boundary verifies that the attempt still owns the pane, clears pane reducer state, command markers/timeline, and autocomplete bookkeeping, then writes CAN + RIS followed by the sanitized normal-buffer snapshot, SGR reset, and a separating newline as one local xterm output chunk. This is necessary because xterm 6's synchronous JavaScript `Terminal.reset()` does not clear queued writes or an incomplete parser sequence. The reset bytes and snapshot are never sent through `onData`, WebSocket, or the backend PTY.
- The session-boundary reset returns xterm to the normal buffer, rebuilds retained text/style scrollback without restoring the alternate buffer, clears selection/decorations, resets parser state and session-local VT modes (including application cursor keys, mouse tracking, bracketed paste, insert, and origin), and retains terminal options, rows/columns, addons, WebGL attachment, and registered event/parser handlers. Inline images, command markers/timeline, selection, and alternate-buffer content are intentionally session-local and are not restored.
- If normal-buffer serialization fails, renderer logs the failure and continues with a clean reset rather than blocking reconnection; history preservation is best-effort while PTY recovery remains available.
- The same boundary applies when Cosmosh replaces a local-terminal PTY: SSH and local PTYs are independent sessions even though they share the renderer controller. Initial connection attempts do not reset a newly created xterm.
- Primary and secondary panes both gate reset and session creation with their pane-local attempt identity. Reset and history replay share one ordered xterm write, so an attempt superseded after capture cannot expose an empty or partially restored buffer to its successor. A stale attempt cannot attach its late WebSocket/session result; late results are explicitly closed.
- Hidden tabs do not trigger new connection side effects; only active tab can start connect flow.
- When `sshReconnectOnFocus` is enabled, reactivating a tab reconnects every failed pane that has no connecting/open socket. The first activation of a deferred tab always starts its primary pane, independently of that preference.
- No automatic exponential reconnection loop is implemented yet.

### Recommended Next Step (Planned)

- Add bounded auto-reconnect only for transient WS transport failures.
- Keep host-verification and auth failures as terminal (non-retriable) errors.

## 6. Performance Strategies in Current Code

- Renderer binds Settings `sshMaxRows` to xterm `scrollback` when initializing SSH terminal.
- Renderer uses `FitAddon` + resize observer to keep shell size synchronized.
- Renderer uses `@xterm/addon-webgl` for hardware-accelerated terminal rendering when Settings `terminalHardwareAccelerationEnabled` is enabled (default on).
- Renderer can use `@xterm/addon-image` for experimental terminal inline images when Settings `terminalInlineImagesEnabled` is enabled (default off). The addon parses SIXEL and iTerm inline image protocol output for newly created SSH and local-terminal panes.
- Renderer uses `@xterm/addon-web-links` to detect HTTP/HTTPS URLs in terminal output when Settings `terminalWebLinksEnabled` is enabled (default on).
- Backend normalizes terminal sizes to prevent extreme allocations (`20-400 cols`, `10-200 rows`).
- Backend rejects any single client WebSocket message above 1 MiB with close code `1009`, before terminal JSON parsing or transport writes.
- Pending output queue avoids losing early SSH output before WS attach.
- Pending output buffering is bounded by chunk count and total bytes; overflow drops oldest chunks and emits drop logs.
- Telemetry sampling is interval-based (5s) and lightweight text parsing to reduce per-frame cost.
- Background SSH exec probes used by telemetry, history, and completion are capped at 15 seconds and 1 MiB stdout; timeout, excessive output, synchronous client failure, or channel error resolves as unavailable data instead of leaving periodic work in flight.
- History refresh uses debounce + throttle to balance freshness and remote execution overhead.

## 6.1 Renderer-Configurable xterm Options (Settings-Driven)

Renderer now maps terminal runtime behavior from Settings to `ITerminalOptions` during `Terminal` initialization in `SSH.tsx`.

- **Theme / SSH Style**:
  - `altClickMovesCursor`, `cursorBlink`
  - `fontFamily`, `fontSize`
- **Theme / Advanced Style**:
  - `cursorInactiveStyle`, `cursorStyle`, optional `cursorWidth`
  - `customGlyphs`, `fontWeight`, `fontWeightBold`, `letterSpacing`, `lineHeight`
- **Terminal / Advanced Terminal**:
  - `drawBoldTextInBrightColors`
  - `scrollSensitivity`, `fastScrollSensitivity`, `minimumContrastRatio`
  - `screenReaderMode`, `scrollOnUserInput`, `smoothScrollDuration`, `tabStopWidth`
- **Terminal / Runtime**:
  - `terminalHardwareAccelerationEnabled` controls optional `WebglAddon` loading for SSH and local terminal sessions, including split panes. The setting defaults to enabled.
  - `terminalInlineImagesEnabled` controls optional `ImageAddon` loading for SSH and local terminal sessions, including split panes. The setting defaults to disabled and is constructor-driven: changing it applies to newly created terminal instances.
  - `terminalInlineImageOptions` is a JSON setting edited through Settings Editor with a strict JSON Schema. Exposed fields are limited to `enableSizeReports`, `pixelLimit`, `sixelSupport`, `sixelScrolling`, `sixelPaletteLimit`, `sixelSizeLimit`, `storageLimit`, `showPlaceholder`, `iipSupport`, and `iipSizeLimit`; Kitty/TGP options are intentionally not exposed in this pass.
  - Inline images support SIXEL and iTerm inline image protocol output only when enabled. Remote output can allocate decoded image buffers, so validation bounds pixel count, sequence byte limits, storage MB, and caps `sixelPaletteLimit` at `4096`.
  - Inline image and WebGL addons are designed to coexist: renderer loads `ImageAddon` before `terminal.open(...)`, then synchronizes `WebglAddon` after open so WebGL can bind the mounted renderer. Image addon initialization failures log a warning and do not disable WebGL or block terminal startup.
  - Inline image rendering pins only the image canvas above renderer canvases and forces that image layer to use a synchronized transparent 2D context. xterm remains responsible for DOM row, selection, decoration, and link stacking so selection text contrast stays consistent with the default renderer; the transparent context prevents the full image canvas layer from becoming an opaque black overlay when WebGL is active.
  - Inline image decoding depends on WebAssembly inside `@xterm/addon-image`, so the renderer CSP allows `script-src 'wasm-unsafe-eval'` while still omitting general JavaScript `unsafe-eval`.
  - `ignoreBracketedPasteMode` is derived from Settings `terminalBracketedPasteEnabled` (`false` when enabled, `true` when disabled).
  - Paste safety warnings are page-level guards in `SSH.tsx` before input reaches `terminal.paste(...)` or raw websocket `input`. Defaults are: `terminalWarnOnMultiLinePaste=true`, `terminalWarnOnLargePaste=true`, `terminalLargePasteWarningThreshold=5120`, and `terminalWarnOnControlCharactersPaste=true`.
  - Control-character paste detection checks for embedded ESC, BEL, ANSI control sequences, and C0/C1 control bytes other than tab/newline forms. Warning dialogs are per-paste decisions; accepting one paste does not disable later warnings.
  - Character width compatibility is derived from Settings `terminalCharacterWidthCompatibilityModeEnabled`; when enabled, renderer loads `@xterm/addon-unicode11` and switches xterm to Unicode 11 width tables for newly created terminal instances.
  - Unicode width switching uses xterm's proposed `unicode` namespace, so renderer-created SSH/local terminal instances set `allowProposedApi: true` before loading `@xterm/addon-unicode11`.
  - Context-menu paste, drag-and-drop text insertion, and selection-toolbar insert route through xterm `terminal.paste(...)` when enabled, so shell-side bracketed paste mode can keep multiline payloads from executing immediately.
  - `terminalCopyOnSelectionEnabled` defaults to `false`. When enabled, xterm selection-change events copy non-blank terminal selections to the system clipboard through `navigator.clipboard`; pure whitespace selections are ignored.
  - `terminalRightClickSelectsWord` maps directly to xterm `rightClickSelectsWord` and defaults to `false`.
  - `terminalForceSelectionModifier` defaults to `off`. `alt` maps to xterm `macOptionClickForcesSelection=true` and disables `macOptionIsMeta` for that terminal instance to avoid Option-key conflicts on macOS. `shift` and `ctrl` are persisted as setting values for future platform-specific selection handling, but current xterm-native behavior is only the macOS Option-click path.
  - `@xterm/addon-clipboard` is loaded with a Cosmosh-owned provider for terminal clipboard reads/writes (OSC 52).
  - Remote SSH sessions read clipboard policy from the server record field `terminalClipboardAccess`; local-terminal sessions read Settings `localTerminalClipboardAccess`.
  - Both policies default to `off`. Supported modes are `off`, `writeAskRead`, `readWrite`, and `askAlways`.
  - Write/read operations always surface a toast unless the operation was just approved through the explicit permission dialog; that approval is scoped to the single clipboard request.
  - `@xterm/addon-clipboard` handles protocol base64 encoding/decoding; the provider only receives and returns decoded text before calling `navigator.clipboard`.
  - `@xterm/addon-serialize` is loaded for every SSH/local xterm instance, including split panes, so renderer actions can serialize active selections without reaching into xterm internals.
  - The terminal context menu exposes `Copy as HTML` only when the active pane has a selection. The action serializes only the selected range with `serializeAsHTML({ onlySelection: true, includeGlobalBackground: true })` and writes one Clipboard API item containing both `text/html` and `text/plain`; it does not send data to backend sessions or persist clipboard history.
  - `terminalWebLinksEnabled` controls `@xterm/addon-web-links` loading for SSH and local terminal sessions, including split panes. The setting defaults to enabled, applies only to newly created xterm instances, and opens recognized HTTP/HTTPS links through Cosmosh's Electron external URL bridge.
  - `terminalWebLinksRequireModifierKey` defaults to enabled. When enabled, Windows/Linux links require `Ctrl+Click`, macOS links require `Cmd+Click`, plain clicks only select/focus terminal text, and link hovers show the pointer cursor only while the required modifier key is held. When disabled, a primary-button click opens links directly. Secondary-button clicks never open terminal links so right-click remains reserved for terminal context menus; on macOS, `Ctrl+Click` is also reserved for that context-menu gesture and never opens terminal links.

Notes:

- Optional numeric values (for example `cursorWidth`) are parsed defensively; invalid or empty input falls back to xterm defaults.
- Existing `sshMaxRows` remains bound to xterm `scrollback`.
- SSH server records may opt out with `disableCharacterWidthCompatibilityMode`; the effective rule is global setting enabled and server opt-out disabled. Local terminal sessions only use the global setting.
- Character width changes apply only to newly created xterm instances; existing SSH panes keep their active Unicode width provider until the pane/session is recreated.
- WebGL loading is best-effort: initialization failures fall back to xterm's default renderer without failing the terminal session. If WebGL context is lost, renderer disposes the add-on, disables WebGL retries for that SSH page runtime, and shows a one-time warning.

## 6.2 Split-Pane Terminal Interaction Model

- Renderer supports a constrained split progression in `SSH.tsx`:
  1. single pane,
  2. two side-by-side panes,
  3. three side-by-side panes,
  4. right-most pane split into two stacked panes.
- Split action is exposed from the terminal context menu (`Split Terminal`), and close action is exposed as `Close Terminal`.
- Terminal context menu renders platform-resolved shortcut hints for `Copy`, `Paste`, `Find...`, and `Clear Terminal`, and matching keyboard handling is wired for these actions (`⌘C`/`⌘V`/`⇧⌘F`/`⌃L` on macOS hints, `Ctrl+Shift+C`/`Ctrl+Shift+V`/`Ctrl+Shift+F`/`Ctrl+L` on non-macOS with active handlers). `Copy as HTML` is intentionally menu-only because it depends on a selected rich xterm range rather than a terminal-standard keyboard shortcut.
- Terminal right-click behavior is controlled by Settings `terminalRightClickAction` and defaults to `contextMenu`. `paste` consumes right-click and pastes clipboard text through the same paste-warning path. `copyOnSelectionElsePaste` copies the active pane selection when one exists, otherwise it pastes through the same paste-warning path.
- When an SSH tab becomes active, renderer restores keyboard focus to the active xterm instance so typing lands in the terminal immediately after tab switching.
- Maximum visible panes are capped at 4 in current implementation.
- Each split pane creates its own backend terminal session against the same resolved target (same SSH server/local profile), so panes can run independent commands.
- Secondary panes reuse the primary pane's resolved target snapshot semantics on retries.
- New split panes start from an empty viewport and render only their own session stream to avoid stale buffer carry-over from other panes.
- Every pane owns an independent xterm, WebSocket, backend session, transport state, telemetry, completion state, Remote Enhancements trust state, cwd, line state, debug history, and command markers. Primary and secondary messages pass through the same pane-aware reducer.
- Closing any pane disposes only that pane's socket/backend session and leaves surviving pane ids and runtimes unchanged. Closing the original primary does not transfer ownership by renaming another pane.
- Completion popup anchoring is resolved against the currently active pane container, and primary-pane ref updates must not overwrite active mirror-pane geometry after rerenders.
- In-terminal text search is implemented with xterm `SearchAddon` in both primary and mirror panes. `Find...` opens the shared `SearchReplacePanel` in find-only mode, with configurable filter toggles (`Case Sensitive` / `Regex`) plus compact previous/next navigation actions to highlight matches in the active pane.
- Search highlight decorations are explicitly cleared when the query becomes empty or the search panel is dismissed, which prevents stale search markers from keeping extra memory alive after search exits.
- Orbit Bar stays suppressed for the full search lifecycle (including empty query state and ESC close path) so search highlight flows do not re-open selection actions unexpectedly.
- Orbit Bar and selection-dependent terminal context-menu actions resolve selection geometry from xterm `getSelectionPosition()` first, with DOM selection blocks only as fallback. This keeps `WebglAddon` canvas rendering compatible with Orbit Bar placement and `Search Online` enablement.
- Orbit Bar and the terminal context menu hand explicit paths to SFTP. `./` and `../` require the source pane's current physical CWD; `~` requires confirmed HOME. Click actions reread that pane by id, even before a pane-activation render completes. Missing metadata disables the dependent action. Absolute paths/file URLs remain available; bare relative names and multiline selections are rejected. Backslashes, filename punctuation and quoted spaces are preserved.
- Opening a selected directory in SFTP always creates a new SFTP tab with that `initialPath`, even when another SFTP tab for the same server already exists, and does not replace the active SSH terminal tab.

## 6.3 Command Timeline

- Command Timeline defaults on under Settings > Terminal > Runtime. Each eligible SSH pane uses a 40 px right-edge command gutter only while the setting is enabled and its authenticated Remote Enhancements runtime is active and advertises `command-start`. The gutter combines a 34 px recent-command rail on the left with xterm's 6 px scrollbar on the right and sits flush against the pane edge without trailing root padding. Renderer reserves the rail through xterm padding and expands xterm's scrollable element across the full gutter, keeping the native scrollbar inside the element that owns its hover reveal, track clicks, and thumb dragging. Turning the setting off removes only the timeline rail and menu; it does not disable other Remote Enhancements capabilities. Ordinary SSH, local terminals, disabled helpers, failed handshakes, and helpers without that capability do not get a fallback rail; every terminal still uses the compact scrollbar.
- Pressing Enter records a hidden pane-local xterm input marker. A trusted `command-start` consumes the oldest pending marker only after earlier terminal output has been parsed, records the output-start row, and reconstructs only the submitted command from xterm rows. Configured or heuristic prompt parsing removes virtual-environment decorations and user/host/working-directory prompt metadata before the command is retained. The helper's sanitized executable remains lifecycle metadata and never replaces the displayed input. `command-end` records the output-end row.
- The recent-command entry is enabled only after the normal buffer contains more than two visible screens of content and more than three retained trusted commands. The threshold does not change the fixed rail reservation, so becoming eligible never changes terminal columns. Terminal pointer movement reveals the eligible entry in the normal buffer; five seconds without pointer movement hides it. Keyboard/IME input or paste originating inside xterm immediately closes its menu layers and hides the entry. Idle state hides the lines from sighted and keyboard users while preserving only their compact pointer target, so motion over the target can recover hover without waiting for a new `pointerenter`. The entry remains visible while either its command list or a row action menu is open unless xterm input dismisses it. Alternate-screen programs hide and disable the entry while retaining the fixed rail.
- The centered entry shows at most the newest eight uniform lines, each 12 px by 2 px with a 10 px gap and `color.text` at approximately 60% opacity. The lines form one menu affordance and no longer encode output size or provide per-line previous/next navigation.
- Pointer hover morphs the whole line group into one viewport-bounded, fixed 256 px shared-menu card. Its scrollbar-side edge remains fixed while the surface expands left over the rail. A normal Portal mount plus CSS `@starting-style` drives the 180 ms transform/opacity entry, while only pointer exit retains the Portal for a 140 ms reverse transition. `relatedTarget` checks and one 80 ms leave grace window cover transitions among the trigger, command card, and portaled row action menu, and a rapid re-entry retargets the current transition instead of restarting it. The row action menu blocks focus-out dismissal caused only by the hover-open parent restoring xterm focus and pins the parent card while it is open, so a pointer transition that skips the action-menu Portal cannot close both surfaces. Outside interaction, Escape, and selection still close the action menu and its parent card. The compact hit target uses the default arrow cursor because hover opens the card without a click. Keyboard opening is immediate, and `prefers-reduced-motion` retains only a short opacity transition.
- The card shows every valid marker still retained by the source pane, ordered from oldest to newest. Opening or updating it scrolls to the bottom. Long rows stay single-line and truncated; hovering or focusing a row shows its complete in-memory command in a wrapping shared tooltip. Selecting a row calls `scrollToLine` for that command's input marker and restores xterm focus. A row context menu can copy the in-memory command or insert it into the same pane without Enter; while the row action menu is open, pointer departure leaves both layers available until outside interaction, Escape, or selection closes them.
- Full command strings stay in renderer memory only. They are never persisted, logged, sent, added to telemetry, or copied into Remote Enhancements diagnostics. Trust loss, reconnect/reset, pane disposal, or xterm scrollback disposal releases both markers and command text; entries therefore belong only to the current pane, current connection, and retained normal-buffer scrollback.
- Primary and secondary runtimes refresh the model after parsed writes, scrolling, resizing, buffer changes, and marker disposal. Rail-reservation changes explicitly enter the existing pane fit/resize pipeline because descendant xterm padding does not resize the stable host by itself. The xterm host and fixed rail keep stable DOM ancestry across trust, activity, menu, and alternate-screen changes so TUI entry/exit and idle visibility never recreate the runtime or leave PTY columns out of sync.

## 7. Developer Debug Checklist

When SSH session behavior is wrong, verify in order:

1. Session creation API payload and validation path.
2. Host verification branch (`SSH_HOST_UNTRUSTED` vs direct session creation).
3. WS attach token/sessionId matching.
4. Stream direction integrity (`input` write and `output` flush).
5. Session disposal path (API close vs transport close vs SSH error).

### 7.1 Reproducible Real-Shell Tests

`pnpm test:terminal` runs the shared backend terminal/SSH and renderer SSH unit suites. Real PTY behavior has a separate required-fixture entry point: start the disposable OpenSSH container with `pnpm terminal:fixture start`, run `pnpm test:terminal:live`, then stop it with `pnpm terminal:fixture stop`.

The fixture owns temporary Bash, Zsh, and Fish accounts, generated test-only SSH keys, a pinned host fingerprint, and a loopback-only listener. Its files cover spaces, quotes, Unicode, symlinks, and large directories. It does not mount host homes or production credentials. Windows uses the container runtime in Debian WSL; Linux uses Docker, with Podman available through `COSMOSH_FIXTURE_RUNTIME`. See `scripts/terminal-fixture/README.md` for lifecycle and environment options.

The live suite fails explicitly if the fixture is unavailable. Unit test success alone does not establish real Shell, latency, or Electron interaction coverage.

Credential regressions exercise real password input without automatic submission and real encrypted-key authentication without passphrase reuse. Tests isolate only database/transport boundaries and use the production credential handler. Unit coverage includes delayed settings, duplicate clicks, new/erased prompts, expiration, replaced sockets, session disposal, and pane-local results.

### 7.2 Browser Interaction Checks

Run `pnpm --filter @cosmosh/renderer dev --port 28767`, then open `http://127.0.0.1:28767/tests/terminal-autocomplete.html` with `playwright-cli open`. From the repository root, run `playwright-cli run-code --filename=packages/renderer/tests/terminal-autocomplete.browser.cjs`. Output artifacts live in ignored `.playwright-cli/`; close the browser and stop Vite after testing.

For the independent credential action, open `/tests/terminal-credential.html` and run `playwright-cli run-code --filename=packages/renderer/tests/terminal-credential.browser.cjs`. This uses the production component and pane reducer with real xterm; server offer/result delivery and request capture are the only substituted boundaries. It verifies pending-button behavior, focus preservation, opaque requests, manual-Enter status, expiry, disconnect, and narrow viewport bounds. Full Electron session wiring remains a separate acceptance check.

These checks exercise the production xterm, autocomplete hook and menu for passive keys, explicit focus, modifiers, IME, stale replies, pane/focus changes, native-Tab output reconciliation, and stable transport-effect callbacks. Only WebSocket delivery is replaced. Real remote editor behavior and full Electron session lifecycle still require the SSH/Electron acceptance suite.

## 8. Remote Enhancements Runtime

Remote Enhancements are the optional runtime layer for host-aware SSH features such as OS/distribution detection, future SFTP helpers, and command shortcut/completion support. The current phase maintains a versioned helper contract and exposes bounded cwd/command-lifecycle events; later capabilities must attach behind the same gates and reuse the same user-scoped remote helper boundary.

### 8.1 Ownership and Gates

- `packages/backend/src/remote-bootstrap/service.ts` owns pre-shell orchestration. It fetches the manifest, probes the remote host, reads installed status, injects a download wrapper only when required, verifies the result, returns a trusted runtime contract, parses JSON-line statuses, and writes audit events.
- `packages/remote-bootstrap` owns the Go installer, helper generator, OSC protocol/capability declarations, installed-state validator, and wrapper renderer. See `packages/remote-bootstrap/README.md` for module-level build, test, path, and security details.
- The effective gate is `global setting && persisted server field && request override !== false`. The request field is disable-only: a stale renderer snapshot cannot re-enable a server that the current database record has disabled. The global and persisted server defaults are true, so deployment-level activation is controlled by the manifest URL until a user disables either gate.
- When either gate is disabled, backend does not run any remote command, ignores runtime shell OSC events from previously installed helpers, and emits a skipped `bootstrap-status` with code `REMOTE_ENHANCEMENTS_DISABLED`.
- Backend requires a manifest URL to load the bootstrap manifest. `COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL` is the first-class override. Unpackaged development runs default to the rolling `remote-bootstrap-dev` manifest so local development can exercise Remote Enhancements without per-shell setup. Packaged CI builds may also carry `remote-bootstrap/manifest-url.json`, generated before app packaging, so installers can discover the GitHub-hosted manifest without a user-provided environment variable. Tagged releases point at the same versioned GitHub Release as the app installers; `main` push builds point at `remote-bootstrap-dev`; pushed branches whose name contains `remote-bootstrap` and manual workflow dispatch runs can point at branch-scoped temporary prereleases such as `remote-bootstrap-branch-codex-remote-bootstrap-ci-release`. Ordinary PR and feature-branch builds do not package a default URL. Missing configuration does not run a remote probe or any other remote command; it only emits an explicit `MANIFEST_URL_NOT_CONFIGURED` failure when Remote Enhancements are enabled.

During development, the default manifest URL is `https://github.com/agoudbg/Cosmosh/releases/download/remote-bootstrap-dev/cosmosh-remote-bootstrap-manifest.json`. Set `COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL` in the same terminal that launches Cosmosh only when you need to override that default, for example to test a branch-scoped temporary prerelease:

Start `pnpm dev:renderer` first and wait for `http://127.0.0.1:2767`, then start `pnpm dev:main` in a second terminal. Remote Enhancements must be tested in the Electron window: opening the Vite URL directly has no preload bridge and does not start Main's managed backend child, so renderer-only browser testing cannot complete bootstrap or create an SSH session.

```powershell
$env:COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL="<manifest-url>"
pnpm dev:main
```

```sh
COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL="<manifest-url>" pnpm dev:main
```

### 8.2 Session Flow

```mermaid
sequenceDiagram
  participant UI as Renderer SSH Page
  participant SSH as SshSessionService
  participant BOOT as RemoteBootstrapService
  participant PRIMARY as Remote Host (primary transport)
  participant AUX as Remote Host (bootstrap transport)
  participant REL as HTTPS Manifest/Asset Host

  UI->>SSH: Create SSH session
  SSH->>PRIMARY: Authenticate primary SSH transport
  SSH->>BOOT: Ensure runtime before opening PTY
  BOOT->>REL: Fetch manifest URL
  BOOT->>AUX: Lazily authenticate temporary transport
  BOOT->>AUX: Probe uname, arch, and shell by bounded exec
  BOOT->>AUX: Run installed binary status
  alt Installed contract is current
    BOOT-->>SSH: Current contract, no download
  else Missing, legacy, or stale
    BOOT->>AUX: Run injected launcher/wrapper by bounded exec
    AUX->>REL: Download matching bootstrap binary
    AUX->>AUX: Verify checksum and install user-scoped files
    BOOT->>AUX: Re-run installed binary status
    BOOT-->>SSH: Validated installed contract
  end
  SSH->>AUX: Begin temporary transport teardown
  SSH->>PRIMARY: Open PTY as first session channel
  PRIMARY-->>SSH: Login messages + integration-ready OSC
  UI->>SSH: Attach /ws/ssh/{sessionId}
  SSH-->>UI: ready + bootstrap/runtime status + buffered output
```

- The primary SSH transport authenticates first but opens no channel before bootstrap completes. When the first remote command is required, backend lazily opens a second authenticated transport with the same credentials, host-key policy, compression setting, and proxy policy. Every proxy-backed transport receives its own socket.
- All bootstrap probe/install/status `exec` channels run only on the temporary transport. Backend begins its teardown before the primary calls `client.shell(...)`; actual socket closure may complete asynchronously. The primary transport's first session channel is therefore the interactive PTY, preserving OpenSSH/PAM login messages such as Debian MOTD while still loading a newly installed profile hook in that same first shell.
- Disabled gates or missing/invalid manifest data never open the temporary transport. Its decrypted login password is discarded and is never copied into session state, status payloads, or audit metadata.
- Backend checks the installed binary before downloading. It skips download only when manifest version and asset SHA-256, supported protocol, helper contents, and profile hook are current. Missing fields from an older binary are incompatible and trigger reinstall. A second status read validates the installation before PTY creation.
- Successfully validated manifests are cached for five minutes and concurrent sessions share one in-flight load. Failed loads are not cached. Cancelling one session only stops that session from waiting and does not cancel the shared manifest request for other sessions.
- Each side-channel command uses `ssh2 exec` with `REMOTE_BOOTSTRAP_EXEC_OPTIONS`: 60 seconds and 256 KiB output. The entire optional pre-shell ensure has a stricter shared 15-second budget across settings, manifest I/O, temporary proxy/SSH connection, and exec work. Expiry stops waiting for proxy preparation, closes active exec channels, destroys the temporary client, emits `BOOTSTRAP_ENSURE_TIMEOUT`, and immediately continues to ordinary PTY creation. A preconnected proxy socket that completes after cancellation is destroyed on arrival. Installer output is parsed as JSON lines and never written into the interactive terminal stream.
- Ensure connection failure or timeout never turns a valid primary SSH authentication into a failed shell session. Backend begins temporary-transport teardown, opens the primary PTY with runtime state `disabled`, reports the failure, and ignores all helper-derived events for that session. If the primary transport itself fails during ensure, its error cancels temporary work and the ordinary session creation fails through the existing SSH error path.
- Go `install`/`status` output establishes installation identity and trust state; it does not directly provide cwd, input state, or command lifecycle data. Live shell data comes later from the Go-generated helper over OSC 777 and remains subject to the runtime gate.
- Renderer stores bootstrap status, runtime trust state, trusted cwd/line state, telemetry, lifecycle state, and a bounded 200-entry Remote Enhancements debug history independently for every pane. When Settings `remoteEnhancementsDebugEnabled` is enabled, the terminal context menu exposes `Remote Enhancements Debug` for the source pane; its overlay follows the active pane and never substitutes primary-pane data.
- Renderer reconstructs command-only timeline labels from its own rendered xterm rows after trusted `command-start`; helper event payloads continue to carry only the sanitized executable. Prompt identity metadata is discarded before retention, and timeline labels never enter the debug history or transport protocol.
- The debug overlay records status/event payloads only. It does not record terminal `input`, terminal `output`, passwords, private key material, or full screen output.
- Terminal `ready`, `output`, telemetry, history, completion, and shell-state messages remain independent from bootstrap progress.

### 8.2.1 Remote Shell Event Protocol

After Remote Bootstrap installs the helper, interactive shell startup files source a user-scoped shell integration. The helper emits runtime shell state through OSC 777 control sequences on the interactive PTY:

```text
ESC ] 777 ; cosmosh ; <base64-json> BEL
```

Backend parsing rules:

- `SshSessionService` streams SSH output through `RemoteShellEventOscParser` before writing to xterm.
- The parser returns an ordered sequence of visible-output and helper-event frames, and `SshSessionService` forwards those frames without regrouping them by type. Visible bytes before an event, especially the echoed input/newline before `command-start`, must reach xterm first so renderer markers capture valid input/output boundaries.
- The same ordering contract applies while the WebSocket is detached: visible output and accepted helper events enter one bounded pending-frame queue and are flushed in arrival order after the attach control messages. If runtime trust is disabled before attach, queued helper events are removed while ordinary terminal output remains available for replay.
- Cosmosh OSC sequences are stripped from visible terminal output and decoded, but events are forwarded and applied only after the backend runtime gate becomes `active`.
- The gate starts `pending` after pre-shell validation and a final permission check, then becomes `active` on a matching `integration-ready`. Missing handshakes disable it after 10 seconds. A version/capability mismatch from the original Shell disables its runtime; another Shell instance pauses usability without replacing the original identity.
- Non-Cosmosh OSC sequences and ordinary ANSI output stream through visibly and unchanged, including sequences split across SSH chunks.
- Invalid JSON, invalid event shapes, noncanonical Base64, decoded JSON over 32 KiB, and encoded OSC over 48 KiB are dropped. Individual cwd and executable fields retain their 4 KiB and 255-byte limits.
- Split SSH chunks are supported; incomplete OSC data is buffered until a BEL or ST terminator arrives.
- Protocol constants and Backend/Renderer unions come from `packages/api-contract/src/terminal-protocol.ts`. The current helper protocol is v3. Existing install/status validation refreshes old helpers; v2 events cannot activate a v3 session.

Server-to-renderer payload:

```ts
type RemoteShellEventMessage = {
  type: "remote-shell-event";
  event:
    | "integration-ready"
    | "prompt-ready"
    | "cwd"
    | "cwd-invalidated"
    | "command-start"
    | "command-end"
    | "foreground-command"
    | "line-state";
  shell: "bash" | "zsh" | "fish" | "sh" | "ash";
  shellInstanceId: string;
  helperVersion: string;
  protocolVersion: number;
  capabilities: string[];
  cwd?: string;
  physicalCwd?: string | null;
  homeDirectory?: string | null;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  commandId?: string;
  promptGeneration?: number;
  lineLength?: number;
  cursorIndex?: number;
  timestamp: number;
};
```

The shared TypeScript type is a discriminated union rather than the optional-field sketch above. `cwd` requires an absolute decoded cwd; command events require a bounded sanitized executable and `commandId`; `command-end` additionally requires `exitCode` and `durationMs`; `line-state` requires `lineLength`, `cursorIndex`, and `promptGeneration`. An event is rejected unless its name is advertised by the exact capability set. Dynamic cwd/command strings are canonical Base64 fields inside the helper JSON envelope, preventing tabs, newlines, quotes, or backslashes from corrupting JSON.

Current first-phase helper behavior:

- Bash 5.1 or newer preserves existing string/array `PROMPT_COMMAND` hooks as native array entries, retaining their order, original exit status and error behavior. Cosmosh callbacks return success and are protected from `errexit`; Bash itself restores the previous command status. Older versions retain plain terminal behavior without these hooks. The helper emits `cwd`, `prompt-ready`, and a `command-end` with matching command id, exit code, and duration. A guarded `DEBUG` trap emits one `command-start` and one `foreground-command` per submitted command line after prompt setup finishes. See [Bash interactive behavior](https://www.gnu.org/software/bash/manual/html_node/Interactive-Shell-Behavior).
- Zsh uses `precmd` and `preexec` hooks plus `line-pre-redraw` for numeric editor metadata. Required registrations must succeed; partial failures remove installed hooks. Prompt CWD remains pending until an idle ZLE observation confirms it after user prompt hooks. An additive `chpwd` hook invalidates asynchronous directory changes; redraw also detects changed PWD/HOME.
- Fish uses `fish_preexec`, `fish_postexec` and `fish_prompt` events while leaving user prompt functions intact. Fish calls prompt/title functions after the prompt event; if any later function changes PWD/HOME, one `cwd-invalidated` event disables that generation. The next stable report/prompt pair can recover. Metadata goes directly to the PTY even inside Fish's captured prompt output. Prompt functions that continually change directories require the planned verified editor exchange before their directories can be used.
- Sh/Ash install a prompt-capture fallback and advertise only `cwd` and `prompt-ready`; they do not claim command lifecycle support.
- Every shell emits `integration-ready` only after its advertised hook set has installed successfully. Non-interactive shells emit no OSC events.
- `command-start` and `foreground-command` are emitted for every submitted command that can be reduced to an executable name; they carry only that sanitized executable name (for example `vim`), not the full command line or arguments.
- OSC events never emit full command text, input buffers, passwords, or native completion lists. Zsh `line-state` contains numeric length/cursor metadata only. Requested editor snapshots use the separate private exchange below.

Backend state model:

- `terminal/shell-context.ts` owns the authoritative `ShellContext`, published as `{ type: 'shell-context', context }`. It contains session/Shell identity, exact version/capabilities, independent permissions, usability (`unavailable`, `initializing`, `ready`, `busy`, `paused`), reason codes and revision/input/prompt/cwd generations. No current input or credentials enter this model. Renderer retains the latest context per pane outside debug history; older revisions and replayed cwd/prompt events cannot overwrite it.
- Each interactive Shell gets a Linux UUID. Repeated sourcing preserves identity and hook registration; child processes get new identities, and Fish internal metadata is not exported. Only a newer original-Shell prompt resumes a foreign-shell pause. Sh/Ash keep directory capability with generation-less prompts and advertise no editor capability.
- Input invalidates asynchronous work before PTY forwarding. Enter, newline, Ctrl+C and Ctrl+D pause usability; command end stays busy until a new prompt. Directory operation boundaries and final results recheck current generations and permissions.
- Renderer invalidates its source pane before sending a submission. An opaque `submissionToken` echoed by Backend prevents already-queued older contexts from reopening directory actions. Receipt does not prove that Shell consumed typeahead: submissions made while busy/initializing/already submitting/in another Shell, or multiple boundaries in one input chunk (CRLF counts once), keep `requiresEditorConfirmation` in Backend-only state. Bare prompt events cannot restore usability. Zsh and eligible Fish configurations use out-of-band observations; Fish additionally retains uncertain key framing until reconnect. Bash recovery remains required before the full feature is released.
- Default-scope settings revisions update live sessions. CWD opt-out clears caches and rejects cwd events; input opt-out stops enhancement input tracking, candidate requests and rendered command capture while normal terminal I/O continues. History/path preferences populate separate permissions. Native completion defaults off and requires an implemented advertised provider. Global opt-out disables the runtime; re-enabling requires reconnecting. Settings reads stay inside optional setup's 15-second budget, so failures preserve ordinary SSH.
- Migration boundary: Bash, Zsh and Fish advertise `editor-state`, `input-snapshot` and `input-apply`, with actual availability checked separately. Renderer completion still uses its existing insertion path until the snapshot/range flow is connected. Structured directory reads, native providers and complete history permission enforcement remain subsequent changes. Directory consumers must also gain use-time confirmation: Zsh can asynchronously change HOME without emitting a hook, and user hook failures/removal can suppress invalidation. Steps 11 and 13 must refresh original-Shell PWD/HOME before resolving paths (including terminal-to-SFTP actions), recheck ownership/permissions, and reject unconfirmed operations. Long-lived `ready` metadata is not proof of perpetual freshness.
- Each session owns an explicit `pending`, `active`, or `disabled` enhancement runtime state, the contract validated before PTY creation, and a handshake timer that is cleared on activation, disablement, or session disposal.
- Each `SshLiveSession` keeps confirmed directory/foreground state plus the latest command id, sanitized executable, exit code, and duration. Unique structured `command-start` events drive command counting and history refresh; without that capability, Enter boundaries update only the counter and schedule Shell-owned history refresh, without retaining input text.
- `ShellContext.cwd` is the only usable remote directory source. A backend-only pending report is promoted at the matching `promptGeneration`; missing, stale or interrupted pairs leave CWD unavailable. Sh/Ash use one fresh report per generation-less prompt, cleared on submit/pause. `lastKnownCwd` is display-only. Logical paths are for display; physical paths and HOME drive file operations. Physical lookup uses an external `pwd -P` child of the actual Shell, avoiding cached built-in results for deleted directories; only its final output LF is removed. Unset/relative HOME and failed physical lookup remain null. No directory values are trimmed. Bash reports after existing `PROMPT_COMMAND` hooks while preserving their input exit status.
- When `remoteShellForegroundCommand` is set by `foreground-command`, backend returns an empty completion response until the next `prompt-ready`; `command-end` does not clear suppression early. This covers short commands, long-running foreground processes, and unknown TUI/REPL programs without maintaining a command whitelist.
- Renderer clears trusted cwd/line calibration immediately whenever backend trust leaves `active`, and applies prompt-generation checks before using `line-state` for completion. Command lifecycle events also maintain pane-local xterm navigation markers.
- The explicit saved login password action uses bounded output detection in the local backend; Shell hooks never capture password input, and completion has no credential source.

#### Private Bash editor exchange

The installed absolute binary path is retained from validated bootstrap status. Backend launches only that quoted path with the fixed `editor-request` subcommand. Request JSON goes to stdin; input never appears in OS command arguments, OSC events, audit records, files or debug history. The implementation uses existing SSH channels and a request-scoped Go process; it adds no daemon.

```mermaid
sequenceDiagram
  participant B as Backend session
  participant G as Bounded Go worker
  participant E as Original Bash Readline
  B->>G: Request identity and permitted fields via stdin
  G->>G: Verify PID generation, executable and foreground PTY
  G-->>B: Ready
  B->>B: Recheck context, permission and client ownership
  B->>E: Owned private binding for this prompt
  E->>G: Actual buffer/cursor or context-only observation
  alt Snapshot
    G-->>B: Validated observation
  else Apply
    G-->>B: Exact current observation
    B->>G: Authorize only if still current
    G->>E: Replacement as data
    E->>G: Assigned-buffer acknowledgement
    G-->>B: Applied or unknown
  end
```

- Each request has a 1.5-second remote lifetime, including its first stdin frame; Backend caps the exchange at three seconds and allows at most another 1.75 seconds for channel cleanup. Cancellation sends stdin EOF before waiting for channel closure. The worker removes its owned endpoint before sending a final result, including SSH termination signals. One operation and one snapshot are retained per session; the snapshot is actively erased after ten seconds. Buffers are limited to 8 KiB of UTF-8; JSON frames to 256 KiB. Line breaks, unsupported control characters and invalid cursor boundaries are rejected.
- Before triggering a private key, the worker inspects the original Shell's controlling stdin terminal without reading input. Canonical line discipline and special interrupt, suspend or flow-control characters that collide with trigger bytes reject the operation before any key is sent.
- The owner-only `/tmp/cosmosh-editor-<uid>` directory uses mode 0700; sockets use 0600. The worker validates same-UID peer credentials, ancestry to the original Shell, PID start time and controlling terminal. Existing endpoints are not removed. Cleanup checks inode identity before unlinking its own endpoint.
- Editor cursors and completion ranges use Unicode codepoints throughout the shared protocol, matching the supported native Shell editors. JavaScript uses codepoint arrays at these boundaries, never string length/slice indexes. Combining marks and ZWJ are separate codepoints; final native confirmation still catches editor cursor adjustments. Applying compares the complete original text, cursor, mode, prompt generation and requested directory metadata before assigning `READLINE_LINE`/`READLINE_POINT`. It sends no Enter and performs no command evaluation. Native undo restores the previous text in one step; Bash may place the restored cursor at line end.
- A zero-output PS2 prefix marks continuation input unavailable. The adapter preserves the user's suffix, requires `promptvars` and withdraws editor access if the user replaces its marker or binding. Repeated source preserves ownership. Each primary prompt rotates its private binding; the previous binding becomes a no-op, and older owned bindings are removed.
- Automatic Bash requests currently support a verified native Emacs editing profile. User macros, foreign `bind -x` handlers, unsafe printable-key mappings, vi modes and non-UTF-8 locales disable this adapter. Backend preserves native keys and pauses before forwarding Tab, search/macro/mode shortcuts or unknown escape sequences. This ambiguity remains fenced across subsequent primary prompts; reconnecting currently restores supported editing.
- Truly ambiguous typeahead remains paused. A fresh prompt event can precede a queued `read -s`, so neither byte counts nor foreground PID prove that an injected key will enter Readline. No automatic context probe is sent into that state. Resolving this limitation with Shell-owned consumption evidence remains required before the complete rescue plan is declared finished; reconnect currently establishes a fresh session.
- Context-only exchanges omit input entirely; CWD and input permission are checked independently. Input, changed permissions, replacement WebSocket clients, lifecycle events and teardown cancel pending work and erase cached snapshots. A dispatched request that times out or is cancelled locks that prompt's binding epoch; it is never retried there.
- Sensitive Shell output uses builtin commands, with tracing disabled before buffer access and internal DEBUG chaining suppressed. Optional failures are explicitly handled under `errexit`. Lost acknowledgement after authorization produces `unknown`, never a claim that no edit occurred or an automatic retry.

The real SSH regression is `src/terminal/integration/editor-bridge.live-test.ts`. Its observations supplement, rather than replace, the final Electron and supported-version acceptance matrix.

#### Private Zsh editor exchange

The Zsh adapter reuses the bounded worker, private socket, permission checks and snapshot lifetime above. Its notification uses an anonymous pipe owned by the original Shell. Both ends are nonblocking and close-on-exec; no filesystem FIFO or resident process is created. Go opens the reported `/proc/PID/fd/FD` and verifies FIFO type, UID, inode, PID generation and foreground PTY before writing one metadata-only byte. Desktop activation is required before notifying or accepting an observation, so a leftover byte from a canceled request cannot authorize a later request.

An ordinary `zle -F` callback drains notifications. A one-shot callback-local DEBUG trap exposes read-only editor parameters; the user's string/function trap is restored afterward. Reading through a user widget would change Zsh's native kill/yank bookkeeping, even with `nolast`. Therefore snapshots and context-only requests never invoke a writable widget. Input is read only after the worker confirms its permission scope; context requests omit BUFFER/CURSOR entirely. Tracing is disabled before private data is read.

- Supported observations require UTF-8, primary Emacs editing, no continuation, active region, recursive reader, partial key, pending terminal byte or queued macro key. Native search, completion menus, `vared` and vi mode are rejected without changing their keys. User widgets are accepted only after their functions have returned to ordinary editing.
- Zsh inputs pause directory usability before forwarding, even for printable characters that a user may bind to a custom reader. Recovery waits 120 ms after input; it performs only a context request and never blocks PTY forwarding. Requests coalesce and wait for an earlier worker's EOF cleanup before reading the newest context. Client attachment and permission changes reschedule canceled recovery; context can recover with input permission off when CWD permission remains on. A missing callback or unsupported state remains paused.
- Only approved application temporarily registers a uniquely named writable widget. It rechecks input, cursor and queued bytes, then assigns BUFFER/CURSOR without Enter or evaluation. Cleanup always removes only the still-owned widget. Confirmation runs after widget return, including Zsh's combining-character cursor normalization; a mismatch returns `unknown` rather than `applied`. The caller must refresh, never blindly retry an uncertain edit.
- Cancellation does not inject keys or lock the prompt epoch. Repeated helper sourcing preserves the pipe and identity; removed user registrations are never silently reclaimed. The read callback checks descriptor, FIFO type, inode, UID and registration ownership before reading. Revoked descriptors remain untouched; EOF/permanent errors remove only Cosmosh's own callback, while empty polls keep it available.

`src/terminal/integration/zsh-editor.live-test.ts` tests the actual Zsh 5.9 editor, autosuggestions 0.7.0, syntax-highlighting 0.7.1, native completion and prompt hooks. It covers private tracing, continuous kill/yank, pending keys, password readers, cancellation/activation races, asynchronous directories/HOME and combining characters. Zsh 5.8 and the complete Electron matrix remain final acceptance work. API behavior follows the [Zsh Line Editor documentation](https://zsh.sourceforge.io/Doc/Release/Zsh-Line-Editor.html); the read-only trap distinction is verified against Zsh's editor implementation and real SSH tests.

#### Private Fish editor exchange

Fish uses the same private request/authorization/confirmation exchange. A fixed `notification: { signal: 'URG' }` replaces terminal key injection. On Linux amd64/arm64, the worker obtains a pidfd, validates the original process/foreground PTY and sends SIGURG through that descriptor. Kernels without pidfd support cannot activate this adapter. A missing callback cannot terminate Fish because SIGURG's default disposition is ignored. User SIGURG handlers are never replaced.

- The supported baseline is Fish 4.0.1 with UTF-8 and the primary Emacs reader. Fish 3.6 and 4.0.0 retain ordinary terminal, native Tab and independently confirmed directory behavior. The adapter requires the newer live `commandline` and `status is-interactive-read` behavior; a version string alone never enables it.
- Native autosuggestions must already be explicitly disabled by the user (`fish_autosuggestion_enabled=0`). Cosmosh never changes this setting. Enabled autosuggestions can autoload arbitrary completion scripts while typing, including scripts that alter key bindings after inspection. They therefore keep their native grey-text behavior while Cosmosh precise input reading/filling remains unavailable.
- Key inspection runs only at the first native title evaluation after the prompt event. The original title runs first, with its incoming status and pipeline status preserved. Its event subscriptions and existing private-name conflicts prevent wrapping. Replacing the wrapper withdraws ownership. Signal callbacks never call `bind`: Fish can hold its key-map mutex while waiting for another key.
- Only a closed set of native actions and verified stock dependencies is eligible. Custom printable prefixes, raw escape prefixes, mode-changing mappings, functional abbreviations, optional user key/history hooks and unknown event handlers pause precise editing. Function-name inspection does not autoload user files. Stock function origins are checked; generated native definitions use exact 4.0.1 pins, so unrecognized distributions/versions fail closed.
- Every request rechecks handler ownership, unchanged handler registration, the autosuggestion setting, primary reader state, Emacs mode, search/pager/selection state and pending terminal bytes before reading input. Nested `read`, password readers, breakpoints, multiline input and programs are unsupported. Context-only requests omit input completely.
- Backend retains only fixed escape/paste framing metadata. Incomplete sequences wait for their remaining bytes. Tab, search and unknown control sequences pause the adapter for the remainder of the connection; reconnecting establishes a fresh boundary. A new prompt cannot clear this uncertainty because later queued input may still be waiting. Ordinary terminal input, native Tab and history keys continue to be forwarded.
- Exact application compares the complete text, cursor and requested directory metadata, groups replacement/cursor movement into one native undo operation, then confirms the actual assigned input. It never evaluates the replacement or sends Enter. Empty buffers use an explicit private sentinel because Fish drops empty command-substitution fields. Input data stays in memory and the private pipe/socket exchange.

`src/terminal/integration/fish-editor.live-test.ts` covers the official 4.0.1 runtime and distribution Fish 3.6 over real SSH. It verifies Unicode, editing in the middle, stale rejection, one-step undo, native grey suggestions, password readers, search/selection/vi/multiline rejection, custom key boundaries and non-autoloading inspection. The fixture pins official release artifacts by SHA-256. Full Electron/latency/version-matrix validation and renderer completion integration remain later plan steps.

#### Snapshot-bound completion edits

`completion/snapshot-edits.ts` recognizes a restricted literal simple command from the actual full editor buffer. Word ranges include original quotes and the part after the cursor; the decoded prefix contains only characters before the cursor. Space and tab delimit words, while nonbreaking spaces remain filename characters. Unfinished quotes are supported only in the current word. Expansion, pipelines, redirection, compound commands, ambiguous escapes and unsupported syntax yield no precise candidate; native Shell completion stays available.

Literal arguments use Shell-specific single quoting. Fish escapes backslashes/apostrophes inside single quotes; Bash/Zsh close the quote, escape an apostrophe and reopen it. Relative filenames beginning with `-` receive `./`. Unquoted `~/` is marked for resolution using the same snapshot's confirmed HOME; quoted `~` stays literal. Quoting is performed before a complete replacement is validated against the 8 KiB bound. No quoting function evaluates text.

Each `ShellEditorController` privately stores at most 128 candidate replacements alongside its ten-second snapshot. Providers supply codepoint ranges; the controller constructs complete buffers while preserving every character outside the range. Display candidates contain opaque IDs, labels, details, kind and source, with no insertion text or edit range. Later sources append without changing earlier identifiers. Applying an identifier repeats the existing session/context/permission/expiry checks and the original Shell's complete observation comparison. Input, snapshot replacement, revocation, expiry and teardown erase all associated edits.

This foundation is not yet wired to the renderer menu: its legacy completion messages remain until the planned consumer migration. `completion-edits.live-test.ts` exercises actual Bash, Zsh and Fish editors, then explicitly executes a fixed argument-inspection command to verify filename bytes and the unchanged suffix. The tests separately assert that accepting a candidate did not execute it.

### 8.3 Manifest and Asset Contract

```json
{
  "version": "1.2.3",
  "assets": [
    {
      "os": "linux",
      "arch": "amd64",
      "url": "https://downloads.example.test/cosmosh-remote-bootstrap-linux-amd64",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    {
      "os": "linux",
      "arch": "arm64",
      "url": "https://downloads.example.test/cosmosh-remote-bootstrap-linux-arm64",
      "sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    }
  ]
}
```

- `version` must contain only letters, digits, `.`, `_`, `+`, or `-`.
- `assets` must be non-empty.
- Every manifest asset must include an HTTPS `url` and lowercase 64-character `sha256`; one malformed asset invalidates the whole manifest so polluted release metadata fails visibly.
- The current target matrix selects assets only for Linux `amd64` and `arm64` remotes.
- The injected wrapper treats all manifest fields as quoted data, never as executable shell source, then downloads the binary with `curl` or `wget`, verifies it with `sha256sum` or `shasum`, and runs `cosmosh-bootstrap install`.
- `cosmosh-wrappergen` independently enforces the manifest version grammar, HTTPS asset URLs, and lowercase SHA-256 input validation before rendering shell source.
- `scripts/build-remote-bootstrap-release.mjs` builds `cosmosh-remote-bootstrap-linux-amd64` and `cosmosh-remote-bootstrap-linux-arm64`, computes SHA-256 values, and writes the git-ignored `packages/remote-bootstrap/dist/cosmosh-remote-bootstrap-manifest.json`. CI can override the download tag/base URL and the manifest `version`, so a fixed GitHub release tag can still publish a manifest version such as `dev-<commit-sha>`.
- Tagged release CI stages the helper assets plus manifest with the desktop packages, validates the complete inventory, generates checksums and provenance attestations, and only then uploads the bundle to the draft GitHub Release for the same tag. The app packages that tagged manifest URL. The `cosmosh-remote-bootstrap-*` prefix intentionally distinguishes helper assets from user-facing app installers on the release page.
- `build-main` CI always validates the Go package and manifest generation path. On `push` to `main`, a separate write-scoped job rebuilds the helper assets, publishes them to the fixed prerelease tag `remote-bootstrap-dev` with `--clobber`, and packages `https://github.com/<repo>/releases/download/remote-bootstrap-dev/cosmosh-remote-bootstrap-manifest.json` into the main build artifacts. On `push` to any branch whose name contains `remote-bootstrap`, or on manual `workflow_dispatch` with `publishRemoteBootstrap=true`, the same job publishes to a branch-scoped prerelease tag `remote-bootstrap-branch-<sanitized-branch>` and packages that manifest URL into the branch build artifacts. These branch prereleases are temporary internal test buckets and can be deleted after the PR is merged or abandoned. Ordinary branches and PRs only validate the build path unless a maintainer explicitly opts into the publish path.

### 8.4 Remote Requirements and Installed Files

Supported remote hosts:

| Dimension    | Supported values                   |
| ------------ | ---------------------------------- |
| OS           | `linux`                            |
| Architecture | `amd64`, `arm64`                   |
| Shell        | `bash`, `zsh`, `fish`, `ash`, `sh` |

Required remote tools:

- `mktemp` for temporary wrapper and download directories.
- `base64` for decoding the backend-injected wrapper payload.
- `curl` or `wget` for HTTPS asset download.
- `sha256sum` or `shasum` for checksum verification.
- The target shell selected by the probe.

Installed files stay under the remote user's scope:

| Purpose          | Default path                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap binary | `$XDG_DATA_HOME/cosmosh/bootstrap/bin/cosmosh-bootstrap` or `~/.local/share/cosmosh/bootstrap/bin/cosmosh-bootstrap`                |
| Version marker   | `$XDG_DATA_HOME/cosmosh/bootstrap/bin/.version` or `~/.local/share/cosmosh/bootstrap/bin/.version`                                  |
| POSIX helper     | `$XDG_CONFIG_HOME/cosmosh/bootstrap/helper.sh` or `~/.config/cosmosh/bootstrap/helper.sh`                                           |
| Fish helper      | `$XDG_CONFIG_HOME/cosmosh/bootstrap/helper.fish` or `~/.config/cosmosh/bootstrap/helper.fish`                                       |
| Bash hooks       | `~/.bashrc` plus the active login profile (`~/.bash_profile`, else `~/.bash_login`, else `~/.profile`) inside Cosmosh marker blocks |
| Zsh hook         | `~/.zshrc` inside a Cosmosh marker block                                                                                            |
| Sh/Ash hook      | `~/.profile` inside a Cosmosh marker block                                                                                          |
| Fish hook        | `$XDG_CONFIG_HOME/fish/conf.d/cosmosh.fish` or `~/.config/fish/conf.d/cosmosh.fish`                                                 |

The installer is idempotent. It emits `skipped` only when the installed version, exact binary contents, exact Go-generated helper contents, and every required shell hook are current. Bash login-profile blocks guard on `BASH_VERSION`, so a generic `.profile` read by Dash does not load the Bash helper. Login-profile selection checks the `.bash_profile` and `.bash_login` directory entries themselves, so a dangling dotfile-manager symlink remains the active Bash candidate and its target is created instead of incorrectly falling back to `.profile`. Binary/helper/version/profile replacement is atomic; existing profile permissions and symlink targets are preserved. The version marker is written only after all file and profile updates succeed. `status` reports both the compatibility `profilePath` and complete `profilePaths` collection.

### 8.5 Security and Failure Model

- Wrapper files and bootstrap working directories are created with `mktemp` under `${TMPDIR:-/tmp}` using restrictive permissions and exit cleanup.
- The remote wrapper uses `umask 077`; installer files use `0700` for directories/binaries and `0600` for new helpers/profiles where applicable. Existing profile modes are retained during atomic replacement.
- Missing `mktemp`, `base64`, downloader, hash tool, or target shell remains an explicit `bootstrap-status` failure rather than a silent fallback.
- The Go installer persists files under the remote user's XDG paths and only updates shell profile files inside a Cosmosh marker block. It does not require root and does not write global locations.
- Bootstrap audit metadata is status-only and must stay secret-free. SSH credentials, private keys, and terminal input are not part of this contract.
- Bootstrap/settings/manifest/install failures fail closed for enhancement data but fail open for the ordinary authenticated SSH shell. Previously installed helpers cannot be consumed unless the current ensure succeeded and the live helper handshake matches it.

Common status codes:

| Code                           | Meaning                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `REMOTE_ENHANCEMENTS_DISABLED` | Global Settings or server-level gate disabled bootstrap before any remote command; runtime shell OSC events are ignored for the session. |
| `MANIFEST_URL_NOT_CONFIGURED`  | Remote Enhancements are enabled, but backend has no manifest URL.                                                                        |
| `MANIFEST_FETCH_FAILED`        | Backend could not fetch the manifest URL.                                                                                                |
| `MANIFEST_INVALID`             | Manifest shape, asset URL, or SHA-256 failed validation.                                                                                 |
| `ASSET_NOT_FOUND`              | Manifest has no asset for the probed OS/architecture.                                                                                    |
| `PROBE_FAILED`                 | Remote OS, architecture, or shell is unsupported or could not be parsed.                                                                 |
| `BASE64_NOT_FOUND`             | Remote host cannot decode the injected wrapper payload.                                                                                  |
| `MKTEMP_NOT_FOUND`             | Remote host lacks `mktemp`.                                                                                                              |
| `DOWNLOADER_NOT_FOUND`         | Remote host has neither `curl` nor `wget`.                                                                                               |
| `HASH_TOOL_NOT_FOUND`          | Remote host has neither `sha256sum` nor `shasum`.                                                                                        |
| `CHECKSUM_MISMATCH`            | Downloaded binary did not match the manifest SHA-256.                                                                                    |
| `BOOTSTRAP_ENSURE_TIMEOUT`     | The complete optional pre-shell ensure exceeded 15 seconds; active side-channel work was cancelled and ordinary PTY creation continued.  |
| `INSTALLATION_NOT_CURRENT`     | Post-install status did not match the selected version and supported runtime contract.                                                   |
| `HELPER_HANDSHAKE_TIMEOUT`     | No valid `integration-ready` event arrived within 10 seconds after PTY creation; runtime helper data was disabled.                       |
| `HELPER_CONTRACT_MISMATCH`     | Live `integration-ready` or a later helper event did not match the pre-shell contract; runtime data was disabled.                        |
| `FILE_INSTALL_FAILED`          | Installer could not create or copy user-scoped files.                                                                                    |
| `PROFILE_UPDATE_FAILED`        | Installer could not update the target shell profile hook.                                                                                |
| `VERSION_WRITE_FAILED`         | Installer could not write the final version marker.                                                                                      |

When debugging bootstrap behavior, first check which gate stopped the run, then verify manifest validity, remote probe support, remote tool availability, and finally user profile write permissions. A missing manifest URL should produce no remote probe command at all.

## 9. Windows Context-Launch to Local Terminal CWD

- Installer integration can register `Open terminal in Cosmosh` in Explorer context menus.
- Installer writes shell verb metadata (`MUIVerb`, icon) for Explorer context menu compatibility.
- Explorer launches Cosmosh with `--working-directory <path>`.
- When terminal-app registration is enabled, installer also generates `%LOCALAPPDATA%\Microsoft\WindowsApps\cosmosh.cmd` as a stable CLI launcher shim.
- Main process parses this argument and keeps it as one-shot pending launch context.
- Renderer launch behavior is controlled by Settings `terminalContextLaunchBehavior`:
  - `openDefaultLocalTerminal`: auto-opens an SSH tab with the default local terminal profile.
  - `openLocalTerminalList`: opens Home and focuses the Local Terminals group.
  - `off`: ignores context-launch auto-navigation.
- When `openDefaultLocalTerminal` is enabled, profile selection honors Settings `defaultLocalTerminalProfile` (`auto` or a concrete profile id loaded from current local terminal profiles) and falls back to first available profile.
- If Cosmosh is already running, `second-instance` pushes launch context to renderer via IPC event.

## 10. Keychain Credential Runtime Notes (2026-03)

- Session connect flow now resolves auth material from `SshServer.keychainId`.
- Supported keychain auth variants remain `password`, `key`, `both`; this keeps SSH runtime behavior stable while allowing future auth variant expansion in one place.
- Hidden keychains are eligible for automatic cleanup when no server references remain, preventing long-term secret record drift.
- `second-instance` resolution uses both CLI args and Electron `workingDirectory` as fallback, reducing context-loss cases where only focus happened.
- On local terminal session creation (`POST /api/v1/local-terminals/sessions`), Main forwards `cwd` once.
- Backend validates `cwd` and falls back to `os.homedir()` when path is invalid or inaccessible.

## 11. macOS CLI Context-Launch to Local Terminal CWD

- On packaged macOS builds, Main prepares a user-level launcher script at `~/Library/Application Support/Cosmosh/bin/cosmosh`.
- The launcher invokes the app executable with `--working-directory "$PWD"`, so terminal launch context is inherited from the current shell directory.
- Main tries to create a symlink to that launcher in common PATH locations (`/opt/homebrew/bin`, `/usr/local/bin`) without requiring runtime crashes on permission failures.
- If symlink creation fails due to permission restrictions, app startup continues and warns in logs; users can add the launcher directory to PATH or create a symlink manually.
- Once launched, context handling path is identical to Windows: Main resolves pending launch cwd and forwards it into the next local terminal session creation.

## 12. Server Proxy Resolution

- Global proxy mode is `off`, `system`, or `custom`; default is `system`.
- Server proxy mode is `default`, `off`, or `custom`; `default` inherits global settings.
- Custom URLs support `http://`, `https://`, and `socks5://`, including URL credentials. Paths, query strings, and fragments are rejected.
- For system mode, renderer asks Main to resolve `https://{host}:{port}/` through Electron `Session.resolveProxy` and sends the transient rule string with session creation.
- Backend parses ordered `PROXY`, `HTTPS`, `SOCKS5`, and `DIRECT` candidates, opens the tunnel, and injects the resulting socket into `ssh2`.
- Proxy candidates share the session connection timeout. Failure is terminal unless the system rules explicitly include a later `DIRECT` candidate.
