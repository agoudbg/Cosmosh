# SSH 终端实现

## 1. 集成概览（`ssh2` + `xterm.js`）

Cosmosh 终端链路分为控制面与数据面：

- **控制面**：Renderer 通过 Main 的 IPC bridge 调用后端创建会话。
- **数据面**：Renderer 直接连接后端 WebSocket 会话端点，传输终端 I/O 流。

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

## 2. 后端会话生命周期

### 创建会话

- 路由：`POST /api/v1/ssh/sessions`
- 服务：`SshSessionService.createSession`
- 请求字段：
  - `cols` / `rows`：终端视口尺寸。
  - `connectTimeoutSec`：来自设置项 `sshConnectionTimeoutSec` 的会话级 SSH 握手超时。
  - `strictHostKey`：从 SSH 服务器配置透传的会话级主机密钥策略。
- 步骤：
  1. 读取 server 记录与其关联 keychain 的加密凭据。
  2. 解析可信主机指纹。
  3. 通过 `ssh2.Client.shell` 打开 SSH shell。
  4. 写入 `SshLoginAudit` 记录：
     - 会话创建成功时写入 `result = success`，并记录 `sessionId` 与 `sessionStartedAt`。
     - 主机信任/认证/连接失败时写入 `result = failed`，并记录 `failureReason`。
  5. 在内存中注册会话状态（`Map<sessionId, SshLiveSession>`）。
  6. 返回短期 attach token 与 WS 端点。

### 附加 WebSocket

- 路径：`/ws/ssh/{sessionId}?token=...`
- 非法路径/token/session 直接拒绝（`1008`）。
- 若已有附加 socket，将被替换（`1012`），保持单活连接。
- 会话 attach 前输出会缓存，ready 后统一回放。

### 关闭会话

- API 驱动关闭：`DELETE /api/v1/ssh/sessions/{sessionId}`
- 传输驱动关闭：socket close/error、SSH stream close、SSH client error。
- 释放行为：发送 terminal `exit` 事件，清理遥测定时器，关闭 SSH stream/client，关闭 WS。
- 审计收尾：回写对应 `SshLoginAudit` 的 `sessionEndedAt` 与 `commandCount`。

## 2.1 连接审计与最近使用排序

- 服务列表中的 `lastLoginAudit` 映射为最近一次**成功连接**（`result = success`）。
- 这样“按上次使用排序”将基于真实成功连接，而不是失败尝试。
- 失败连接仍会写入 `SshLoginAudit`，用于后续日志查询/审计能力。

## 3. 数据流协议

### Client → Server

- `input`：UTF-8 字符串形式的终端输入字节。
- `resize`：带边界归一化的 cols/rows。
- `ping`：心跳。
- `close`：显式断开请求。
- `history-delete`：请求后端删除远端 shell 历史中的选中命令。
- `completion-request`：基于当前命令前缀与光标位置请求排序后的补全候选。

### Server → Client

- `ready`：附加确认。
- `output`：shell stdout/stderr 输出。
- `telemetry`：CPU/内存/网络 + 命令历史快照。
- `history`：仅历史快照推送，用于即时 UI 同步。
- `completion-response`：当前命令 token 的排序补全候选。
- `pong`：ping 响应。
- `error`：协议/运行时错误。
- `exit`：会话关闭与原因。

### 3.1 History 同步模型

- 后端命令历史来源于远端 history 探测与 shell 历史解析结果。
- 每次 SSH 会话建立后，后端都会执行远端 history 探测并解析为标准化命令列表。
- 远端历史来源按兼容顺序探测（shell 内建 + 常见历史文件），覆盖 Bash/Zsh/Fish/Ksh/Ash 等格式，并在可用时兼容 PowerShell PSReadLine 历史。
- 运行时 REPL 专用历史（例如 `.node_repl_history`）会被排除，不作为 shell 命令历史聚合来源。
- 当渲染层发送的 `input` 包含提交字符（`\r` / `\n`）时，后端会以“延迟 + 节流”策略触发 history 刷新，避免过度抓取。
- history 与 telemetry 解耦：telemetry 仍为定时采样，history 可通过 `history` 事件即时推送。
- `SSH.tsx` 的删除操作会发送 `history-delete`，后端会以 best-effort 方式清理远端历史文件后再执行同步。

### 3.2 自动补全模型

- 渲染层会先在本地输入阶段记录 typing 补全请求，待对应 xterm 输出回显到达后（再经短延迟去抖）才发送 `completion-request`，从而保证弹层锚点始终基于已渲染光标几何。用户手动按下 `Tab` 仍会立即触发一次请求。
- 当 xterm 处于 alternate screen buffer（例如 `vim`、`less`、`top`）时，渲染层会门控关闭补全，避免 shell 补全劫持编辑器/TUI 的按键处理。
- 渲染层默认会抑制“空输入”补全（没有实际命令文本时不请求候选）；仅在明确的密钥提示流程中允许空前缀请求。
- 渲染层会基于 xterm 输入事件维护“按 pane 隔离”的本地命令前缀影子状态，使输入触发补全无需等待远端 shell 回显即可计算请求前缀。
- 命令起点边界识别不再依赖固定 prompt token 列表。渲染层会先按光标附近 shell 语义解析命令段边界（引号 + `;`、`&&`、`||`、`|` 等分隔符），再执行 prompt 边界裁剪。
- prompt 解析支持用户配置：`terminalAutoCompletePromptRegex`（设置 > 终端 > 自动补全）。配置后将优先使用该正则覆盖默认 prompt 裁剪；留空或正则无效时回退到内置启发式策略。
- 渲染层还会在 `completion-request` 中携带来源过滤开关（`includeHistory`、`includeBuiltInCommands`、`includePathSuggestions`、`includePasswordSuggestions`），其值来自设置项，且默认全部开启。
- 后端补全引擎由 SSH 与本地终端会话服务共享，候选来源合并为：
  - 当前会话实时输入流提取的交互命令（历史信号，按会话隔离），
  - 同步得到的 shell 历史快照会合并进补全历史缓存，保证在会话初期也能提供历史补全，
  - 来自 inshellisense/Fig 资源的命令元数据（规范信号，按完整命令路径索引生成，而非仅根命令子集），
  - 在同一排序流水线中组合的运行时 provider（路径补全 provider 与交互式密钥提示 provider）。
- 补全引擎的 token 解析按会话 shell 类型区分：SSH 使用 POSIX 规则；本地 PowerShell/CMD 使用 Windows 友好规则，反斜杠会作为路径字面字符保留，而不是通用转义符。
- `packages/backend/scripts/generate-inshellisense.mjs` 会生成规范数据与按语言策略处理的补全说明资源：
  - `packages/backend/src/terminal/completion/generated-inshellisense.ts` 仅保留命令结构与 `descriptionI18nKey`（不再冗余内嵌原始英文说明文本）。
  - `packages/i18n/locales/en/backend-inshellisense.json` 会根据上游说明全量重建。
  - `packages/i18n/locales/zh-CN/backend-inshellisense.json` 仅保留“英文源文本未变化”的手工翻译键；新键不会自动回填，英文源变化或删除时会自动清理对应中文键。
- backend 作用域 i18n 会将 `backend-inshellisense.json` 合并到 `backend.json`，从而支持补全说明翻译，同时保持基础 backend 语料与生成语料分离。
- 生成器会清理 LS/PS Unicode 分隔符（`U+2028`/`U+2029`），避免生成 TypeScript 文件触发异常行终止符警告。
- 当前排序策略：
  - 先做命令路径感知匹配（例如 `git push -` 优先解析 `git push` 规范，再回退到根命令 `git`），
  - 前缀匹配优先，其次可选模糊子序列匹配，
  - 内置命令规范候选优先于通用 history 命中，
  - history 候选会在命令结构相关前提下按“距离最近一次执行的距离”动态加权。
- 候选展示为完整命令路径（例如 `git push --force`）。
- 设置页运行时分组提供来源级别开关，允许用户独立关闭历史补全、内置命令补全、路径补全或密码补全，同时保留其他来源。
- 选项解析具备参数语义感知：
  - 支持多选项连续组合输入且保持命令上下文稳定，
  - 对已知“需要参数值”的选项（来自 Fig `args` 元数据）可返回参数值候选，
  - 同一条命令中已使用的选项会被降噪过滤，减少重复干扰。
- 路径补全采用 provider 化并结合命令上下文：
  - 内置路径规则当前覆盖目录优先导航命令（`cd`、`pushd`）与常见文件/路径消费命令（`cat`、`vim`、`vi`、`nvim`、`nano`、`less`、`more`、`head`、`tail`、`grep`、`rg`、`sed`、`awk`、`find`、`ls`、`touch`、`rm`、`cp`、`mv`、`chmod`、`chown`、`chgrp`、`ln`、`tar`、`unzip`、`zip`、`scp`、`sftp`、`rsync`），以及命令位的直接路径前缀（`./`、`../`、`/`、`~`），
  - 相对路径的部分输入（例如 `cd ../../c`）会基于会话跟踪的工作目录解析，并按“前缀优先、包含回退”匹配排序，
  - 输入触发（typing）的请求会对路径 provider 使用短超时预算，避免慢文件系统探测阻塞命令/历史/规范候选；手动 `Tab` 触发仍使用完整 provider 结果，
  - 远程 SSH 路径扫描使用 POSIX 参数展开（`${p##*/}`）替代 GNU 专有 `basename --`，以保证在 GNU/Linux、BSD/macOS 与 BusyBox 环境下都能稳定补全，
  - 输入触发（typing）的 history 评分会限制在“最近历史窗口”内执行，以在远端历史快照较大时保持补全延迟稳定，
  - 当当前 token 以 `-` 开头时，优先保留参数/参数值补全，当前 token 的路径 provider 会被门控关闭。
- 交互式密钥提示检测基于输出流：
  - 后端会跟踪近期输出尾部并检测常见提示（`sudo` 密码、`su`/通用密码提示、密钥口令提示），
  - 当提示处于激活状态且会话存在可复用密钥时，补全会返回运行时 `secret` 动作项（`填充密码`）实现一步填充。
- 接受 `填充密码` 后，渲染层不会自动再触发下一轮补全；后续候选仅在用户新输入或显式手动触发时出现。
- 接受补全时默认仅替换光标前的当前 token 片段（`replacePrefixLength`）；候选项也可携带 `replacePrefixLength` 覆盖值（例如需要替换整段已输入前缀的根命令历史候选）。
- 对“部分 token 的 history 补全”（例如 `docker e` -> `docker exec`），候选级 `replacePrefixLength` 会按“当前实际输入 token 长度”计算，避免误删前文导致错位或重复。
- 当在非根 token 位置接受 history 候选时，后端返回“从当前 token 到命令末尾”的后缀插入文本（而非仅单个 token），以便一次接受即可补完整段历史命令续写。
- `completion-response` 返回基础 `replacePrefixLength` 与候选项（`label`、`insertText`、可选候选级 `replacePrefixLength`、`detail`、`source`、`kind`、`score`）。
- `detail` 会在后端会话服务发送响应前完成本地化，回退顺序为：翻译后的 `detailI18nKey` → 本地化来源标签（`历史记录` / `命令规范` / 运行时标签，如 `目录`、`文件`、`填充密码`）。
- 候选可见时的键盘规则：
  - `ArrowUp/ArrowDown` 切换当前候选，并由补全导航独占消费，
  - 候选应用快捷键可在设置中通过 `terminalAutoCompleteAcceptKeys` 配置为 `Tab`（默认/当前方案）、`Enter` 或两者皆可，
  - 当启用 `Tab` 且当前没有候选时，按下 `Tab` 会立即触发一次手动补全请求，
  - `Escape` 关闭候选面板，
  - 当未将 `Enter` 作为应用快捷键时，`Enter` 仍保持 shell 提交语义。
- 候选面板布局约束：
  - 面板锚点会在终端可视区域内进行夹取，
  - 面板宽度会按当前 pane 可用空间动态计算（并受桌面目标宽度上限约束），锚点夹取也按该实际宽度计算，避免横向溢出，
  - 面板内容区使用最大高度与纵向滚动（`max-h`）保证长候选列表可完整访问，
  - 长命令与说明文本使用截断，避免横向溢出。

```mermaid
flowchart LR
  XT[xterm.js onData] --> MSG[input JSON]
  MSG --> WS[WebSocket]
  WS --> SSH[ssh2 shell stream.write]
  SSH --> OUT[shell stdout/stderr]
  OUT --> WS2[WebSocket output event]
  WS2 --> XT2[xterm.write]
```

## 4. 主机校验与信任流程

- SSH 连接使用 `hostHash: 'sha256'` 与 `hostVerifier`。
- `strictHostKey=true`：主机指纹必须已被信任，未知指纹返回 `SSH_HOST_UNTRUSTED`。
- `strictHostKey=false`：本次会话允许未知主机指纹继续连接。
- 若指纹未知：
  - backend 返回 `SSH_HOST_UNTRUSTED` 载荷。
  - renderer 打开信任确认弹窗。
  - 用户确认后调用 trust endpoint。
  - renderer 重试 create-session。

## 5. 异常处理与重连

### 当前行为（已实现）

- attach 超时：30 秒。
- 任意 socket close/error 都会让 UI 进入失败状态。
- 重试为 **手动**（`SSH.tsx` 的 retry 按钮），本质是创建新会话。
- 重试严格绑定到当前 tab 最近一次成功解析的目标快照，不会重新读取全局“当前选择”。
- 若首次连接在快照落库前失败，手动重试会回退到该 tab 的最新 intent 重新解析。
- 每次连接都有 attempt identity（`attemptId`），并带有过期结果丢弃与可取消的连接前异步流程。
- 隐藏 tab 不会触发新的连接副作用，只有 active tab 允许发起连接。
- 当前尚未实现自动指数退避重连。

### 推荐下一步（规划中）

- 仅针对临时性 WS 传输故障加入有界自动重连。
- 对主机校验失败/认证失败保持不可重试终态。

## 6. 当前代码中的性能策略

- Renderer 在初始化 SSH 终端时，将设置项 `sshMaxRows` 绑定到 xterm `scrollback`。
- Renderer 使用 `FitAddon` + resize observer 保持终端尺寸同步。
- Backend 对终端尺寸做归一化限制（`20-400 cols`、`10-200 rows`）。
- 通过 pending output queue 避免 attach 前早期输出丢失。
- pending output 采用“条目数 + 字节数”双上限；超过上限时丢弃最旧输出并记录日志。
- 遥测采用 5 秒定时采样 + 轻量文本解析，降低帧级开销。
- history 刷新使用防抖 + 节流策略，平衡实时性与远端执行开销。

## 6.1 渲染层可配置的 xterm 选项（设置驱动）

渲染层现在会在 `SSH.tsx` 初始化 `Terminal` 时，将设置项映射到 `ITerminalOptions`，用于控制终端运行时行为。

- **主题 / SSH 样式**：
  - `altClickMovesCursor`、`cursorBlink`
  - `fontFamily`、`fontSize`
- **主题 / 高级样式**：
  - `cursorInactiveStyle`、`cursorStyle`、可选 `cursorWidth`
  - `customGlyphs`、`fontWeight`、`fontWeightBold`、`letterSpacing`、`lineHeight`
- **终端 / 高级终端配置**：
  - `drawBoldTextInBrightColors`
  - `scrollSensitivity`、`fastScrollSensitivity`、`minimumContrastRatio`
  - `screenReaderMode`、`scrollOnUserInput`、`smoothScrollDuration`、`tabStopWidth`
- **终端 / 运行时**：
  - `ignoreBracketedPasteMode` 由设置项 `terminalBracketedPasteEnabled` 推导（开启时为 `false`，关闭时为 `true`）。
  - 开启后，右键粘贴、拖拽文本插入、选区工具栏插入会统一走 xterm `terminal.paste(...)`，从而让 shell 侧 bracketed paste 机制避免多行内容被立即执行。

说明：

- 对可选数值（如 `cursorWidth`）采用防御式解析；为空或不合法时回退到 xterm 默认行为。
- 原有 `sshMaxRows` 仍保持映射到 xterm `scrollback`。

## 6.2 终端分屏交互模型

- 渲染层在 `SSH.tsx` 中提供受限分屏序列：
  1. 单终端，
  2. 左右双栏，
  3. 横向三栏，
  4. 最右侧终端再纵向拆分为上下两栏。
- 分屏入口在终端右键菜单（`拆分终端`），关闭入口同样在右键菜单（`关闭终端`）。
- 当前实现最多同时展示 4 个终端窗格。
- 每个分屏窗格会针对同一已解析目标（同一 SSH 服务器/本地 profile）独立创建后端终端会话，从而支持独立输入输出。
- 镜像窗格在重试场景下始终复用主窗格的目标快照语义，避免会话目标漂移。
- 新增分屏窗格从空白视口启动，仅接入并展示该窗格自己的会话流，避免来自其他窗格的陈旧缓冲内容串入。
- 关闭窗格会释放该窗格自身 session/socket，其他窗格会继续运行。
- 补全弹层锚点必须始终基于当前激活窗格容器计算，主窗格容器 ref 在重渲染时不能覆盖镜像窗格的激活几何信息。
- 终端内文本搜索由主窗格与镜像窗格统一加载 xterm `SearchAddon` 实现。右键 `查找...` 会打开 command palette 输入框，底部提供两个 Toggle 选项（`区分大小写` / `匹配正则表达式`）以及紧凑导航按钮（`上个` / `下个` / `首个` / `末个`）在当前激活窗格中跳转并高亮匹配结果。
- 当搜索词清空或关闭搜索面板时，会主动清理搜索高亮装饰，避免陈旧搜索标记在退出搜索后持续占用额外内存。
- Orbit Bar 在搜索全流程中保持抑制（包括空搜索词状态和 ESC 关闭路径），避免搜索高亮期间重新弹出选区动作条。

## 7. 开发排查清单

当 SSH 会话行为异常时，按以下顺序检查：

1. 会话创建 API 的入参与校验路径。
2. 主机校验分支（`SSH_HOST_UNTRUSTED` 与直接建连分支）。
3. WS attach token 与 sessionId 是否匹配。
4. 数据流方向是否完整（`input` 写入与 `output` 回放）。
5. 会话释放路径是否正确（API close、传输关闭或 SSH 错误触发）。

## 8. Windows 右键启动与本地终端工作目录

- 安装器集成选项可在资源管理器右键菜单注册“在 Cosmosh 中打开终端”。
- 安装器会写入 shell verb 元数据（`MUIVerb`、图标）以兼容资源管理器右键菜单解析路径。
- 资源管理器通过 `--working-directory <path>` 启动 Cosmosh。
- 启用终端启动应用注册时，安装器还会生成 `%LOCALAPPDATA%\Microsoft\WindowsApps\cosmosh.cmd` 作为稳定 CLI 启动 shim。
- Main 进程解析该参数并保存为一次性启动上下文。
- 渲染层如何处理该上下文由设置项 `terminalContextLaunchBehavior` 控制：
  - `openDefaultLocalTerminal`：自动打开 SSH 页签并使用默认本地终端配置。
  - `openLocalTerminalList`：打开 Home 并聚焦到本地终端列表。
  - `off`：忽略上下文启动自动跳转。
- 当选择 `openDefaultLocalTerminal` 时，会优先使用设置项 `defaultLocalTerminalProfile`（`auto` 或来自当前本地终端列表的具体 profile id），若不可用则回退到首个可用配置。
- 若 Cosmosh 已在运行，`second-instance` 会通过 IPC 事件把启动上下文推送到渲染层。
- `second-instance` 在解析上下文时会同时使用 CLI 参数与 Electron 提供的 `workingDirectory` 兜底，降低仅聚焦不触发新终端的情况。

## 9. 钥匙链凭据运行时说明（2026-03）

- SSH 连接阶段的认证材料统一从 `SshServer.keychainId` 解析。
- 当前钥匙链认证类型仍为 `password`、`key`、`both`，运行时行为与旧版保持一致，并为后续扩展认证方式预留入口。
- 无服务器引用的隐藏钥匙链会在后端清理流程中被回收，避免长期堆积孤儿密钥记录。
- 在下一次创建本地终端会话（`POST /api/v1/local-terminals/sessions`）时，Main 会透传一次 `cwd`。
- Backend 会校验 `cwd`，若路径不可用则回退到 `os.homedir()`。

## 9. macOS CLI 启动与本地终端工作目录

- 在 macOS 打包版本中，Main 会准备用户级启动脚本：`~/Library/Application Support/Cosmosh/bin/cosmosh`。
- 该脚本以 `--working-directory "$PWD"` 启动应用，因此会继承当前终端目录作为启动上下文。
- Main 会尝试在常见 PATH 目录（`/opt/homebrew/bin`、`/usr/local/bin`）创建到该脚本的符号链接；若无权限不会导致应用启动失败。
- 若因权限限制无法创建符号链接，应用会继续启动并在日志给出提示，用户可手动将脚本目录加入 PATH 或自行创建符号链接。
- 启动后上下文处理链路与 Windows 一致：Main 解析待消费 cwd，并在下一次本地终端会话创建时透传。
