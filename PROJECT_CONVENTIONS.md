# 项目开发与运行约定 / Project Development Conventions

本项目制定了以下开发与环境约定，请所有开发者及 AI 辅助工具（Agent）严格遵守：

---

## 1. 核心约定 / Core Principles

### 1.1 禁止在本地拉取依赖 (No Local Dependency Installation)
- **严格禁止**在本地环境中运行 `pnpm install`、`npm install`、`yarn` 等依赖安装命令。
- 本地机器可能存在环境不齐备、磁盘配额或网络受限等原因，不维护本地 `node_modules` 或构建缓存。

### 1.2 禁止在本地下载大文件 (No Local Large File Downloads)
- **严格禁止**在本地下载大文件、模型权重、二进制包或大规模测试数据集。
- 保证本地工作区轻量化。

### 1.3 依托 GitHub Actions 完成构建与测试 (Rely on GitHub Actions)
- 本项目所有的构建（Build）、依赖解析（Dependency Resolution）、类型检查（Typecheck）、代码规范检查（Lint/Hygiene）及测试（Tests/CI）**统一通过 GitHub Actions 流水线执行**。
- 本地代码编写完成后，直接提交推送（Push / PR）至 GitHub，由云端 CI Runner 负责环境搭建、依赖安装和结果验证。

---

## 2. AI 助手（Agent）行为规范 / Agent Instructions

- AI 助手在执行任何开发、修复、重构任务时，**切勿主动或自动执行** `pnpm install` 或任何拉取依赖、下载大文件的指令。
- 依赖变动或配置文件修改直接通过文件编辑完成，验证工作交由 GitHub Actions CI。
