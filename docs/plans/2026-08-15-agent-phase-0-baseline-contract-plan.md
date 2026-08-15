# Agent Phase 0 — Build Baseline & Contract Plan

> Status: `in_progress`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Phase: 0 / Baseline & Contract
> Depends on: none

## 1. 目标

在增加任何 Agent 生产代码前，恢复可重复构建，关闭当前基线歧义，并冻结 P4 与 Agent 的最小协议契约。

## 2. 范围

包含：

- ESP-IDF v5.5.4 工具链与干净构建验证；
- ESP32-C6 ESP-Hosted 配置重建；
- 现有固件 image、DIRAM、heap、stack、网络和 UI 基线；
- M6 遗留项裁决；
- Device Protocol v1、Tool Schema v1；
- simulator/fake transport 合约测试骨架。

不包含：

- Ollama 生产接入；
- 新增 P4 WebSocket；
- 重构 `ui_home_actor`；
- 语音、Memory、Autonomy；
- managed component 或 ESP-IDF 版本升级。

## 3. 工作包

### P0.1 恢复可重复构建

- [x] 安装 ESP-IDF v5.5.4 manifest 要求的 RISC-V 工具链；
- [x] 验证 `scripts/activate-idf-v5.5.4.sh` 输出版本正确；
- [x] 在临时干净 build 目录完成 `idf.py build`；
- [x] 确认未依赖旧 `sdkconfig` 或旧 CMake cache；
- [x] 记录实际 compiler、Python、CMake、Ninja 与 managed component lock 版本；
- [x] 将复现命令写入当前 IDF 安装/激活文档。

证据：构建命令、版本输出、最终 image size 摘要。

实际结果（2026-08-15）：加入运行期诊断采样后的全量干净构建通过，`.bin` 为
`1,437,792 bytes`，静态 DIRAM 为 `296,378 / 576,464 bytes`。本机未安装 Ninja，CMake 实际使用
Unix Makefiles。详见 [build baseline](../../evidence/agent-phase-0/build-baseline.md)。

### P0.2 固化 C6 Hosted 配置

- [x] 从 `sdkconfig.defaults` 独立生成配置；
- [x] 确认 `SLAVE_IDF_TARGET_ESP32C6=y`；
- [x] 确认 Function EV Board pin map；
- [x] 确认 SDIO host interface；
- [x] 消除相关 unknown kconfig warning；
- [x] 验证 Wi-Fi、HA WebSocket 和 modem sleep 实机正常。

证据：关键 config 摘要与串口 `VERIFY:network:*`、`VERIFY:ha:*`。

实际结果（2026-08-15）：独立生成配置确认 ESP32-C6、Function Board、SDIO slot 1
四线 40 MHz；配置日志没有 unknown Kconfig/attempt-to-assign。随后实机确认 Hosted transport、
Wi-Fi DHCP、HA READY 和 C6 modem sleep 正常，15 分钟窗口重连计数为 0。详见
[hardware regression](../../evidence/agent-phase-0/hardware-regression-2026-08-15.md)。

### P0.3 裁决 M6 遗留项

- [x] 恢复 HA 可达性；
- [ ] 实机点击至少一个真实灯具；
- [ ] 确认 `call_service` 成功、设备动作与 `state_changed` 回刷；
- [x] 记录米家闭环是完成、延期还是移出当前范围；
- [x] 将结论写入新的 `docs/project-milestones.md`。

说明：若外部 HA/米家条件暂不可用，可以明确登记为已知债务，但 Phase 2 不得同时修改未经验证的 HA 主链。

实际结果（2026-08-15）：Mac 到 HA `192.168.71.4:8123` 的 TCP 与 HTTP 检查通过；随后
P4 实机也恢复 Wi-Fi/HA READY，并持续接收 `state_changed`。真实灯具、`call_service`、
物理动作与对应回刷仍未执行，必须在 Phase 2 修改 P4 实时链路前关闭。详见
[M6 readiness](../../evidence/agent-phase-0/m6-readiness.md)。

### P0.4 采集运行期基线

- [x] 记录 app image 与 static DIRAM；
- [x] 记录启动后 internal/PSRAM free heap；
- [x] 记录 minimum free heap 与 largest internal block；
- [x] 记录主要任务 stack high-water mark；
- [ ] 连续运行现有 HA + Pixel Home 至少 2 小时；
- [x] 记录 UI 8 FPS heartbeat、HA event rate、重连次数；
- [x] 保存串口日志与基线摘要到 `evidence/agent-phase-0/`。

实际结果（2026-08-15）：15 分钟实机窗口完成，HA 全程 READY、`reconnect=0`、事件数
72→204，UI FX 到 tick 6912 且 `denied=0`。steady internal free 约 145 KB、minimum
108,479 B，PSRAM 约 32.25 MB；HA worker 栈余量 4,088 B。首轮 main task 栈余量只有
660 B，随后将默认栈由 3,584 B 扩到 5,120 B，实机复测稳定为 2,196 B，Wi-Fi、HA、UI 与
heap 无回归；异步 SNTP 也新增明确 PASS 标记。2 小时长跑仍未完成。详见
[hardware regression](../../evidence/agent-phase-0/hardware-regression-2026-08-15.md)。

### P0.5 冻结 Device Protocol v1

- [x] 定义 envelope：version、message_id、correlation_id、device_id、seq、timestamp、type、payload；
- [x] 定义 hello/capabilities/snapshot/heartbeat/error；
- [x] 定义 action request/accepted/started/completed/failed/cancel；
- [x] 定义错误码、deadline、幂等和重连对账规则；
- [x] 定义最大 JSON frame 与二进制音频边界；
- [x] 生成 JSON Schema 示例和正反例 fixture；
- [ ] review 后标记 `protocol_version = 1`。

建议落点：

```text
contracts/device-protocol/v1/
├── envelope.schema.json
├── messages/
├── examples/
└── README.md
```

实际结果（2026-08-15）：schema、消息 fixture 与协议说明已落到
`contracts/device-protocol/v1/`，实现标记为 v1 候选；等待用户 review 后正式冻结。

### P0.6 冻结 Tool Schema v1

- [x] 定义稳定 room id；
- [x] 仅暴露当前可实现的 `character.get_state/character.go_to_room/character.set_activity/character.say/world.get_snapshot`；
- [x] 定义工具参数、结果与稳定错误码；
- [x] 明确 `sit/look_at/interact` 不属于 v1；
- [x] 建立 20 个中文意图到 ToolCall 的黄金场景。

实际结果（2026-08-15）：tool catalog、result schema、错误码和 20 条中文黄金场景已落到
`contracts/tools/v1/`；其中对象级动作、未知房间和 Phase 4 HA 意图必须保持 no-tool。

### P0.7 建立合约测试

- [x] 为 simulator/fake backend 增加 protocol peer；
- [x] 验证合法消息、非法 schema、重复 action_id、超时、取消；
- [x] 验证断线重连后 full snapshot；
- [x] 验证队列满时 reject；
- [x] 测试不依赖 Ollama 和真实 P4。

实际结果（2026-08-15）：`./scripts/validate-agent-contracts.sh` 的 13 项标准库测试通过；
详见 [contract test evidence](../../evidence/agent-phase-0/contract-tests.md)。

## 4. 验证矩阵

| 类型 | 验证 |
|---|---|
| 构建 | 干净固件 build；schema/fixture 校验 |
| 功能 | fake peer 完成完整 action 生命周期 |
| 回归 | 原 HA UI、Pixel Home、触摸行为不变 |
| 故障 | duplicate、乱序、断线、timeout、cancel、queue full |
| 实机 | Wi-Fi/HA/显示长跑与 heap/stack 证据 |

## 5. 风险与回滚

- 工具链修复不得顺带升级 IDF 或依赖版本；
- `sdkconfig` 是生成文件，最终修复必须落到 defaults/安装流程；
- M6 外部环境不可用时不得伪造完成状态；
- 协议未 review 前只允许 fixture/Mock，不进入固件生产代码。

## 6. 完成定义

- [x] 新 build 目录一次构建通过；
- [x] C6 Hosted 配置无 unknown warning；
- [x] M6 遗留状态已明确；
- [x] 运行期资源基线有实机证据；
- [ ] Device Protocol v1 与 Tool Schema v1 review 通过；
- [x] fake contract tests 覆盖正常和关键故障路径；
- [ ] 用户 review 通过后，将本计划归档并启动 Phase 1。
