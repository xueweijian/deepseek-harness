# DSH Desktop

DSH Desktop 是 DeepSeek Harness 的 Windows / Linux 桌面版。安装后开箱即用：安装包自带一份独立的 Node 24 运行时和完整的 `dsh` 命令行环境，不需要预先安装 Node、Python 或任何开发工具。

## 下载与安装

从 [GitHub Releases](https://github.com/xueweijian/deepseek-harness/releases) 下载最新版：

- Windows：`dsh-desktop-<版本>-win-x64.exe`（安装版）或 `.zip`（免安装解压即用）
- Linux：`.AppImage`（chmod +x 后直接运行）或 `.deb`

**Windows SmartScreen 提示**：安装包尚未积累信誉时，双击后可能弹出「Windows 已保护你的电脑」。点击「更多信息」→「仍要运行」即可继续安装。

## 首次启动

1. 启动 DSH Desktop。应用会在本机环回地址（`http://127.0.0.1:<随机端口>`）启动 `dsh web` 服务，窗口内加载的正是这套界面；服务只监听本机，不会暴露到局域网。
2. 首页会引导你粘贴 DeepSeek API Key（`DEEPSEEK_API_KEY`），按提示粘贴保存即可。
3. 之后的会话、设置等数据都保存在用户主目录的 `~/.dsh`（Windows 为 `C:\Users\<你>\.dsh`）下，卸载重装不丢数据。

## 配置

- **自定义 API 地址**：编辑 `~/.dsh/.env`，写入

  ```
  DEEPSEEK_API_KEY=sk-xxxx
  DEEPSEEK_BASE_URL=https://your-proxy.example.com
  ```

- **数据目录**：默认 `~/.dsh`；设置环境变量 `DSH_HOME` 可重定向到其他目录。
- 服务端日志（排查启动失败用）：
  - Windows：`%APPDATA%\dsh-desktop\Logs\sidecar.log`
  - Linux：`~/.config/dsh-desktop/logs/sidecar.log`

## 自动更新

安装版应用启动时以及之后每 4 小时会向 GitHub Releases 检查新版本，有更新时自动下载并在下次启动时安装；更新检查失败只记录日志，不打扰使用。

## 常见问题

- **启动后显示「dsh 服务启动失败」**：页面会显示日志尾部并自动倒计时重试。持续失败时查看上面的 sidecar 日志，常见原因是 `~/.dsh` 目录权限问题或被安全软件拦截了自带的 node.exe。
- **需要换端口/代理**：桌面壳内部使用系统随机分配的环回端口，无需配置。

## 开发与构建

前置：Node 22 或 24、pnpm 10+。

```sh
cd desktop
pnpm install            # 安装 Electron 构建链
pnpm run fetch-node     # 下载并校验随包分发的官方 Node 24（build/node-runtime/）
pnpm run runtime:install  # 在 runtime/ 安装 @deepseek-ai/dsh 精确版闭包
pnpm run build:electron # esbuild 把 electron/*.ts 打包为 dist-electron/main.cjs
pnpm run smoke          # 无 GUI 冒烟：真实拉起 dsh web 并取回 HTML
pnpm run start          # 本地启动桌面壳（开发态）
pnpm run dist           # 打安装包（默认 --publish never；CI 传 --publish always）
```

目录约定：`build/icon.ico` / `build/icon.png` 为应用图标源文件；`build/node-runtime/`（下载的 Node）、`runtime/node_modules/`（dsh 闭包）、`dist-electron/`、`dist/` 均为构建产物，不入库。

冒烟测试可用环境变量覆盖路径：`SMOKE_NODE`（node 可执行文件）、`SMOKE_DSH_BIN`（dsh 的 lib/bin.js）。
