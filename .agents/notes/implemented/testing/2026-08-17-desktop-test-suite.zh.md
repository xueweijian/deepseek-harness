# Agent Note: 以 harness 测试政策为范本的桌面测试套件

Status: implemented

[English](2026-08-17-desktop-test-suite.md) | 中文

## 问题

独立桌面壳此前没有任何自动化测试：监督循环、就绪轮询、manifest bin 解析、updater 接线与错误页渲染，全部依靠两轮冒烟（开发态与打包态）加人工 GUI 检查支撑。上游包保持接近 1:1 的测试代码比（subprocess-local 源码 1391 行 / 测试 1384 行；session-persistence 2159 / 2573），其政策优先真实实现而非 mock、验证世界而非自报告。桌面壳需要同样的纪律，又不能引入 workspace 的构建链——desktop 刻意是独立的 npm 消费者。

## 决策

**vitest、同习惯、独立安装。** desktop 本地新增 `vitest` + `@vitest/coverage-v8` devDeps（绝不随包分发）、`test` / `test:watch` / `test:coverage` 脚本、测试就近放在 `electron/tests/` 与 `scripts/tests/`，tsconfig 一并类型检查测试（`allowImportingTsExtensions`，对齐上游的源码面导入）。

**监督循环用真实子进程。** `fake-dsh-web.mjs` fixture 在测试运行器自己的 node 下运行，通过继承的环境变量假扮 `dsh web`（`FAKE_DELAY_MS`、`FAKE_EXIT_CODE`、`FAKE_NEVER_READY`、`FAKE_SPAM_LINES`、`FAKE_EXIT_AFTER_MS`），生产代码的固定 argv 原样被执行。用例覆盖：就绪后拆除（断言端口停止服务——验证世界而非听子进程自报）、延迟就绪、崩溃循环耗尽并上报最后退出码、永不服务的子进程按就绪超时处理、日志环截断、spawn 失败走重启预算、双启拒绝、fatal 后会话可重启。

**就绪轮询对着恶意服务验证。** pollReady 用真实 HTTP 与裸 TCP：204 无 body 响应也算就绪；连接拒绝期间持续重试直到服务出现；接受 TCP 但永不应答的黑洞 socket 不会让轮询结束——这正是 stdout 正则设计表达不了的那类混淆。

**只 mock 昂贵边界。** updater 用例 mock `electron` 与 `electron-updater`（应用外壳与网络）；套件里其余一切都是真的。Electron `app` 是 hoisted 可变桩；`process.platform`/`process.resourcesPath` 用捕获的原值保存-恢复——此前"从已被改写的现值恢复"的 bug 毒化了后续用例，这个教训被写进了恢复逻辑。

**可测性重构保持生产形状。** 监督常量（`READY_TIMEOUT_MS`、`MAX_RESTARTS`、`BACKOFF_BASE_MS`）读正整数环境覆盖，设了但无法解析会高声报错——既是慢首启机器的真实配置项，也让超时路径可以在秒级测完。`Supervisor` 接受可选路径注入。`findDeepLink`/`errorPageUrl`/`escapeHtml` 从 main.ts 移入无 Electron 依赖的 helpers.ts；fetch-node.mjs 用 is-main-module 守卫包裹主流程，导出 `archFromArgv`/`validateTarget`/`archiveName`/`stampOk`。

**带窄豁免的覆盖率门禁。** `test:coverage` 对 sidecar.ts 要求语句/函数/行 100%、分支 ≥90%；updater.ts 与 helpers.ts 全 100%。main.ts 豁免（窗口/托盘胶水需要真实 Electron 运行时；由 README 人工矩阵加 CI typecheck 承担），沿用 pwsh 豁免先例。五处 `v8 ignore` 均注明理由：posix 专用的 killTree（由 posix CI 腿覆盖）、打包态日志分支（由打包冒烟真实覆盖）、三个不可复现的防御路径。

**套件在发版前抓到一个真 bug。** `Supervisor.stop()` 遇到已退出的子进程会新注册一个永远不触发的 `exit` 监听，然后傻等完整 5 秒宽限——每次 fatal 后的恢复与退出都白吃五秒。修复（已退出子进程直接返回，与 killTree 自身的守卫对称）由失败的测试驱动，不是靠 review 看出来的。

## 曾考虑的替代方案

**用 node:test 而非 vitest。** 不采用：上游统一 vitest；对齐其习惯（`vi.hoisted`、`vi.mock` 配 importOriginal 透传、假定时器）让上游贡献者读得懂 fork 的测试，且运行时零成本。

**只通过 startSidecar 测试。** 不采用：模块级会话 API 无法注入路径，fixture 驱动的循环测试将需要真实运行时闭包。导出 `Supervisor` 加可选注入，生产调用点不变。

**为 main.ts 上 Playwright electron 车道。** 暂缓：价值真实，但那是新的依赖车道与 GUI 运行器设施；本次风险由人工矩阵加纯函数提取覆盖。desktop README 已记录为后续项。

## 后果

desktop 的每个 CI job（Windows、Linux、macOS arm64、macOS x64）都在装依赖与打包之间跑 typecheck 与单元套件，回归在任何工件产生之前就在四个平台全红。套件本地约 15 秒跑完。计时旋钮获得带高声失败的环境覆盖，运维也可在慢机器上使用。stop() 宽限修复移除了每次 fatal 后重试与退出的五秒停顿。未来的 GUI 自动化留了车道（Playwright），此前由文档化的人工矩阵承担。
