# cloud-codex-hardware-validation Plan

## 1. 背景

当前仓库已经具备 self-hosted runner 上的 `build -> flash -> serial capture` 能力，但 workflow 仍然在 CI 内部对固定启动日志做裁决。这会把硬件验证逻辑固化在 GitHub Actions 中，不利于云端 Codex 按任务动态解释串口输出。

下一步需要把职责边界改清楚：

- Action 负责机械执行与产物采集
- 云端 Codex 负责读取 artifact 并判定改动是否生效

## 2. 目标

- 将硬件 workflow 调整为“transport-only”模式
- 保留最小健康检查，只拦截 build/flash/capture 基础失败
- 上传稳定的日志与 manifest artifact，供云端 Codex 读取
- 补充一份明确的协议文档，约定 artifact 内容与裁决边界

## 3. 范围

包含：

- 更新 `.github/workflows/firmware-self-hosted-flash-serial.yml`
- 新增云端 Codex 硬件验证协议文档
- 为 artifact 增加 manifest 元数据
- 新增本地 Codex skill，固化该协议

不包含：

- 在固件中新增具体业务 `PASS/FAIL` 标记
- 云端 Codex 的具体调用脚本或外部服务编排
- PR 状态回写、comment 自动回写

## 4. 设计方案

### 4.1 职责划分

- GitHub Actions:
  - checkout
  - build
  - flash
  - capture serial log
  - 上传 artifact
  - 对基础执行失败给出红灯
- Cloud Codex:
  - 下载 artifact
  - 读取 `monitor.log`
  - 结合当前任务目标判断是否通过

### 4.2 Artifact 结构

上传统一 artifact，至少包含：

- `firmware/monitor.log`
- `firmware/hardware-validation-manifest.json`

manifest 记录：

- schema version
- mode / verdict owner
- git SHA
- run id / attempt
- serial port
- monitor seconds
- log file path

### 4.3 最小失败条件

workflow 仅在以下情况失败：

- `idf.py build` 失败
- `idf.py flash` 失败
- 串口采集脚本异常
- `monitor.log` 不存在或为空
- artifact 上传失败

### 4.4 不再由 workflow 负责的内容

- 固定业务日志断言
- 针对某个功能的 `PASS/FAIL` 解释
- 多测试场景的业务分流

## 5. 实现任务

1. 移除 workflow 中固定启动 marker 断言
2. 增加最小健康检查与 artifact manifest
3. 上传日志与 manifest 作为统一 artifact
4. 新增协议文档，说明 Codex 如何读取并裁决

## 6. 测试方案

### 6.1 构建验证

- workflow YAML 语法保持有效
- 串口采集脚本依旧运行在 `ESP-IDF v5.5.4` 环境内

### 6.2 功能验证

- workflow 仍能完成 build + flash + serial capture
- artifact 中包含 `monitor.log` 与 manifest

### 6.3 回归验证

- 不影响 build-only workflow
- 不改变本地手工 build / flash 习惯

### 6.4 硬件联调验证

- `monitor.log` 非空
- flash 失败时 job 失败
- capture 失败时 job 失败
- 成功时 job 产出完整 artifact，供后续 Codex 裁决

## 7. 风险

- 如果固件日志不具备稳定可判定信号，Codex 仍然难以自动判断功能是否生效
- Action 成功不再等价于“功能通过”，仅等价于“硬件执行链路成功”
- 后续若要接入 PR gate，仍需要把 Codex 裁决结果回写到 GitHub

## 8. 完成定义

- workflow 已切换到 artifact-first 模式
- 仓库中存在明确的协议文档
- 云端 Codex 可以仅通过 artifact 判断下一步动作

## 9. review 准备

在邀请用户 review 前补充：

- workflow 改动点
- artifact 结构
- Codex 读取与裁决边界
