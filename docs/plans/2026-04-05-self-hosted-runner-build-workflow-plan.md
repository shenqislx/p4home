# self-hosted-runner-build-workflow Plan

## 1. 背景

当前仓库已完成本地 `ESP-IDF v5.5.4` 构建基线和 self-hosted runner 注册，但尚未把 GitHub Actions 调度到这台本地 runner。需要先建立一个最小可用的 workflow，验证 GitHub 云端事件可以触发本地 `macOS ARM64` runner 完成 `ESP32-P4` 固件构建。

## 2. 目标

- 新增一个可手动触发的 GitHub Actions workflow
- 让 workflow 调度到本地 `self-hosted macOS ARM64` runner
- 在 runner 上激活项目约定的 `ESP-IDF v5.5.4`
- 成功执行 `idf.py set-target esp32p4` 和 `idf.py build`

## 3. 范围

包含：

- 新增 `.github/workflows/` 下的最小构建 workflow
- 明确 self-hosted runner 依赖的环境前提
- 与现有 `scripts/activate-idf-v5.5.4.sh` 保持一致

不包含：

- 自动烧录开发板
- 串口监控与硬件联调
- 手机通知
- push / pull request 自动触发策略

## 4. 设计方案

### 4.1 目录影响

- 新增 `.github/workflows/firmware-self-hosted-build.yml`
- 新增 `docs/plans/2026-04-05-self-hosted-runner-build-workflow-plan.md`

### 4.2 模块拆解

- GitHub Actions workflow 负责把任务调度到符合标签的 self-hosted runner
- runner 使用项目内激活脚本切换到 `ESP-IDF v5.5.4`
- 固件工程在 `firmware/` 目录内执行目标设置和构建

### 4.3 数据流 / 控制流

- 用户在 GitHub Actions 页面手动触发 workflow
- GitHub 根据 `runs-on` 标签匹配到本地 runner
- runner 拉取仓库代码
- workflow 执行 `activate-idf-v5.5.4.sh`
- workflow 导出 `IDF_SKIP_CHECK_SUBMODULES=1`
- workflow 执行 `idf.py set-target esp32p4` 和 `idf.py build`

## 5. 实现任务

1. 新增 self-hosted runner 构建 workflow
2. 复用项目现有 `ESP-IDF` 激活入口和构建命令
3. 限制为 `workflow_dispatch`，避免未经确认的持续占用本地 runner

## 6. 测试方案

### 6.1 构建验证

- 校验 workflow YAML 结构和命令路径
- 手动触发 GitHub Actions，确认 runner 能接到任务
- 验证 `idf.py build` 在 runner 上通过

### 6.2 功能验证

- 确认 workflow 在 GitHub 页面可见且可手动触发
- 确认 job 运行在 `self-hosted macOS ARM64` runner 上

### 6.3 回归验证

- 确认未修改现有固件源码和本地构建脚本行为

### 6.4 硬件/联调验证

- 本次不涉及硬件串口与烧录
- 后续若加入 `flash` / `monitor`，再补充硬件联调验证

## 7. 风险

- runner 环境若未安装 `ESP-IDF v5.5.4`，workflow 会失败
- runner 若作为后台服务运行，用户级 `HOME` 或 shell 环境可能与交互终端不同
- `IDF_SKIP_CHECK_SUBMODULES=1` 仍是当前构建前提

## 8. 完成定义

- 仓库内存在可执行的 self-hosted build workflow
- workflow 使用项目约定的 `ESP-IDF v5.5.4` 激活脚本
- workflow 仅手动触发，避免误占 runner

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待用户重点查看的文件
