# Zsh native editor and history module

`cosmosh_zsh.c` supplies the `cosmosh_editor_apply` builtin. The Shell adapter
owns request activation, private socket messages and the temporary writable
ZLE widget. Native modes perform final input assignment and Shell-owned history
observation/removal without reading the current buffer or directory for history.
The module installs no hooks, signals or keys.

## Load and call

Load `zsh/zle` normally first. Zsh rejects an absolute module name. Use a function
with a local, single-directory `module_path` containing the verified installed
module directory, then run `builtin zmodload cosmosh_zsh`. The function restores
the user's module path on return. The installed filename is `cosmosh_zsh.so`.
The module declares its dependency on `zsh/zle`, so Zsh cannot unload the ZLE
implementation while this builtin still retains its native parameter methods.
Unloading `cosmosh_zsh` removes only its builtin; loading it again is supported.

`builtin cosmosh_editor_apply status` returns zero when this process owns the
loaded module. `builtin cosmosh_editor_apply notification` creates an anonymous
notification pipe in the original process, outside a subshell. The caller must
first declare `__COSMOSH_EDITOR_NOTIFY_FD` and `__COSMOSH_EDITOR_NOTIFY_KEEP_FD`
as empty, mutable ordinary scalars. The builtin assigns the read and write
descriptor numbers directly; it prints nothing. Both descriptors are
nonblocking, close on exec, at least 10, and registered as Shell-owned external
descriptors. The caller closes them with ordinary `exec {name}<&-` / `>&-`
syntax. Failure closes newly created descriptors; a successful pair outlives
module unloading until the Shell closes it. This avoids Zsh 5.8's missing
`sysopen -o nonblock` option without adding a process or persistent FIFO file.

The no-argument form must run inside the existing writable
primary ZLE widget. It reads these ordinary local scalar parameters from the
caller's dynamic scope:

| Parameter                                              | Value                                                |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `__cosmosh_line`, `__cosmosh_point`                    | Exact expected buffer and Unicode codepoint cursor   |
| `__cosmosh_replacement`, `__cosmosh_replacement_point` | Approved replacement and codepoint cursor            |
| `__cosmosh_prompt_generation`                          | Expected primary prompt generation                   |
| `__cosmosh_input_epoch`, `__cosmosh_input_sequence`    | Forwarder session and fully delivered input boundary |
| `__cosmosh_request_id`                                 | Single-use authorized request UUID                   |

Numeric fields can also use ordinary integer storage. The module rejects
arrays, special/private getters, arithmetic expressions, malformed UTF-8,
embedded NUL, control characters other than TAB, and text above 8192 bytes.
No command text enters process arguments, files, logs or terminal output.

The no-argument return codes are 0 for local assignment, 1 for refusal without
assignment, and 2 for a changed editor whose immediate result cannot be verified.
The caller must still confirm the actual buffer/cursor after the containing
widget returns: ZLE can normalize a cursor around combining characters at that
boundary. A missing confirmation remains unknown.

## Native history

The fixed `history-state` mode reads policy and namespace metadata only;
`history` reads complete newest-first native entries; `history-match` checks one
selected exact text before authorization; and `history-delete` rechecks source,
text and the one-use ordered grant before removing matches. Data modes run in
the original Shell's bounded read-only observation scope and use ordinary
private parameters plus NUL-framed stdin to the Go worker. They do not enter a
ZLE widget or change its undo state. History operations omit current input and
directory fields, Shell evaluation of the selected text and direct file I/O.

The reader excludes the current line, `TMPSTORE`/`NOWRITE` records and entries
with an ASCII leading space. It returns `private` for `HISTSIZE<=1`; once a
nonempty `HISTORY_IGNORE` is observed, history remains unsupported for that
Shell's lifetime. Up to 200 complete entries, 8 KiB each and 64 KiB total are
published from at most 10,000 scanned nodes. Deletion refuses a whitespace-
equivalent group with a different original text, private nodes or current
line/undo references; eligible byte-exact duplicates are removed together.
It confirms only current-reader absence and never rewrites or saves a history
file. The opaque namespace rotates with native history context, `HISTFILE`,
`HISTSIZE` or list contraction, and starts from a randomized module revision.

## Critical section

The builtin temporarily blocks signals, authenticates the private local request
parameters and actual writable ZLE parameter methods, then takes the input
metadata flock without waiting. Inside that lock it rechecks native primary
reader state, foreground ownership, the controlling PTY input queue, ZLE queued
keys, generation and exact buffer/cursor. Only then does it consume the live
authorization and call ZLE's original BUFFER/CURSOR setters. It closes the lock
descriptor before restoring the previous signal mask. Redraw, hooks and remote
confirmation remain outside the call.

Use Zsh's original `SHTTY`, not descriptor 0, for the terminal checks: a ZLE
widget can run with standard input redirected. The shared fixed metadata format
is defined by `../bash/input_order.h` and `internal/inputorder`.

## ABI boundary

Only 64-bit Linux Zsh 5.8, 5.8.1 and 5.9 are accepted, with multibyte support,
the multibyte option enabled and a UTF-8 locale. All required symbols are
resolved before registering the builtin. Unknown versions or absent symbols
leave the feature unavailable. ZLE parameter getters/setters must belong to
the actual loaded ZLE image; ordinary same-named variables are refused.

The minimal declarations and setter behavior were checked against official
[Zsh 5.8 headers](https://github.com/zsh-users/zsh/blob/zsh-5.8/Src/zsh.h),
[Zsh 5.9 headers](https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/zsh.h),
[ZLE parameters](https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/Zle/zle_params.c)
and [ZLE buffer functions](https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/Zle/zle_utils.c).
No version-independent ABI compatibility is assumed. Packaging uses the same
glibc baseline, architectures and hardened shared-library flags as the Bash
adapter; this module includes the shared GPL-3.0-only metadata header.

## Reproducible tests

Build the checked native assets and start the existing disposable fixture:

```sh
node scripts/build-shell-native.mjs --if-stale
pnpm terminal:fixture start
node scripts/terminal-fixture/native-zsh.mjs
pnpm --filter @cosmosh/backend exec tsx --test src/terminal/integration/native-zsh.live-test.ts
```

The runner verifies the production asset hash and source fingerprint, then
compiles only the test signal injector in the existing pinned native builder.
Python runs inside the fixture, so no host Python installation is needed.
Windows uses WSL; Linux uses the configured Docker-compatible runtime. Neither
entry point installs the helper or changes shared account configuration.

The default reader is `/usr/bin/zsh`. Set `COSMOSH_FIXTURE_ZSH_EXECUTABLE` to an
already provisioned fixture path, such as
`/opt/cosmosh-fixture/zsh-5.8/bin/zsh`, to repeat the same checks on another
supported version. A missing executable fails the test. Both 5.8 and 5.9 have
been exercised with real PTYs, native undo, lifecycle/reload, refusal cases,
and signals injected immediately after the real kernel flock succeeds.

These tests isolate the final native module boundary with fixture-owned
authorization metadata; they do not replace the separate forwarder, private
worker and full SSH integration tests. Readers, temporary files and state
records are cleaned after each run, including bounded failure paths. Stop the
shared fixture after the surrounding verification task finishes.
