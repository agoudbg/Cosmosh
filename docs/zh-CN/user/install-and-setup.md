# 安装与初始化

## 安装

安装包下载入口：

- https://github.com/agoudbg/cosmosh/releases

### Windows

1. 在最新 Release 下载 `.exe` 安装包。
2. 运行安装程序并完成安装。
3. 在 **Windows 集成** 页面（可选）中，选择是否：
	- 将 **在 Cosmosh 中打开终端** 添加到文件夹/磁盘右键菜单。
	- 将 Cosmosh 注册为 Windows 终端启动应用（`App Paths`），并创建 `cosmosh` 终端命令启动 shim。
4. 从桌面或开始菜单启动 Cosmosh。

若启用右键菜单集成，资源管理器会将当前目录作为启动工作目录上下文传给 Cosmosh，并用于下一次本地终端会话创建。

若启用终端启动应用注册，你可以在 PowerShell/CMD 中直接使用 `cosmosh` 启动 Cosmosh。

### macOS

1. 在最新 Release 下载适配芯片架构的 macOS 安装包。
2. 将应用拖入 `Applications`。
3. 从 Launchpad 或 Applications 启动 Cosmosh。

### Linux

1. 在最新 Release 下载 Linux 安装包（具体格式以发布产物为准）。
2. 按当前发行版方式安装。
3. 从应用启动器或终端启动 Cosmosh。

## 首次配置

- 确认应用语言与基础偏好设置。
- 准备至少一个 SSH 目标与认证方式。
- 如使用密钥认证，请确认私钥文件路径可用。

## 连接就绪检查

- 确认当前网络能访问目标主机与端口。
- 确认目标服务器 SSH 服务已开启。
- 确认账号具备你需要执行命令的权限。

## 安全建议

- 妥善保管私钥，避免共享密钥文件。
- 对未知主机先校验指纹，再决定是否信任。
- 远程连接建议使用最小权限账号。

## 安装或配置失败怎么办

- 请先查看[故障排查](./troubleshooting.md)中的对应问题处理路径。

## 安装后建议验证

1. 正常启动 Cosmosh。
2. 创建一个测试服务器配置。
3. 建立 SSH 会话并执行 `echo COSMOSH_OK`。
4. 显式关闭会话，确认生命周期行为正常。

## 截图占位

1. Release 页面与安装包列表。
2. 安装完成界面。
3. 首次启动后的基础设置入口。
