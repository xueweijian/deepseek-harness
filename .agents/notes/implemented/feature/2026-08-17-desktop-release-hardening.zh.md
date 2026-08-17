# Agent Note: 桌面发版加固：macOS、依赖跟随、就绪轮询

Status: implemented

[English](2026-08-17-desktop-release-hardening.md) | 中文

## 问题

独立桌面壳此前只发 Windows 和 Linux；`@deepseek-ai/dsh` 运行时版本只靠手动跟进；sidecar 与冒烟测试都用子进程打印的 `dsh web: http://127.0.0.1:<端口>` 行来判定就绪。这条正则加上硬编码的 `lib/bin.js` 入口路径，把壳耦合到两个本不需要的上游细节：子进程日志格式与包布局。评审还提出了托盘、原生通知、`dsh://` deep link 与 Windows 签名通道。

## 决策

**就绪靠轮询，不靠解析。** 壳层本来就以 `--port <n>` 启动子进程，服务 URL 在 spawn 前已知。`sidecar.ts` 与 `smoke-sidecar.mjs` 改为轮询 `http://127.0.0.1:<n>/`（单次 HTTP 超时 2 秒、间隔 250 毫秒、总预算 60 秒），收到任意 HTTP 响应即就绪。子进程 stdout/stderr 仍写入诊断日志环，但没有任何代码从中读取语义。上游改日志格式或入口路径都不再影响启动判定。

**CLI 入口来自包清单。** sidecar 与冒烟测试都通过已安装包的 `bin` 字段解析 dsh 入口（名为 `dsh` 的条目，否则唯一条目），清单不可读或无可用条目时高声失败。装配失败走既有的 fatal/错误页路径，不会变成未处理的 Promise 拒绝。CI 打包冒烟步骤改传 `SMOKE_DSH_DIR`（包目录）而非显式 `lib/bin.js`，覆盖变量不再把耦合带回来。

**macOS 以双架构交叉构建发布。** `fetch-node.mjs` 接受 `--arch arm64|x64`（stamp 记录并校验架构；win/linux 仍只支持 x64），下载 darwin 的 `.tar.gz`，裁剪目录与 Linux 相同。`macos-latest` job 在 arm64 runner 上交叉构建 arm64 与 x64 的 dmg+zip——可行是因为应用不含 Electron 原生模块、`extraResources` 是纯文件——并对 `dist/mac-arm64` / `dist/mac` 跑打包后冒烟（x64 的 sidecar Node 经 Rosetta 运行）。mac 构建为 ad-hoc 签名（`identity: null`），updater 在 darwin 上跳过并记日志，因为 Squirrel.Mac 无法对未签名应用自更新。

**Dependabot 跟随两份 desktop 清单。** 既有 `.github/dependabot.yml` 的根 npm 条目排除 `desktop/**`，新增 `/desktop`（Electron 工具链）与 `/desktop/runtime`（dsh 闭包），cooldown 从根的 30 天缩短为 7 天。每个升级 PR 自动触发 desktop CI 校验构建与冒烟测试，上游破坏性变更在合并前暴露。

**壳层增加托盘、通知与 `dsh://`。** 关闭窗口隐藏到托盘（首次弹通知说明去向；托盘菜单「退出」走既有 sidecar 清理路径退出）。更新下载完成弹原生通知，点击调用 `quitAndInstall`。`dsh://` 经 electron-builder.yml 的 `protocols` 与 `setAsDefaultProtocolClient` 注册；链接聚焦窗口并记日志，web 界面定义路由之前不做映射。

**Windows 签名只铺管道，不代购证书。** 发版 workflow 透传可选的 `CSC_LINK`/`CSC_KEY_PASSWORD` secrets；electron-builder 在它们存在时签名，不存在时行为与现状完全一致。

**冒烟覆盖路径解析为绝对路径。** 打包冒烟暴露了一个潜伏失败：`spawn` 按 `options.cwd` 解析相对可执行路径，而子进程以 `cwd: homedir()` 运行，于是 CI 风格的相对 `SMOKE_NODE` 路径在文件实际存在时仍报 ENOENT。现在 Node 可执行文件与 dsh 入口在 spawn 前一律 `path.resolve`。同一轮还把 `typecheck` 脚本（`tsc --noEmit`）加入 package.json——此前 esbuild 只转译不查类型，已入库的类型错误从未暴露。

## 曾考虑的替代方案

**把就绪正则做成环境变量可覆盖。** 不采用：耦合还在，只是多了一个要维护的旋钮。轮询我们自己选定的端口，直接消除了这层依赖。

**macOS 用 x64 runner 构建。** 不采用：GitHub 的 Intel macOS 镜像正在退场。在 arm64 runner 上交叉构建只维护一种 runner，且打包链中没有任何构建期架构敏感物。

**为 desktop 清单引入 Renovate。** 不采用：仓库已在跑 Dependabot；覆盖 `/desktop` 与 `/desktop/runtime` 直接复用其标签、计划与 PR 管道，不需要第二个机器人。

**现在就映射 `dsh://` 路径到 web 路由。** 不采用：web 界面没有定义这些路由；臆造映射会在上游第一次变更时失效。协议注册与聚焦行为才是稳定部分。

## 后果

启动不再依赖上游日志措辞或入口文件名；剩余的上游耦合是 `web --port --host` CLI 旗标与 `node-pty@1.1.0` 补丁，两者都被每次 CI 校验构建覆盖。发版覆盖三平台并产出带架构后缀的 macOS 制品，发版 tag 流程不变。未签名的 mac 构建无法自更新——README 已说明并指向手动安装 dmg——Windows SmartScreen 在证书进入仓库 secrets 前依旧存在。用户默认获得关闭到托盘行为，窗口关闭键的含义随之改变；托盘通知与菜单承载这层约定。
