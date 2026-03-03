# UI/UX 规范

## 1. 设计系统流水线

```mermaid
flowchart LR
  TOK[tokens.cjs] --> CSS[index.css CSS variables]
  TOK --> TW[tailwind.config.cjs variable mapping]
  TW --> UI[Radix wrapper components]
  UI --> PAGES[Feature pages]
```

规则：

- 主题值来源于 `packages/renderer/theme/tokens.cjs`。
- Tailwind color/radius/shadow 必须映射到 CSS Variables（功能代码中禁止硬编码临时色板）。
- UI 原子组件通过 `packages/renderer/src/components/ui/*` 封装后供页面消费。

## 2. 视觉一致性原则

- 所有视觉原语（颜色、圆角、阴影、模糊、间距）统一由 token 定义。
- 优先复用既有表面与控件样式，避免每个页面新增一次性样式。
- 焦点、悬停、激活、禁用状态需保持清晰可识别。

## 3. 字体规范

- 字体应保持紧凑、可读，并在各类控件和内容区间保持一致。
- 正文与控件字号基线应稳定，避免相邻组件出现突兀跳变。
- 标题、标签、辅助文案、状态信息需要明确层级。

## 4. 圆角逻辑

- 圆角语义在容器与交互控件之间应保持一致逻辑。
- 优先使用 token 级别的圆角预设，避免临时圆角值。
- 圆角选择需与组件用途匹配（容器、控件、浮层）。

## 5. Radix UI 封装原则

```mermaid
flowchart TD
  A[Radix Primitive] --> B[Cosmosh Wrapper in components/ui]
  B --> C[Tokenized Tailwind classes]
  C --> D[Feature usage in pages]
```

实现原则：

- Radix 原语仅通过内部封装使用（`dialog.tsx`、`menubar.tsx`、`toast.tsx` 等）。
- 样式契约集中在独立 style map（`menu-styles.ts`、`form-styles.ts`、`dialog-styles.ts`、`toast-styles.ts`）。
- 可访问性/状态选择器（`data-state`、碰撞处理、键盘语义）放在封装层内部。

## 6. 交互密度规则

- 布局应保持紧凑且可呼吸，优先保证信息扫描效率与高频操作效率。
- 同一功能区域内的控件节奏与间距应保持一致。
- 避免影响可读性和任务聚焦的纯装饰性样式。

## 7. Orbit Bar 规范

SSH 页面中的终端文本选区交互必须满足以下规则：

- Orbit Bar 必须使用基于 token 的 Menubar 风格表面（`menu-control`、`menu-divider`、`shadow-menu`）。
- 仅在终端存在选区时显示 Orbit Bar，且优先放置在选区上方。
- 若上方放置会遮挡选区或超出可视边界，则放置在选区下方。
- Orbit Bar 位置需随选区移动及视口/布局变化持续同步。
- 所有图标动作必须提供 Tooltip 文案，并通过 renderer i18n 本地化。
- 暂未实现的动作必须提供明确“即将支持”反馈，禁止静默无响应。

## 7.1 SSH 分屏右键交互规范

- SSH 终端的分屏/关闭动作仅通过终端右键菜单暴露。
- 分屏序列固定为高密度布局（1 → 2 → 3 → 4），以保持可预测的操作与扫描节奏。
- 窗格分隔线必须使用 token 化分隔色，并保持比卡片边界更浅的对比度。
- SSH 分屏分隔线应使用专用 token `color.ssh.terminal.split.divider`（Tailwind 类：`border-ssh-terminal-split-divider`），不要复用 Home/Card 通用分隔色。
- 在技术可行时，分屏默认复用当前活动终端会话流，避免无必要地新增后端会话。
- 每个窗格右键菜单都应提供关闭入口，但界面上至少保留一个可见窗格。

## 7.2 Tab 重排运行时连续性

- 拖拽/重排 tab 只应影响标签条顺序，不得触发页面运行时卸载或重建。
- 对运行时负载较重的页面（例如 SSH/xterm 会话），tab 顺序变化时必须保持内存会话状态连续。
- 重排状态更新应基于 id，并且必须复用 state 中最新 tab 对象，禁止把拖拽期间的过期快照直接回写。

## 8. 合规检查清单

合并 UI 变更前：

1. 新颜色/圆角/阴影值必须来自 token 流水线。
2. 新交互原语应为 `components/ui` 下的 Radix 封装。
3. 字体与间距遵循既有系统级比例。
4. 组件行为与状态反馈与现有封装保持一致。
