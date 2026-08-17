# DSH Desktop

DSH Desktop 是 DeepSeek Harness 的 Windows / Linux / macOS 桌面版。安装后开箱即用：安装包自带一份独立的 Node 24 运行时和完整的 `dsh` 命令行环境，不需要预先安装 Node、Python 或任何开发工具。

## 下载与安装

从 [GitHub Releases](https://github.com/xueweijian/deepseek-harness/releases) 下载最新版：

- Windows：`dsh-desktop-<版本>-win-x64.exe`（安装版）或 `.zip`（免安装解压即用）
- Linux：`.AppImage`（chmod +x 后直接运行）或 `.deb`
- macOS：`dsh-desktop-<版本>-mac-arm64.dmg`（Apple Silicon）或 `dsh-desktop-<版本>-mac-x64.dmg`（Intel）

**Windows SmartScreen 提示**：安装包尚未签名或未积累信誉时，双击后可能弹出「Windows 已保护你的电脑」。点击「更多信息」→「仍要运行」即可继续安装。

**macOS Gatekeeper 提示**：安装包为未签名（ad-hoc）构建，首次打开可能被拦。在「访达」中右键点击应用 →「打开」→ 再点「打开」；或执行 `xattr -d com.apple.quarantine /Applications/DSH\ Desktop.app`。

## 首次启动

1. 启动 DSH Desktop。应用会在本机环回地址（`http://127.0.0.1:<随机端口>`）启动 `dsh web` 服务，窗口内加载的正是这套界面；服务只监听本机，不会暴露到局域网。
2. 首页会引导你粘贴 DeepSeek API Key（`DEEPSEEK_API_KEY`），按提示粘贴保存即可。
3. 之后的会话、设置等数据都保存在用户主目录的 `~/.dsh`（Windows 为 `C:\Users\<你>\.dsh`）下，卸载重装不丢数据。

## 桌面行为

- **托盘**：关闭窗口不会退出应用，而是最小化到系统托盘（首次会弹通知提示）；点击托盘图标或托盘菜单「显示窗口」恢复，菜单「退出」才真正退出。
- **`dsh://` 链接**：应用注册了 `dsh://` 协议；从浏览器等处打开此类链接会把应用窗口带到前台。web 界面尚未定义 `dsh://` 路由，链接目标目前只记录在日志中，待上游支持后映射为界面导航。
- **服务就绪判定**：壳层轮询自己分配的环回端口上的 HTTP 响应，不解析 `dsh web` 的日志输出，上游日志格式变化不影响启动。

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
  - macOS：`~/Library/Logs/dsh-desktop/sidecar.log`

## 自动更新

- **Windows / Linux**：安装版应用启动时以及之后每 4 小时会向 GitHub Releases 检查新版本，有更新时自动下载并以系统通知提示，点击通知重启安装；更新检查失败只记录日志，不打扰使用。
- **macOS**：未签名构建无法走应用内自动更新（Squirrel.Mac 限制），请从 Releases 手动下载新版 dmg 覆盖安装。

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

macOS 交叉构建：`node scripts/fetch-node.mjs --arch x64`（或 `arm64`）下载对应架构的 Node 运行时后，`electron-builder --mac dmg zip --arch <arch>` 即可在 Apple Silicon 机器上产出 Intel 包。

目录约定：`build/icon.ico` / `build/icon.png` 为应用图标源文件；`build/node-runtime/`（下载的 Node）、`runtime/node_modules/`（dsh 闭包）、`dist-electron/`、`dist/` 均为构建产物，不入库。

冒烟测试可用环境变量覆盖路径：`SMOKE_NODE`（node 可执行文件）、`SMOKE_DSH_BIN`（dsh 入口文件，直指具体文件）、`SMOKE_DSH_DIR`（dsh 包目录，按其 package.json 的 bin 字段解析入口）。

## 测试

测试分三层，CI 的每个平台 job（Windows / Linux / macOS arm64 / macOS x64）全部执行：

- **单元与集成**（`pnpm --dir desktop run test`，vitest）：监督循环用真实子进程验证——一个 fixture 假扮 `dsh web`（延迟就绪、立即崩溃、永不就绪、刷日志、自行退出、spawn 失败各有用例）；就绪轮询用真实 HTTP/Socket 服务验证，包括「TCP 接受但不应答不算就绪」；`bin` 字段解析、deep link 扫描、错误页转义、fetch-node 的参数与 stamp 校验各有独立用例。`pnpm run test:coverage` 按文件门禁：sidecar/updater/helpers 语句、函数、行 100%（分支 90+），main.ts 豁免（见 vitest.config.ts 注释）。
- **冒烟**（`pnpm run smoke`）：真实拉起 dsh web 并断言返回页面；CI 另对打包产物跑一遍（`SMOKE_NODE` + `SMOKE_DSH_DIR` 指向 dist 内资源）。
- **人工矩阵**（main.ts 的托盘/通知/deeplink 等需 Electron 运行时的行为）：关窗到托盘、托盘恢复/退出、更新通知点击安装、`dsh://` 链接聚焦；发版前人工过一遍。

测试可注入的监督参数（也是真实部署调优项）：`DSH_SIDECAR_READY_TIMEOUT_MS`、`DSH_SIDECAR_MAX_RESTARTS`、`DSH_SIDECAR_BACKOFF_BASE_MS`（设了但无法解析会在启动时高声报错）。

## 依赖跟随与发版

- Dependabot 每日检查 `/desktop`（Electron 工具链）与 `/desktop/runtime`（`@deepseek-ai/dsh` 运行时）的更新并提 PR；每个 PR 自动跑本目录的 CI 校验构建与冒烟测试，上游破坏性变更会在合并前暴露。
- 发版：打 `desktop-v<版本>` tag 推送，CI 构建 Windows（nsis+zip）、Linux（AppImage+deb）、macOS（dmg+zip，arm64 与 x64）并发布到 GitHub Releases。
- **Windows 签名（可选）**：在仓库 secrets 配置 `CSC_LINK`（PFX 证书的 base64）与 `CSC_KEY_PASSWORD` 后，CI 自动对 Windows 安装包做 Authenticode 签名，SmartScreen 警告随之缓解；未配置时保持未签名构建。macOS 签名需 Apple 开发者证书，配置后移除 electron-builder.yml 中 `mac.identity: null` 并提供 `CSC_NAME`。
