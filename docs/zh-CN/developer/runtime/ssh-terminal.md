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
  - `enableSshCompression`：从 SSH 服务器配置透传的会话级 SSH 传输压缩策略。
- 步骤：
  1. 读取 server 记录与其关联 keychain 的加密凭据。
  2. 解析可信主机指纹。
  3. 认证主 SSH transport，使用相同连接策略的临时 transport 完成可选的 shell 打开前远端增强工作，再携带 UTF-8 locale 请求通过 `ssh2.Client.shell` 打开主 shell。
  4. 写入 `SshLoginAudit` 记录：
     - 会话创建成功时写入 `result = success`，并记录 `sessionId` 与 `sessionStartedAt`。
     - 主机信任/认证/连接失败时写入 `result = failed`，并记录 `failureReason`。
  5. 在内存中注册会话状态（`Map<sessionId, SshLiveSession>`）。
  6. 返回短期 attach token 与 WS 端点。

Locale 行为：

- SSH shell 创建时会通过 `ssh2` shell 环境选项请求 `LANG=C.UTF-8` 与 `LC_CTYPE=C.UTF-8`，让支持 UTF-8 的终端程序默认继承 Unicode 字符类型 locale。
- 不设置 `LC_ALL`，以保留远端用户对时间、排序、数字格式等 locale 类别的偏好。
- Cosmosh 不会向交互式 shell 输入流注入 locale 命令。如果 SSH 服务器的 `sshd_config` 未接受这些环境变量请求，服务器可能会忽略它们。

### 附加 WebSocket

- 路径：`/ws/ssh/{sessionId}?token=...`
- 非法或编码畸形的路径、token、session 直接拒绝（`1008`），URL 解码错误不得逃逸出连接边界。
- 若已有附加 socket，将被替换（`1012`），保持单活连接。连接所有权切换后，旧 socket 的 close/error 事件不得清理新连接持有的会话。
- 会话 attach 前，可见输出与可信 helper 事件共用一个保持到达顺序的有界 stream-frame 队列（2,048 个 frame、1 MiB）。Attach 会先发送 `ready`、待发送 bootstrap 状态与当前增强运行时状态，再回放保留的 frame；超限时按到达顺序淘汰最旧的完整 frame，不会重新分组剩余输出与事件。

### 关闭会话

- API 驱动关闭：`DELETE /api/v1/ssh/sessions/{sessionId}`
- 传输驱动关闭：socket close/error、SSH stream close、SSH client error。
- 释放行为：在 session 标记为 disposed 前发送 terminal `exit` 事件，再清理运行时所有权、关闭 SSH stream/client 与 WS。
- 审计收尾：回写对应 `SshLoginAudit` 的 `sessionEndedAt` 与 `commandCount`。
- Main 在判断窗口关闭或应用退出时，会把 SSH 会话注册表中所有尚未 disposed 的条目视为活动连接。用户确认 renderer 警告对话框后，`DELETE /api/v1/runtime/active-connections` 会在窗口销毁前通过同一服务释放路径关闭全部 SSH 会话。
- “通用 > 行为”中的“关闭窗口时询问”默认开启。关闭后，Main 会跳过 renderer 对话框，但仍会先调用批量关闭端点再继续关闭；设置读取失败时保留警告。
- 本地终端会话以及仅由端口转发规则持有的 SSH 传输不计入本次关闭警告。

## 2.1 连接审计与最近使用排序

- 服务列表中的 `lastLoginAudit` 映射为最近一次**成功连接**（`result = success`）。
- 这样“按上次使用排序”将基于真实成功连接，而不是失败尝试。
- 失败连接仍会写入 `SshLoginAudit`，用于后续日志查询/审计能力。

## 2.2 本地优先安全审计接入

- SSH 运行时在保留 `SshLoginAudit` 兼容能力的同时，新增写入本地优先 `AuditEvent`，覆盖安全核心操作。
- 当前与 SSH 相关的审计分类包括：
  - `ssh-session`：连接成功/失败与会话关闭生命周期事件。
  - `ssh-host-trust`：主机指纹信任确认事件。
  - `ssh-server` / `ssh-keychain`：路由层的服务器/钥匙链实体变更事件。
- 关联策略：
  - `requestId` 用于串联同一请求链路。
  - `sessionId` 用于串联同一运行时会话。
  - `relatedRecordId` 用于关联兼容记录（例如可关联已有登录审计记录 ID）。
- metadata 在落库前会脱敏，敏感键按策略替换，占位后再执行大小上限控制。
- 审计写入采用 best-effort，不会因为日志写入失败而中断 SSH 会话创建或关闭流程。

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
- `bootstrap-status`：backend 侧通道安装器返回的远端 bootstrap 探测、下载、安装与失败状态。
- `remote-enhancement-runtime-status`：backend 持有的 `pending`、`active` 或 `disabled` 信任状态，以及已校验 helper 契约。
- `remote-shell-event`：仅通过 active 运行时 gate 转发的 helper shell 状态。
- `pong`：ping 响应。
- `error`：协议/运行时错误。
- `exit`：会话关闭与原因。

### 3.1 History 同步模型

- 后端命令历史来源于远端 history 探测与 shell 历史解析结果。
- 每次 SSH 会话建立后，后端都会执行远端 history 探测并解析为标准化命令列表。
- 远端历史来源按兼容顺序探测（shell 内建 + 常见历史文件），覆盖 Bash/Zsh/Fish/Ksh/Ash 等格式，并在可用时兼容 PowerShell PSReadLine 历史。
- 运行时 REPL 专用历史（例如 `.node_repl_history`）会被排除，不作为 shell 命令历史聚合来源。
- 当已激活的可信 helper 声明 `command-start` 时，backend 将每个唯一 `commandId` 作为命令计数与延迟 history 刷新的权威触发源。重复生命周期事件不会重复计数。
- 只有 session 不具备已激活的结构化命令生命周期时，原始 `input` 中的提交字符（`\r` / `\n`）才触发既有的“延迟 + 节流”history 刷新，为禁用或降级 helper 保留保守 fallback。
- history 与 telemetry 解耦：telemetry 仍为定时采样，history 可通过 `history` 事件即时推送。
- `SSH.tsx` 的删除操作会发送 `history-delete`，后端会以 best-effort 方式清理远端历史文件后再执行同步。

### 3.2 自动补全模型

- 渲染层会先在本地输入阶段记录 typing 补全请求，待对应 xterm 输出回显到达后（再经短延迟去抖）才发送 `completion-request`，从而保证弹层锚点始终基于已渲染光标几何。用户手动按下 `Tab` 仍会立即触发一次请求。
- 当 xterm 处于 alternate screen buffer（例如 `vim`、`less`、`top`）时，渲染层会门控关闭补全，避免 shell 补全劫持编辑器/TUI 的按键处理。
- 渲染层默认会抑制“空输入”补全（没有实际命令文本时不请求候选）；仅在明确的密钥提示流程中允许空前缀请求。
- 渲染层会基于 xterm 输入事件维护“按 pane 隔离”的本地命令前缀影子状态，使输入触发补全无需等待远端 shell 回显即可计算请求前缀。
- 补全请求、输出 echo 唤醒、密码提示触发、响应与浮层锚点都携带明确 pane id。来自非活动 pane 或旧 request id 的响应会被丢弃。
- 当可信 `line-state` metadata 可用时，renderer 使用 `lineLength`、`cursorIndex` 与 `promptGeneration` 校准重建出的前缀。只有重建长度与 prompt generation 一致时才采用可信 cursor，否则保留保守的 xterm/本地 shadow 结果。Helper 永远不发送 line buffer 本身。
- 当用户通过 readline/history 控制序列（例如 `ArrowUp`/`ArrowDown`/`Ctrl+P` 召回历史命令）导航后，渲染层会把下一段本地输入 shadow 视为增量后缀，并在发送补全请求前与 xterm 已渲染的命令行合并。这样继续输入时，`echo 1` 这类已召回命令仍会保留在补全前缀中。
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
  - `packages/backend/src/terminal/completion/generated-inshellisense.ts` 会以紧凑 tuple 载荷保留命令结构，并在模块加载时还原；生成条目仅保留 `descriptionI18nKey` 引用（不再冗余内嵌原始英文说明文本）。
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
  - SSH 的 home 相对输入（`~` / `~/...`）会基于探测到的远端 `$HOME` 展开后扫描目录，同时在返回候选中保留用户输入的 `~/` 前缀，
  - SSH 会话会在后台初始化补全 cwd/home，并让路径请求共享这次进行中的探测；在 cwd 尚未知时提交的 `cd` 命令会在首次 cwd 探测完成后重放，避免会话初期的相对路径补全错误回退到登录目录，
  - 输入触发（typing）的请求会对路径 provider 使用短超时预算，避免慢文件系统探测阻塞命令/历史/规范候选；手动 `Tab` 触发仍使用完整 provider 结果，
  - SSH 路径补全的 typing 预算会大于本地终端，因为远端 exec 延迟受网络影响；这避免香港/海外等高延迟服务器仅因首次目录扫描超过本地文件系统预算就返回空的运行时路径候选，
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

### 3.3 Terminal Presentation Integration

- Cosmosh 被动观察本地 PTY、SSH 会话、Alternate Screen TUI 与 Agent CLI 输出的标准终端控制序列。Renderer 不注入 bootstrap 字节，也不在 WebSocket/transport 代码中解析 OSC。
- 每个输出 chunk 都保持原样写入所属 pane 的 xterm 实例，因此跨 chunk 重组与 terminator 处理完全由 xterm streaming parser 负责。
- `terminal.onTitleChange(...)` 接收完整的 OSC 0/2 应用标题事件。标题只保存在 pane 内存中，不写日志、不持久化；进入展示状态前会移除终端/方向控制字符、合并空白，并限制为 256 个 Unicode code point。
- `terminal.parser.registerOscHandler(9, ...)` 只处理 `4;<state>;<progress>` 命名空间。状态映射为 `none`、`normal`、`error`、`indeterminate` 与 `warning`；非法 OSC 9;4 payload 会被消费但不改变状态，无关 OSC 9 payload 仍可交给其他 handler。
- `terminal.onBell(...)` 是 Bell attention 的唯一来源。用于终止 OSC 0/2 或 OSC 9;4 的 BEL 会被 xterm 作为 terminator 消费，不会产生独立 Bell 事件。OSC 9;4 state `0` 只清除进度，绝不会合成 Bell attention。
- 展示状态按 pane 独立归属。连接重试只清理该 pane 的旧标题/进度/Bell 状态，terminal dispose 会注销所有 parser listener，pane 删除会移除对应状态。
- Tab 聚合器跟随 active pane 的应用标题，并优先展示该 pane 的进度状态。active pane 没有进度时，后台 `error` 与 `warning` 状态可以保留 Tab attention；普通后台进度不会接管 active pane 的状态槽。Bell attention 独立汇总所有存活 pane。
- 终端 Tab 会保留独立标题来源，并按 `manualTitle > activePane.applicationTitle > connectionTitle > defaultTitle` 解析。应用标题始终只是内存中的派生投影，不会回写已存储的 Tab/session state、命令日志或设置。
- 聚焦某个 pane 只确认该 pane 的 Bell attention。若独立 Bell 到达时对应 active pane 已经聚焦，则立即确认；切换 Tab 后程序化聚焦 active terminal 也走同一确认路径。
- Window 聚合器按 `error > warning > indeterminate > normal > none` 严重度检查所有存活终端 Tab。同级候选优先 active Tab，否则使用稳定 Tab 顺序。Main 将 warning 映射为 Electron paused taskbar 模式，并在聚合结果为 `none` 时通过 `setProgressBar(-1)` 清除 taskbar 进度。
- 最近 Bell 事件独立于当前 Bell attention 保留 `{ tabId, paneId, sequence, receivedAt }`。Main 会先消费达到或超过接收时间高水位的每个新事件，再应用用户策略，因此被关闭或被节流的事件不会在切换设置后重放。Audible Bell 与未聚焦窗口 Flash 分别使用独立的一秒节流窗口；窗口聚焦会停止当前 Flash。进度状态 `none` 永远不会进入这条 Bell 路径。
- `App` 是 renderer 中 Window Activity Aggregation 与 preload 调用的唯一所有者。Pane 和 Tab 领域绝不直接调用 Electron；preload 只暴露固定的 activity bridge 方法，Main 校验共享的 `TerminalWindowActivity` 运行时契约，并根据发送 `webContents` 推导目标窗口。
- `terminalApplicationTitleEnabled` 只在 Tab 投影边界过滤应用标题。`terminalTabProgressEnabled` 会过滤 Tab 进度并强制窗口聚合结果为 `none`，从而清除 Electron taskbar 进度。这两个设置都不会注销 xterm parser，也不会修改 pane 原始状态。
- `terminalBellAttentionMode` 将 `audible` 映射为操作系统声音、`visual` 映射为 Tab 内 Bell attention、`taskbar` 映射为未聚焦窗口 Flash、`all` 映射为全部三项效果，`none` 则不产生 attention 效果。在所有模式下，最近 Bell edge 都会继续用于 Main 的防重放保护。
- 本模块明确排除 OSC 7、OSC 133、Shell Bootstrap 与 OSC 777 远端增强；这些协议继续由其现有 owner 和生命周期门控负责。

```mermaid
flowchart LR
  PTY[本地 PTY 或 SSH 输出] --> WS[既有输出 transport]
  WS --> WRITE[所属 pane terminal.write]
  WRITE --> XP[xterm streaming parser]
  XP --> TITLE[OSC 0/2 title event]
  XP --> PROGRESS[OSC 9;4 progress handler]
  XP --> BELL[独立 BEL event]
  TITLE --> STATE[Pane TerminalPresentationState]
  PROGRESS --> STATE
  BELL --> STATE
  STATE --> TAB[Tab State Aggregator]
  TAB --> CHROME[派生 Tab 标题与固定状态槽]
  TAB --> WINDOW[Window Activity Aggregator]
  WINDOW --> PRELOAD[安全 preload IPC]
  PRELOAD --> MAIN[Electron Main controller]
  MAIN --> TASKBAR[Taskbar 进度]
  MAIN --> SOUND[Audible Bell]
  MAIN --> FLASH[未聚焦窗口 Bell Flash]
```

### 3.4 验收

自动化验收与 transport 无关，因为本地 PTY 和 SSH 输出最终都汇合到 pane 所属的同一个 `terminal.write(...)` 边界：

- `pnpm --filter @cosmosh/renderer test:ssh` 覆盖 OSC 跨 chunk 分片、非法 OSC 9;4 状态、OSC terminator BEL 与独立 BEL 的区分、pane/Tab 聚合、attention 确认、重连清理和设置投影。
- `pnpm --filter @cosmosh/main test:terminal-presentation` 覆盖窗口进度映射、发送方 payload 校验、Bell 防重放、声音/Flash 策略和分别节流。

发布前手动验收必须让两种已安装的 Agent CLI 都实际经过 Cosmosh：

1. 在 Cosmosh 本地终端中分别启动当前版本的 Claude Code 与 Kimi Code。确认其应用标题只替换 application-title 来源，进度切换始终位于固定状态槽/任务栏内，并且一个独立 Bell 按配置模式触发。
2. 在安装了对应 CLI 的主机上通过 Cosmosh SSH 终端重复验收。确认无需启用远端增强，也无需安装展示功能专属 bootstrap 内容，就能得到相同行为。
3. CLI 运行期间逐项切换“展示”设置。确认重新开启时恢复展示 parser 已接收的状态、旧 Bell 不会重放，并且关闭“标签页进度”会清除窗口任务栏进度。
4. 在存在活动展示状态时执行重连以及关闭 pane/Tab。确认旧标题、进度和 attention 被清理，已关闭来源无法覆盖剩余窗口聚合结果。

## 4. 主机校验与信任流程

- SSH 连接使用 `hostHash: 'sha256'` 与 `hostVerifier`。
- `strictHostKey=true`：主机指纹必须已被信任，未知指纹返回 `SSH_HOST_UNTRUSTED`。
- `strictHostKey=false`：本次会话允许未知主机指纹继续连接。
- 若指纹未知：
  - backend 返回 `SSH_HOST_UNTRUSTED` 载荷。
  - renderer 打开信任确认弹窗。
  - 用户确认后调用 trust endpoint。
  - renderer 重试 create-session。

## 4.1 SSH 传输压缩

- SSH server 记录持久化 `enableSshCompression`，默认值为 `false`。
- SSH 服务器编辑器会在“安全”分区中以服务器级开关暴露该能力。
- 关闭时，backend 会向 `ssh2` 传入 `algorithms.compress = ['none']`，明确保持默认“不启用传输压缩”策略。
- 启用时，backend 优先协商 `zlib@openssh.com`，其次是 `zlib`，最后以 `none` 作为兼容性回退。
- SSH terminal 会话创建可以携带显式 `enableSshCompression` 值，使 retry/split 流程绑定到已解析服务器快照。
- SFTP 会话与端口转发启动会在 backend 读取同一个持久化服务器标记，因此 shell、文件系统与转发传输保持一致。

## 5. 异常处理与重连

### 当前行为（已实现）

- attach 超时：30 秒。
- 任意 socket close/error 都会让 UI 进入失败状态。
- `SSH.tsx` 的 retry 按钮提供手动重试，并且只作用于活动 pane。其临时 target-readiness 状态变化不会销毁或重连同级 pane runtime。
- 重试严格绑定到当前 tab 最近一次成功解析的目标快照，不会重新读取全局“当前选择”。
- 若首次连接在快照落库前失败，手动重试会回退到该 tab 的最新 intent 重新解析。
- 每次连接都有 attempt identity（`attemptId`），并带有过期结果丢弃与可取消的连接前异步流程。
- 隐藏 tab 不会触发新的连接副作用，只有 active tab 允许发起连接。
- 启用 `sshReconnectOnFocus` 后，重新激活标签页会重连所有没有 connecting/open socket 的失败 pane。延迟创建标签页第一次激活时始终启动 primary pane，不受该偏好开关影响。
- 当前尚未实现自动指数退避重连。

### 推荐下一步（规划中）

- 仅针对临时性 WS 传输故障加入有界自动重连。
- 对主机校验失败/认证失败保持不可重试终态。

## 6. 当前代码中的性能策略

- Renderer 在初始化 SSH 终端时，将设置项 `sshMaxRows` 绑定到 xterm `scrollback`。
- Renderer 使用 `FitAddon` + resize observer 保持终端尺寸同步。
- 当设置项 `terminalHardwareAccelerationEnabled` 开启时（默认开启），Renderer 使用 `@xterm/addon-webgl` 为终端渲染启用硬件加速。
- 当设置项 `terminalInlineImagesEnabled` 开启时（默认关闭），Renderer 可以使用 `@xterm/addon-image` 提供实验性的终端内联图片能力。该插件会在新建的 SSH 与本地终端窗格中解析 SIXEL 与 iTerm inline image protocol 输出。
- 当设置项 `terminalWebLinksEnabled` 开启时（默认开启），Renderer 使用 `@xterm/addon-web-links` 识别终端输出中的 HTTP/HTTPS URL。
- Backend 对终端尺寸做归一化限制（`20-400 cols`、`10-200 rows`）。
- Backend 会在终端 JSON 解析或 transport 写入前拒绝任何超过 1 MiB 的单条客户端 WebSocket 消息，并以关闭码 `1009` 断开连接。
- 通过 pending output queue 避免 attach 前早期输出丢失。
- pending output 采用“条目数 + 字节数”双上限；超过上限时丢弃最旧输出并记录日志。
- 遥测采用 5 秒定时采样 + 轻量文本解析，降低帧级开销。
- 遥测、历史与补全使用的后台 SSH exec 探测限制为 15 秒和 1 MiB stdout；超时、输出过大、client 同步失败或 channel error 会按数据不可用收敛，不会让周期任务持续悬挂。
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
  - `terminalHardwareAccelerationEnabled` 控制 SSH 与本地终端会话（包括分屏窗格）是否加载可选 `WebglAddon`，默认开启。
  - `terminalInlineImagesEnabled` 控制 SSH 与本地终端会话（包括分屏窗格）是否加载可选 `ImageAddon`，默认关闭，并采用构造期生效策略：开关或参数变化会作用于新建终端实例。
  - `terminalInlineImageOptions` 是通过 Settings Editor 编辑的 JSON 设置项，并使用严格 JSON Schema。当前仅暴露 `enableSizeReports`、`pixelLimit`、`sixelSupport`、`sixelScrolling`、`sixelPaletteLimit`、`sixelSizeLimit`、`storageLimit`、`showPlaceholder`、`iipSupport`、`iipSizeLimit`；本轮不暴露 Kitty/TGP 选项。
  - 内联图片仅在开启后支持 SIXEL 与 iTerm inline image protocol 输出。远端输出可能分配解码后的图片缓冲，因此校验会限制像素数量、序列字节数、存储 MB，并将 `sixelPaletteLimit` 上限固定为 `4096`。
  - 内联图片插件与 WebGL 插件按共存生命周期加载：renderer 会先在 `terminal.open(...)` 前加载 `ImageAddon`，再在 open 后同步 `WebglAddon`，使 WebGL 绑定已挂载的 renderer。`ImageAddon` 初始化失败只记录 warning，不会关闭 WebGL，也不会阻断终端启动。
  - 内联图片渲染只会把图片 canvas 固定在 renderer canvas 上方，并强制该图片层使用同步透明 2D context。DOM 文本行、选区、装饰层和链接覆盖层仍由 xterm 自己管理图层关系，因此选中文本对比度会保持默认 renderer 行为；透明 context 可避免 WebGL 开启时完整的图片 canvas 层变成不透明黑色覆盖层。
  - 内联图片解码依赖 `@xterm/addon-image` 内部的 WebAssembly，因此 renderer CSP 允许 `script-src 'wasm-unsafe-eval'`，但仍不启用通用 JavaScript `unsafe-eval`。
  - `ignoreBracketedPasteMode` 由设置项 `terminalBracketedPasteEnabled` 推导（开启时为 `false`，关闭时为 `true`）。
  - 粘贴安全警告是在 `SSH.tsx` 页面层执行的防护，会在输入进入 `terminal.paste(...)` 或原始 websocket `input` 前拦截。默认值为：`terminalWarnOnMultiLinePaste=true`、`terminalWarnOnLargePaste=true`、`terminalLargePasteWarningThreshold=5120`、`terminalWarnOnControlCharactersPaste=true`。
  - 控制字符粘贴检测会检查混入的 ESC、BEL、ANSI 控制序列，以及除 Tab/换行形式以外的 C0/C1 控制字节。警告确认仅作用于单次粘贴；允许一次粘贴不会关闭后续警告。
  - 字符宽度兼容模式由设置项 `terminalCharacterWidthCompatibilityModeEnabled` 推导；开启时，renderer 会加载 `@xterm/addon-unicode11`，并让新建终端实例切换到 Unicode 11 字符宽度表。
  - Unicode 宽度切换依赖 xterm 的 proposed `unicode` namespace，因此 renderer 创建的 SSH/本地终端实例会在加载 `@xterm/addon-unicode11` 前设置 `allowProposedApi: true`。
  - 开启后，右键粘贴、拖拽文本插入、选区工具栏插入会统一走 xterm `terminal.paste(...)`，从而让 shell 侧 bracketed paste 机制避免多行内容被立即执行。
  - `terminalCopyOnSelectionEnabled` 默认关闭。开启后，xterm selection-change 事件会通过 `navigator.clipboard` 将非空终端选区写入系统剪贴板；纯空白选区会被忽略。
  - `terminalRightClickSelectsWord` 直接映射到 xterm `rightClickSelectsWord`，默认关闭。
  - `terminalForceSelectionModifier` 默认值为 `off`。`alt` 会映射为 xterm `macOptionClickForcesSelection=true`，并在该终端实例中关闭 `macOptionIsMeta`，避免 macOS Option 键冲突。`shift` 与 `ctrl` 会作为设置值持久化，供后续平台特定选择处理使用；当前 xterm 原生生效路径仅为 macOS Option-click。
  - `@xterm/addon-clipboard` 会以 Cosmosh 自有 provider 加载，用于处理终端剪贴板读取/写入（OSC 52）。
  - 远程 SSH 会话从服务器记录字段 `terminalClipboardAccess` 读取剪贴板策略；本地终端会话从设置项 `localTerminalClipboardAccess` 读取策略。
  - 两种策略默认均为 `off`。支持模式包括 `off`、`writeAskRead`、`readWrite` 和 `askAlways`。
  - 读写剪贴板时始终通过 toast 提示；若该次操作刚刚通过显式权限对话框允许，则不再额外发送 toast。该允许只作用于单次剪贴板请求。
  - `@xterm/addon-clipboard` 负责协议 base64 编解码；provider 只在调用 `navigator.clipboard` 前后接收和返回已解码文本。
  - 每个 SSH/本地 xterm 实例（包括分屏窗格）都会加载 `@xterm/addon-serialize`，让 renderer 操作可以序列化当前选区，而无需触碰 xterm 内部结构。
  - 终端右键菜单仅在当前激活窗格存在选区时启用`复制为 HTML`。该动作只用 `serializeAsHTML({ onlySelection: true, includeGlobalBackground: true })` 序列化选中范围，并写入一个同时包含 `text/html` 与 `text/plain` 的 Clipboard API item；它不会向后端会话发送数据，也不会持久化剪贴板历史。
  - `terminalWebLinksEnabled` 控制 SSH 与本地终端会话（包括分屏窗格）是否加载 `@xterm/addon-web-links`。该设置默认开启，仅影响新建的 xterm 实例，识别到的 HTTP/HTTPS 链接会通过 Cosmosh 的 Electron 外部 URL 桥接打开。
  - `terminalWebLinksRequireModifierKey` 默认开启。开启时，Windows/Linux 链接需要 `Ctrl+单击`，macOS 链接需要 `Cmd+单击`，普通单击仅用于选择/聚焦终端文本，链接悬停时仅在按住所需修饰键时显示 pointer 光标。关闭时，主键单击可直接打开链接。辅助键/右键在任何情况下都不会打开终端链接，以便右键始终保留给终端上下文菜单；macOS 上的 `Ctrl+单击` 也保留为上下文菜单手势，永远不会打开终端链接。

说明：

- 对可选数值（如 `cursorWidth`）采用防御式解析；为空或不合法时回退到 xterm 默认行为。
- 原有 `sshMaxRows` 仍保持映射到 xterm `scrollback`。
- SSH server 记录可通过 `disableCharacterWidthCompatibilityMode` 单独禁用该模式；最终生效规则是全局设置开启且服务器未禁用。本地终端只使用全局设置。
- 字符宽度变更只影响新建的 xterm 实例；已存在的 SSH 窗格会保留当前 Unicode 宽度 provider，直到该窗格/会话被重新创建。
- WebGL 加载是尽力而为：初始化失败会回退到 xterm 默认渲染器，且不会中断终端会话。如果 WebGL 上下文丢失，renderer 会释放该 add-on，在当前 SSH 页面运行期停止重试 WebGL，并显示一次警告。

## 6.2 终端分屏交互模型

- 渲染层在 `SSH.tsx` 中提供受限分屏序列：
  1. 单终端，
  2. 左右双栏，
  3. 横向三栏，
  4. 最右侧终端再纵向拆分为上下两栏。
- 分屏入口在终端右键菜单（`拆分终端`），关闭入口同样在右键菜单（`关闭终端`）。
- 终端右键菜单会为`复制`、`粘贴`、`查找...`、`清屏`显示按平台解析的快捷键提示，并与实际键盘处理保持一致（macOS 显示：`⌘C`/`⌘V`/`⇧⌘F`/`⌃L`；非 macOS：`Ctrl+Shift+C`/`Ctrl+Shift+V`/`Ctrl+Shift+F`/`Ctrl+L`，且已绑定处理逻辑）。`复制为 HTML`特意只保留在菜单中，因为它依赖选中的富文本 xterm 范围，而不是终端标准快捷键。
- 终端右键行为由设置项 `terminalRightClickAction` 控制，默认值为 `contextMenu`。`paste` 会消费右键并通过同一套粘贴警告路径粘贴剪贴板文本。`copyOnSelectionElsePaste` 在当前激活窗格存在选区时复制选区，否则通过同一套粘贴警告路径执行粘贴。
- 当 SSH tab 变为 active 时，renderer 会把键盘焦点恢复到当前激活的 xterm 实例，让切换 tab 后的输入直接落到终端里。
- 当前实现最多同时展示 4 个终端窗格。
- 每个分屏窗格会针对同一已解析目标（同一 SSH 服务器/本地 profile）独立创建后端终端会话，从而支持独立输入输出。
- Secondary pane 在重试场景下始终复用 primary pane 的目标快照语义，避免会话目标漂移。
- 新增分屏窗格从空白视口启动，仅接入并展示该窗格自己的会话流，避免来自其他窗格的陈旧缓冲内容串入。
- 每个 pane 独立持有 xterm、WebSocket、backend session、transport 状态、telemetry、补全状态、远端增强信任状态、cwd、line state、调试历史与命令 marker。Primary 与 secondary 消息经过同一条 pane-aware reducer。
- 关闭任意 pane 只释放该 pane 的 socket/backend session，并保持其余 pane id 与运行时不变。关闭原始 primary 不会通过重命名其它 pane 来转移归属。
- 补全弹层锚点必须始终基于当前激活窗格容器计算，主窗格容器 ref 在重渲染时不能覆盖镜像窗格的激活几何信息。
- 终端内文本搜索由主窗格与镜像窗格统一加载 xterm `SearchAddon` 实现。右键`查找...`会以纯查找模式打开共享 `SearchReplacePanel`，提供可配置筛选开关（`区分大小写` / `匹配正则表达式`）以及紧凑的上一个/下一个导航动作，在当前激活窗格中跳转并高亮匹配结果。
- 当搜索词清空或关闭搜索面板时，会主动清理搜索高亮装饰，避免陈旧搜索标记在退出搜索后持续占用额外内存。
- Orbit Bar 在搜索全流程中保持抑制（包括空搜索词状态和 ESC 关闭路径），避免搜索高亮期间重新弹出选区动作条。
- Orbit Bar 与依赖选区的终端右键菜单动作会优先通过 xterm `getSelectionPosition()` 解析选区几何，只有不可用时才回退到 DOM selection blocks。这保证 `WebglAddon` canvas 渲染下 Orbit Bar 定位与`联网搜索`启用状态仍然可用。
- Orbit Bar 与终端右键菜单可以将选中的远程目录交给 SFTP 打开。该动作仅在 SSH 服务器会话中，对显式 POSIX 风格路径（`/path`、`~/path`、`./path`、`../path` 或 `file:///path`）启用。点号相对路径只使用来源 pane 的可信 helper cwd；缺少可信绝对 cwd 时继续采用原有严格规则。裸相对路径仍保持禁用。
- 从选区在 SFTP 中打开目录时，即使同一服务器已经存在其他 SFTP 标签页，也始终会用该 `initialPath` 创建新的 SFTP 标签页，且不会替换当前 SSH 终端标签页。

## 6.3 命令时间线

- “命令时间线”位于“设置 > 终端 > 运行时”且默认开启。只有该设置已启用，并且当前 pane 中通过认证的远端增强运行时处于 active 状态并声明 `command-start` 时，符合条件的 SSH pane 才会在右侧使用 40 px 命令槽。该槽由左侧 34 px 最近命令轨道和右侧 xterm 6 px 滚动条组成，并紧贴 pane 右边缘，不保留根容器尾部内边距。Renderer 通过 xterm 内边距预留轨道，并把 xterm scrollable element 扩展到完整命令槽，使原生滚动条继续留在负责其悬浮显示、轨道点击和滑块拖动的节点内。关闭该设置只会移除命令时间线轨道与菜单，不会关闭其他远端增强能力。普通 SSH、本地终端、已禁用 helper、握手失败或未声明该 capability 的 helper 都不会获得 fallback 轨道；所有终端仍使用窄滚动条。
- 用户按 Enter 时先记录隐藏的 pane-local xterm 输入 marker。可信 `command-start` 会在此前终端输出完成解析后消费最早的待确认 marker，记录输出起始行，并从 xterm 行中仅重建已提交的命令。命令保留前会通过配置项或启发式 prompt 解析移除虚拟环境装饰以及用户、主机、工作目录等 prompt metadata。Helper 发出的已清洗可执行文件名只作为生命周期 metadata，绝不会替代界面中的完整输入。`command-end` 负责记录输出结束行。
- 只有 normal buffer 内容超过两个可见屏幕且保留的可信命令超过三条后，才启用最近命令入口。该阈值不会改变固定轨道的预留状态，因此入口满足条件时不会改变终端列数。在 normal buffer 中，终端内的鼠标移动会显示符合条件的入口，连续五秒无鼠标移动后隐藏。来自 xterm 内的键盘/IME 输入或粘贴会立即关闭各层菜单并隐藏入口。闲置状态会对可见与键盘用户隐藏线条，但仅保留其紧凑鼠标命中区域，使命中区域上的鼠标移动无需等待新的 `pointerenter` 即可恢复悬浮。命令列表或命令行操作菜单打开期间，入口保持可见，除非被 xterm 输入主动收起。运行 alternate-screen 程序时隐藏并禁用入口，但继续保留固定轨道。
- 居中的入口最多呈现最新八条统一线条，每条宽 12 px、高 2 px，间距 10 px，以约 60% 透明度使用 `color.text`。这些线共同构成一个菜单入口，不再编码输出量，也不提供逐线的上一条/下一条导航。
- 鼠标悬浮时，整组线条会 morph 为一个受视口边界约束、固定 256 px 宽的共享菜单卡片。靠近滚动条的一侧保持固定，卡片覆盖轨道并向左展开。正常挂载的 Portal 配合 CSS `@starting-style` 完成 180 ms transform/opacity 入场，只有鼠标离开的退场会保留 Portal 以执行 140 ms 反向过渡。`relatedTarget` 判断与统一的 80 ms 离开宽限覆盖入口、命令卡片与 portaled 命令行操作菜单之间的跨越，快速重新进入会从当前过渡状态继续，而不是重新开始。命令行操作菜单会阻止仅由悬浮打开的父菜单恢复 xterm 焦点所导致的 focus-out 关闭，同时保留鼠标离开、外部交互、Escape 与选择动作的正常关闭路径。由于无需点击、悬浮即会打开卡片，紧凑命中区域使用默认箭头光标。键盘打开保持即时，`prefers-reduced-motion` 仅保留短暂透明度过渡。
- 卡片展示来源 pane 中仍有效的全部 marker，并按从旧到新的顺序排列。菜单打开或内容更新时自动滚动到底部。选择命令行会对其输入 marker 调用 `scrollToLine` 并恢复 xterm 焦点；右键菜单可复制内存中的命令，或将命令插入同一 pane 且不附加 Enter。鼠标离开或按 Escape 会关闭各层菜单。
- 完整命令字符串只保存在 renderer 内存中，绝不持久化、记录日志、发送、加入 telemetry，也不复制到远端增强调试记录。信任丢失、重连/重置、pane 释放或 xterm scrollback 回收都会同时释放 marker 与命令文本，因此条目只属于当前 pane、当前连接与 normal buffer 仍保留的 scrollback。
- Primary 与 secondary runtime 都会在 write 解析完成、滚动、调整尺寸、buffer 切换和 marker 释放后刷新模型。由于后代 xterm 的内边距变化本身不会调整稳定 host 的尺寸，轨道预留状态变化会显式进入现有 pane fit/resize 流程。Xterm host 与固定轨道在信任、活动、菜单和 alternate-screen 状态变化期间保持稳定 DOM 祖先，确保 TUI 进出与闲置显隐既不会重建运行时，也不会让 PTY 列数失步。

## 7. 开发排查清单

当 SSH 会话行为异常时，按以下顺序检查：

1. 会话创建 API 的入参与校验路径。
2. 主机校验分支（`SSH_HOST_UNTRUSTED` 与直接建连分支）。
3. WS attach token 与 sessionId 是否匹配。
4. 数据流方向是否完整（`input` 写入与 `output` 回放）。
5. 会话释放路径是否正确（API close、传输关闭或 SSH 错误触发）。

## 8. 远端增强运行时

远端增强是用于主机感知 SSH 能力的可选运行时层，例如 OS/发行版检测、未来 SFTP helper、命令快捷嗅探与补全支持。当前阶段会维护版本化 helper 契约，并提供有界的 cwd/命令生命周期事件；后续能力必须继续挂在相同 gate 之后，并复用同一用户级远端 helper 边界。

### 8.1 归属与开关

- `packages/backend/src/remote-bootstrap/service.ts` 负责交互 shell 打开前的编排。它会获取 manifest、探测远端主机、读取已安装状态，仅在需要时注入下载 wrapper，复验安装结果，返回可信运行时契约，解析 JSON-line 状态并写入审计事件。
- `packages/remote-bootstrap` 负责 Go 安装器、helper 生成器、OSC 协议/能力声明、已安装状态校验器与 wrapper 渲染器。模块级构建、测试、路径和安全说明见 `packages/remote-bootstrap/README.md`。
- 最终门控为`全局设置 && 持久化服务器字段 && 请求 override !== false`。请求字段只能进一步关闭：过期的 renderer 快照不能重新启用当前数据库记录已关闭的服务器。全局设置与持久化服务器字段默认均为 true，因此在用户未关闭任一门控前，部署级启用条件由 manifest URL 控制。
- 任一开关关闭时，backend 不会执行任何远端命令，会忽略此前已安装 helper 发出的运行期 shell OSC 事件，并会发送 code 为 `REMOTE_ENHANCEMENTS_DISABLED` 的 skipped `bootstrap-status`。
- Backend 需要 manifest URL 才会加载 bootstrap manifest。`COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL` 是最高优先级 override。未打包的开发运行会默认使用滚动的 `remote-bootstrap-dev` manifest，因此本地开发无需每次设置 shell 环境变量也能测试远端增强。CI 打包也可以在 app 打包前生成 `remote-bootstrap/manifest-url.json`，让安装包无需用户手动配置环境变量即可发现 GitHub 托管的 manifest。正式 tag release 指向同版本 GitHub Release；`main` push 构建指向 `remote-bootstrap-dev`；分支名包含 `remote-bootstrap` 的 push 构建和手动 workflow dispatch 可以指向分支专用临时 prerelease，例如 `remote-bootstrap-branch-codex-remote-bootstrap-ci-release`。普通 PR 与 feature branch 构建默认不写入 packaged URL。远端增强启用但缺少配置时，不会执行远端 probe 或任何其它远端命令，只会明确上报 `MANIFEST_URL_NOT_CONFIGURED`。

开发环境默认 manifest URL 为 `https://github.com/agoudbg/Cosmosh/releases/download/remote-bootstrap-dev/cosmosh-remote-bootstrap-manifest.json`。只有需要覆盖默认值时才需要在启动 Cosmosh 的同一个终端里设置 `COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL`，例如测试分支专用临时 prerelease：

先启动 `pnpm dev:renderer` 并等待 `http://127.0.0.1:2767` 就绪，再在第二个终端启动 `pnpm dev:main`。远端增强必须在 Electron 窗口中测试：直接打开 Vite URL 不具备 preload bridge，也不会启动由 Main 管理的 backend 子进程，因此仅在浏览器中运行 renderer 无法完成 bootstrap 或创建 SSH 会话。

```powershell
$env:COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL="<manifest-url>"
pnpm dev:main
```

```sh
COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL="<manifest-url>" pnpm dev:main
```

### 8.2 会话流程

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

- 主 SSH transport 会先完成认证，但在 bootstrap 结束前不创建任何 channel。第一次真正需要远端命令时，backend 才会使用相同凭据、host-key 策略、压缩设置与代理策略懒创建第二条已认证 transport。每条使用代理的 transport 都会获得独立 socket。
- 所有 bootstrap probe/install/status `exec` channel 都只运行在临时 transport。Backend 会在主 client 调用 `client.shell(...)` 前启动其关闭流程，底层 socket 的实际关闭可以异步完成。因此交互 PTY 是主 transport 的第一个 session channel，既能保留 OpenSSH/PAM 登录消息（例如 Debian MOTD），也能让新安装的 profile hook 在同一个首次 shell 中生效。
- 开关关闭或 manifest 缺失/无效时不会创建临时 transport。其解密得到的 completion secret 会被丢弃，永远不会复制到 session state、状态 payload 或审计 metadata。
- Backend 会在下载前查询已安装 binary。只有 manifest version 与 asset SHA-256、受支持 protocol、helper 内容与 profile hook 均为最新时才跳过下载；旧 binary 缺失新字段时会被视为不兼容并重装。PTY 创建前会再次读取 status 复验安装。
- 校验成功的 manifest 会缓存五分钟，并由并发 session 共享同一个 in-flight 加载。失败结果不会缓存。取消单个 session 只会停止该 session 的等待，不会取消其它 session 正在等待的共享 manifest 请求。
- 每条侧通道命令都使用 `ssh2 exec`，并受 `REMOTE_BOOTSTRAP_EXEC_OPTIONS` 限制：60 秒、256 KiB 输出；整个可选的 shell 打开前 ensure 对设置读取、manifest I/O、临时 proxy/SSH 建连与 exec 工作共享更严格的 15 秒总预算。共享 deadline 到期时，backend 会停止等待 proxy 准备、关闭活动 exec channel、销毁临时 client、发送 `BOOTSTRAP_ENSURE_TIMEOUT`，并立即继续创建普通 PTY。取消后才完成的预连接 proxy socket 会在返回时立即销毁。安装器输出按 JSON lines 解析，永远不会写入交互式终端流。
- Ensure 建连失败或超时不会把有效的主 SSH 认证变成 shell 创建失败。Backend 会启动临时 transport 的关闭，以 `disabled` 运行状态打开主 PTY、报告失败，并在该 session 内忽略所有 helper 派生事件。如果主 transport 本身在 ensure 期间失败，其错误会取消临时工作，并继续通过现有 SSH 错误路径让普通 session 创建失败。
- Go `install`/`status` 输出只用于建立安装标识与信任状态，不会直接提供 cwd、输入状态或命令生命周期数据。实时 shell 数据随后由 Go 生成的 helper 通过 OSC 777 发出，并继续受运行时 gate 约束。
- Renderer 会为每个 pane 分别保存 bootstrap 状态、运行时信任状态、可信 cwd/line state、telemetry、生命周期状态与最多 200 条远端增强调试记录。启用 Settings `remoteEnhancementsDebugEnabled` 后，终端右键菜单会显示来源 pane 的`远端增强调试`；浮层跟随活动 pane，绝不会用 primary pane 数据代替。
- Renderer 只会在可信 `command-start` 到达后，从自身已渲染的 xterm 行重建仅含命令的时间线标签；helper 事件 payload 仍然只携带已清洗的可执行文件名。Prompt 身份 metadata 会在保留前丢弃，时间线标签不会进入调试历史或传输协议。
- 调试浮层只记录状态/事件 payload，不记录 terminal `input`、terminal `output`、密码、私钥材料或完整屏幕输出。
- Terminal `ready`、`output`、telemetry、history、completion 与 shell-state 消息都与 bootstrap 进度彼此独立。

### 8.2.1 远端 Shell 事件协议

Remote Bootstrap 安装 helper 后，交互式 shell 启动文件会 source 用户级 shell integration。helper 会通过交互 PTY 上的 OSC 777 控制序列发送运行期 shell 状态：

```text
ESC ] 777 ; cosmosh ; <base64-json> BEL
```

Backend 解析规则：

- `SshSessionService` 会先把 SSH 输出流经过 `RemoteShellEventOscParser`，再写入 xterm。
- Parser 会返回按原始顺序排列的可见输出/helper 事件 frame，`SshSessionService` 不得再按类型对它们分组。事件之前的可见字节，尤其是 `command-start` 之前的输入回显与换行，必须先进入 xterm，renderer marker 才能捕获有效的输入/输出边界。
- WebSocket 未 attach 时同样遵循该顺序契约：可见输出与已接受的 helper 事件进入同一个有界 pending-frame 队列，并在 attach 控制消息之后按到达顺序回放。若运行时信任在 attach 前被禁用，只移除队列中的 helper 事件，普通终端输出仍可回放。
- Cosmosh OSC 会从可见终端输出中剥离并解码，但只有 backend 运行时 gate 进入 `active` 后，事件才会应用并转发。
- Gate 只有在交互 shell 打开前 status 校验成功后才以 `pending` 开始；匹配的 `integration-ready` 会将其切换为 `active`。如果 10 秒内没有收到有效握手，则以 `HELPER_HANDSHAKE_TIMEOUT` 切换为 `disabled`；任何 shell、helper version、protocol version 或 capability 不匹配也会切换为 `disabled` 并清空 helper 派生状态。
- 非 Cosmosh OSC 与普通 ANSI 输出会保持可见、原样流式透传，包括跨 SSH chunk 拆分的序列。
- 非法 JSON、非法事件形状以及超过 8 KiB 的 payload 会被丢弃，不会导致 session 崩溃。
- 支持 SSH chunk 切分；未完成的 OSC 数据会缓冲到 BEL 或 ST 结束符到来。
- 协议常量及 Backend/Renderer 使用的 discriminated message union 统一来自 `packages/api-contract/src/terminal-protocol.ts`。当前 helper 协议版本为 v2。

服务端到 renderer payload：

```ts
type RemoteShellEventMessage = {
  type: 'remote-shell-event';
  event:
    | 'integration-ready'
    | 'prompt-ready'
    | 'cwd'
    | 'command-start'
    | 'command-end'
    | 'foreground-command'
    | 'line-state';
  shell: 'bash' | 'zsh' | 'fish' | 'sh' | 'ash';
  helperVersion: string;
  protocolVersion: number;
  capabilities: string[];
  cwd?: string;
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

共享 TypeScript 类型实际是 discriminated union，而不是上面的可选字段简图。`cwd` 必须包含解码后的绝对 cwd；命令事件必须包含有界、已清洗的可执行命令名与 `commandId`；`command-end` 还必须包含 `exitCode` 和 `durationMs`；`line-state` 必须包含 `lineLength`、`cursorIndex` 与 `promptGeneration`。事件名不在精确 capability 集合中时会被拒绝。动态 cwd/command 字符串在 helper JSON envelope 内使用规范 Base64 字段，避免 tab、换行、引号或反斜杠破坏 JSON。

当前第一期 helper 行为：

- Bash 使用 `PROMPT_COMMAND` 保留已有 prompt hook，随后发送 `cwd`、`prompt-ready`，以及带匹配 command id、exit code 和 duration 的 `command-end`。受保护的 `DEBUG` trap 会在 prompt 设置完成后，为每条已提交命令行发送一次 `command-start` 与一次 `foreground-command`。
- Zsh 使用 `precmd`、`preexec` 与 `chpwd` hook，并通过 `line-pre-redraw` 提供 line length/cursor 校准。只有所有必需 hook 都注册成功后 helper 才进入 ready；若出现部分注册失败，会在保持集成禁用前同时移除已成功注册的 `line-pre-redraw` widget 与 prompt hook。
- Fish 使用 `fish_preexec`、`fish_prompt`、`fish_postexec` 与 `PWD` variable event。
- Sh/Ash 安装 prompt-capture fallback，并且只声明 `cwd` 与 `prompt-ready`；不声明命令生命周期支持。
- 所有 shell 都只在其声明的 hook 集合成功安装后发送 `integration-ready`。非交互 shell 不发送 OSC 事件。
- 对所有可提取出可执行命令名的已提交命令，helper 都会发送 `command-start` 与 `foreground-command`；事件只携带经过清洗的可执行命令名（例如 `vim`），不携带完整命令行或参数。
- Helper 刻意不发送完整命令文本、line-buffer 内容、密码输入或原生 shell completion 列表。Zsh `line-state` 只包含数值长度/cursor metadata。

Backend 状态模型：

- 每个 session 都持有明确的 `pending`、`active` 或 `disabled` 增强运行状态、PTY 创建前校验得到的契约，以及会在激活、禁用或 session 销毁时清理的握手 timer。
- 每个 `SshLiveSession` 保存可信 cwd/foreground 状态，以及最近的 command id、清洗后可执行命令名、exit code 与 duration。唯一的结构化 `command-start` 驱动命令计数与 history 刷新；只有该 capability 不可用时才以原始 Enter 解析作为 fallback。
- `remoteShellCwd` 是 path completion 的优先 cwd 来源；现有 exec probe 与 renderer hint 仍作为 fallback。
- 收到 `foreground-command` 并设置 `remoteShellForegroundCommand` 后，backend 会返回空 completion response，直到下一个 `prompt-ready`；`command-end` 不会提前清除抑制状态。这能覆盖短命令、长时间前台进程以及未知 TUI/REPL 程序，不需要维护命令白名单。
- Backend 信任状态离开 `active` 时，renderer 会立即清除可信 cwd/line 校准；使用 `line-state` 校准补全前还会校验 prompt generation。命令生命周期事件同时维护 pane-local xterm 导航 marker。
- 密码提示与可复用 secret suggestion 继续由本地 backend 基于输出检测；shell hook 永远不捕获密码输入。

### 8.3 Manifest 与资产契约

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

- `version` 只能包含字母、数字、`.`、`_`、`+` 或 `-`。
- `assets` 必须非空。
- 每个 manifest asset 都必须包含 HTTPS `url` 与 64 位小写 `sha256`；任一 asset 格式错误都会让整个 manifest 无效，确保被污染的发布元数据明确失败。
- 当前目标矩阵只为 Linux `amd64` 与 `arm64` 远端选择 asset。
- 注入的 wrapper 会把所有 manifest 字段作为已引用的数据处理，永远不把它们当作可执行 shell source，然后使用 `curl` 或 `wget` 下载 binary，通过 `sha256sum` 或 `shasum` 校验后执行 `cosmosh-bootstrap install`。
- `cosmosh-wrappergen` 会在渲染 shell source 之前独立校验 manifest `version` 字符集、asset URL 必须为 HTTPS，且 SHA-256 必须为小写 hex。
- `scripts/build-remote-bootstrap-release.mjs` 会编译 `cosmosh-remote-bootstrap-linux-amd64` 与 `cosmosh-remote-bootstrap-linux-arm64`，计算 SHA-256，并写入被 git ignore 的 `packages/remote-bootstrap/dist/cosmosh-remote-bootstrap-manifest.json`。CI 可以覆盖下载 tag/base URL 与 manifest `version`，因此即使用固定 GitHub release tag，也可以发布类似 `dev-<commit-sha>` 的 manifest version。
- 正式 tag release CI 会把 helper assets 与 manifest 和桌面端安装包一起暂存，校验完整资产清单、生成校验和与 provenance attestations，然后才把 bundle 上传到同 tag 的 draft GitHub Release，并把该 tag 的 manifest URL 打进 app。`cosmosh-remote-bootstrap-*` 前缀是故意的，用来和 release 页面上的用户可见 app 安装包区分开。
- `build-main` CI 总是验证 Go package 与 manifest 生成路径。在 `push` 到 `main` 时，独立的写权限 job 会重新编译 helper assets，用 `--clobber` 发布到固定 prerelease tag `remote-bootstrap-dev`，并把 `https://github.com/<repo>/releases/download/remote-bootstrap-dev/cosmosh-remote-bootstrap-manifest.json` 打进 main 构建产物。在 `push` 到任意分支名包含 `remote-bootstrap` 的分支，或手动 `workflow_dispatch` 且 `publishRemoteBootstrap=true` 时，同一个 job 会发布到分支专用 prerelease tag `remote-bootstrap-branch-<sanitized-branch>`，并把这个 manifest URL 打进该分支构建产物。这些分支 prerelease 是临时内部测试桶，PR 合并或废弃后可以删除。普通分支和 PR 默认只验证构建链路，除非维护者显式选择发布路径。

### 8.4 远端要求与安装文件

支持的远端主机：

| 维度 | 支持值 |
| --- | --- |
| OS | `linux` |
| 架构 | `amd64`、`arm64` |
| Shell | `bash`、`zsh`、`fish`、`ash`、`sh` |

远端需要具备的常见工具：

- `mktemp`：创建临时 wrapper 与下载目录。
- `base64`：解码 backend 注入的 wrapper payload。
- `curl` 或 `wget`：下载 HTTPS asset。
- `sha256sum` 或 `shasum`：校验下载文件。
- probe 识别出的目标 shell。

安装文件只落在远端用户作用域：

| 用途 | 默认路径 |
| --- | --- |
| Bootstrap binary | `$XDG_DATA_HOME/cosmosh/bootstrap/bin/cosmosh-bootstrap` 或 `~/.local/share/cosmosh/bootstrap/bin/cosmosh-bootstrap` |
| Version marker | `$XDG_DATA_HOME/cosmosh/bootstrap/bin/.version` 或 `~/.local/share/cosmosh/bootstrap/bin/.version` |
| POSIX helper | `$XDG_CONFIG_HOME/cosmosh/bootstrap/helper.sh` 或 `~/.config/cosmosh/bootstrap/helper.sh` |
| Fish helper | `$XDG_CONFIG_HOME/cosmosh/bootstrap/helper.fish` 或 `~/.config/cosmosh/bootstrap/helper.fish` |
| Bash hooks | `~/.bashrc`，以及当前 login profile（优先 `~/.bash_profile`，其次 `~/.bash_login`，否则 `~/.profile`）内的 Cosmosh marker block |
| Zsh hook | `~/.zshrc` 内的 Cosmosh marker block |
| Sh/Ash hook | `~/.profile` 内的 Cosmosh marker block |
| Fish hook | `$XDG_CONFIG_HOME/fish/conf.d/cosmosh.fish` 或 `~/.config/fish/conf.d/cosmosh.fish` |

安装器具备幂等性。只有已安装 version、binary 精确内容、Go 生成的 helper 精确内容与所有必需 shell hook 均为最新时才会发送 `skipped`。Bash login-profile block 会检查 `BASH_VERSION`，因此由 Dash 读取的通用 `.profile` 不会加载 Bash helper。选择 login profile 时会检查 `.bash_profile` 与 `.bash_login` 目录项本身，因此 dotfile manager 创建的悬空符号链接仍是有效的 Bash 候选；安装器会创建其目标，而不会错误回退到 `.profile`。Binary/helper/version/profile 都采用原子替换；已有 profile 权限与符号链接目标会被保留。Version marker 只会在所有文件安装与 profile 更新成功后写入。`status` 同时报告兼容字段 `profilePath` 与完整 `profilePaths` 集合。

### 8.5 安全与失败模型

- Wrapper 文件与 bootstrap 工作目录通过 `mktemp` 在 `${TMPDIR:-/tmp}` 下创建，使用受限权限并在退出时清理。
- 远端 wrapper 使用 `umask 077`；安装器目录/binary 使用 `0700`，新 helper/profile 在适用处使用 `0600`。原子替换已有 profile 时保留原模式。
- 缺少 `mktemp`、`base64`、下载器、hash 工具或目标 shell 时，会明确上报 `bootstrap-status` 失败，而不是静默降级。
- Go 安装器只在远端用户的 XDG 路径下持久化文件，并且只在 shell profile 的 Cosmosh marker block 内更新内容。不要求 root，也不写全局路径。
- Bootstrap 审计 metadata 只记录状态，不得包含 secret。SSH 凭据、私钥与终端输入都不属于该契约。
- Bootstrap/设置/manifest/安装失败会对增强数据 fail closed，但对已认证的普通 SSH shell fail open。只有本次 ensure 成功且 live helper 握手与其契约匹配时，先前安装的 helper 才可能被消费。

常见状态码：

| Code | 含义 |
| --- | --- |
| `REMOTE_ENHANCEMENTS_DISABLED` | 全局 Settings 或服务器级开关在执行任何远端命令前禁用了 bootstrap；该 session 内的运行期 shell OSC 事件会被忽略。 |
| `MANIFEST_URL_NOT_CONFIGURED` | 远端增强已启用，但 backend 没有 manifest URL。 |
| `MANIFEST_FETCH_FAILED` | Backend 无法获取 manifest URL。 |
| `MANIFEST_INVALID` | Manifest 结构、asset URL 或 SHA-256 校验失败。 |
| `ASSET_NOT_FOUND` | Manifest 中没有匹配 probe 到的 OS/架构的 asset。 |
| `PROBE_FAILED` | 远端 OS、架构或 shell 不支持，或解析失败。 |
| `BASE64_NOT_FOUND` | 远端无法解码注入的 wrapper payload。 |
| `MKTEMP_NOT_FOUND` | 远端缺少 `mktemp`。 |
| `DOWNLOADER_NOT_FOUND` | 远端既没有 `curl` 也没有 `wget`。 |
| `HASH_TOOL_NOT_FOUND` | 远端既没有 `sha256sum` 也没有 `shasum`。 |
| `CHECKSUM_MISMATCH` | 下载得到的 binary 与 manifest SHA-256 不匹配。 |
| `BOOTSTRAP_ENSURE_TIMEOUT` | 完整的可选 shell 打开前 ensure 超过 15 秒；活动侧通道工作会被取消，并继续创建普通 PTY。 |
| `INSTALLATION_NOT_CURRENT` | 安装后 status 与所选 version 或受支持运行时契约不匹配。 |
| `HELPER_HANDSHAKE_TIMEOUT` | PTY 创建后 10 秒内未收到有效 `integration-ready`；运行期 helper 数据已禁用。 |
| `HELPER_CONTRACT_MISMATCH` | Live `integration-ready` 或后续 helper 事件与交互 shell 打开前的契约不匹配；运行时数据已禁用。 |
| `FILE_INSTALL_FAILED` | 安装器无法创建或复制用户级文件。 |
| `PROFILE_UPDATE_FAILED` | 安装器无法更新目标 shell profile hook。 |
| `VERSION_WRITE_FAILED` | 安装器无法写入最终 version marker。 |

排查 bootstrap 行为时，先确认是哪一层 gate 停止了执行，再检查 manifest 有效性、远端 probe 支持、远端工具可用性，最后检查用户 profile 写入权限。缺少 manifest URL 时不应出现任何远端 probe 命令。

## 9. Windows 右键启动与本地终端工作目录

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

## 10. 钥匙链凭据运行时说明（2026-03）

- SSH 连接阶段的认证材料统一从 `SshServer.keychainId` 解析。
- 当前钥匙链认证类型仍为 `password`、`key`、`both`，运行时行为与旧版保持一致，并为后续扩展认证方式预留入口。
- 无服务器引用的隐藏钥匙链会在后端清理流程中被回收，避免长期堆积孤儿密钥记录。
- 在下一次创建本地终端会话（`POST /api/v1/local-terminals/sessions`）时，Main 会透传一次 `cwd`。
- Backend 会校验 `cwd`，若路径不可用则回退到 `os.homedir()`。

## 11. macOS CLI 启动与本地终端工作目录

- 在 macOS 打包版本中，Main 会准备用户级启动脚本：`~/Library/Application Support/Cosmosh/bin/cosmosh`。
- 该脚本以 `--working-directory "$PWD"` 启动应用，因此会继承当前终端目录作为启动上下文。
- Main 会尝试在常见 PATH 目录（`/opt/homebrew/bin`、`/usr/local/bin`）创建到该脚本的符号链接；若无权限不会导致应用启动失败。
- 若因权限限制无法创建符号链接，应用会继续启动并在日志给出提示，用户可手动将脚本目录加入 PATH 或自行创建符号链接。
- 启动后上下文处理链路与 Windows 一致：Main 解析待消费 cwd，并在下一次本地终端会话创建时透传。

## 12. 服务器代理解析

- 全局代理模式为 `off`、`system` 或 `custom`，默认是 `system`。
- 单服务器代理模式为 `default`、`off` 或 `custom`；`default` 继承全局设置。
- 自定义 URL 支持 `http://`、`https://` 与 `socks5://`，可包含 URL 凭据；路径、查询参数与片段会被拒绝。
- 系统模式下，renderer 通过 Electron `Session.resolveProxy` 请求 Main 解析 `https://{host}:{port}/`，并在创建会话时携带临时规则字符串。
- Backend 按顺序解析 `PROXY`、`HTTPS`、`SOCKS5` 与 `DIRECT` 候选，建立隧道后把 socket 注入 `ssh2`。
- 所有代理候选共享会话连接超时。除非系统规则显式包含后续 `DIRECT`，代理失败就是终止错误。
