# Agent Phase 0 — Build Baseline & Contract Plan

> Status: `completed`
> Architecture: [P4 Local Agent Architecture](../../../p4-local-agent-architecture.md)
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
`1,448,448 bytes`（当前 Phase 0 候选），静态 DIRAM 为 `297,196 / 576,464 bytes`（51.55%）。
本机未安装 Ninja，CMake 实际使用
Unix Makefiles。详见 [build baseline](../../../../evidence/agent-phase-0/build-baseline.md)。

runner 回归进一步确认忽略 `firmware/dependencies.lock` 会令全新 checkout 在线解析到不兼容的
`esp_hosted 3.0.6`，与本地已验证的 `2.12.3` 漂移。Phase 0 改为提交 lock 文件，并在 workflow
构建后强制检查 lock 未被改写；managed component 升级必须单独 review。

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
[hardware regression](../../../../evidence/agent-phase-0/hardware-regression-2026-08-15.md)。

### P0.3 裁决 M6 遗留项

- [x] 恢复 HA 可达性；
- [x] 实机点击至少一个真实灯具；
- [x] 确认 `call_service` 成功、设备动作与 `state_changed` 回刷；
- [x] 记录米家闭环是完成、延期还是移出当前范围；
- [x] 将结论写入新的 `docs/project-milestones.md`。

说明：若外部 HA/米家条件暂不可用，可以明确登记为已知债务，但 Phase 2 不得同时修改未经验证的 HA 主链。

实际结果（2026-08-15）：Mac 到 HA `192.168.71.4:8123` 的 TCP 与 HTTP 检查通过；随后
P4 实机也恢复 Wi-Fi/HA READY，并持续接收 `state_changed`。隔离回归仅操作书房吸顶灯
`switch.xiaomi_cn_2102810987_w2_on_p_3_1`：用户先确认灯具为“灭”，串口记录唯一一次
`VERIFY:ha:call_service:PASS id=58 domain=switch service=turn_on`，用户随后确认“已亮”。相邻
heartbeat 中 `events` 增加 27、`ignored_untracked` 增加 26、`stale` 不变，差值恰好为 1 条
受跟踪实体事件；同时 HA 保持 READY，`reconnect/offline/rejected` 均为 0。因此该代表性真实
灯具的 `call_service → 物理动作 → state_changed` 闭环判定通过。原始本地串口捕获
`/tmp/p4home-study-ceiling-isolated.log` 的 SHA-256 为
`2042c8b1717ffe8664bdcee7f7b9b871d3be0ef818b1aaecb1095c8e460a5189`；它不含 workflow
manifest，仅作为本次交互式实机验收的补充证据。此前受其他灯具手动操作污染的窗口不纳入
判定。更广泛的米家设备覆盖仍按既有裁决延期。详见
[M6 readiness](../../../../evidence/agent-phase-0/m6-readiness.md)。

### P0.4 采集运行期基线

- [x] 记录 app image 与 static DIRAM；
- [x] 记录启动后 internal/PSRAM free heap；
- [x] 记录 minimum free heap 与 largest internal block；
- [x] 记录主要任务 stack high-water mark；
- [x] 连续运行现有 HA + Pixel Home 至少 2 小时；
- [x] 记录 UI 8 FPS heartbeat、HA event rate、重连次数；
- [x] 保存串口日志与基线摘要到 `evidence/agent-phase-0/`。
- [x] 将非白名单 HA 事件与真实数据拒绝拆分为独立指标。

实际结果（2026-08-15）：15 分钟实机窗口完成，HA 全程 READY、`reconnect=0`、事件数
72→204，UI FX 到 tick 6912 且 `denied=0`。steady internal free 约 145 KB、minimum
108,479 B，PSRAM 约 32.25 MB；HA worker 栈余量 4,088 B。首轮 main task 栈余量只有
660 B，随后将默认栈由 3,584 B 扩到 5,120 B，实机复测稳定为 2,196 B，Wi-Fi、HA、UI 与
heap 无回归；异步 SNTP 也新增明确 PASS 标记。详见
[hardware regression](../../../../evidence/agent-phase-0/hardware-regression-2026-08-15.md)。

指标语义修正（2026-08-15）：`rejected` 只统计已跟踪实体的无效/拒绝更新；HA 全屋广播中未被面板
跟踪的实体改记为 `ignored_untracked`，避免把正常过滤误报成数据质量故障。该改动已通过构建，等待
最终候选固件实机长跑验证。首次短回归进一步发现天气服务发布目标曾从扩展后的白名单中丢失，导致
真实 `rejected` 持续增长；恢复 `weather.forecast_wo_de_jia` 注册项后，4 分钟复测中
`rejected=0`、`ignored_untracked=0→3`，Open-Meteo、HA READY、UI heartbeat 与资源指标均通过。
精确提交 `d05eaa0` 的隔离构建产物为 `1,448,448 bytes`，SHA-256 为
`4f1268051f454dabad0fbaa6a57fbde29a863bd2200c76b720d105527d31498b`；四个分区烧录后均通过
写后哈希校验。首轮长跑约 4 分钟时确认 HA READY、`reconnect=0`、`offline=0`、`rejected=0`，
但同时发现 runner 私密全量 sdkconfig 把仓库的 main task 5,120 B 栈配置回退为 3,584 B，故主动停止，
不计为最终长跑证据。新增的配置合并器已通过单测和全新隔离构建，ESP-IDF 生成配置中的新旧栈符号
均为 5,120。

最终候选提交 `b0aa443374360324a4a27dcc5a38c0a1849b0b45` 的正式 run
[`31875576865`](https://github.com/shenqislx/p4home/actions/runs/31875576865) 已完成从零构建、烧录和
7,200 秒串口采集。239 个 heartbeat 覆盖 `7,196,578 ms`，间隔为 `30,039–30,050 ms`；HA 239 个
采样全部为 `READY`，`reconnect=0`、`offline=0`、`rejected=0`，事件计数最终为 247。
internal free heap 最低 `142,283 B`、最后 `145,899 B`，minimum free heap 最低 `107,807 B`，
PSRAM free 最低及最后均为 `32,255,108 B`；main task stack high-water mark 全程为 `2,196 B`，
HA worker 最低为 `4,088 B`。UI 共 844 个采样，最终 tick 54,016，`denied=0`；无重启、panic、
watchdog、brownout、stack overflow、assert 或 `VERIFY:*:FAIL`。因此本轮对现有 HA + Pixel Home
稳定性的功能判定为通过。

### P0.5 冻结 Device Protocol v1

- [x] 定义 envelope：version、message_id、correlation_id、device_id、seq、timestamp、type、payload；
- [x] 定义 hello/capabilities/snapshot/heartbeat/error；
- [x] 定义 action request/accepted/started/completed/failed/cancel；
- [x] 定义错误码、相对 timeout、跨 session 幂等和显式 resync 对账规则；
- [x] 定义 WebSocket TLS、设备 Bearer 认证、物理配对、轮换与撤销边界；
- [x] 定义最大 JSON frame 与二进制音频边界；
- [x] 生成 JSON Schema 示例和正反例 fixture；
- [x] 完成协议、fixture、fake peer 与消息类型的一致性内部审查；
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
`contracts/device-protocol/v1/`。用户审阅发现的冻结阻塞项已经修订：新增
TLS + Bearer 设备认证与物理确认配对策略；用接收端单调时钟的 `timeout_ms` 取代有时钟偏差风险的
绝对 deadline；幂等缓存跨 WebSocket session 保留至少 600,000 ms，并拒绝不同参数复用同一
`action_id`；新增 `world.resync.request` 和 gap 后忽略增量直至关联 full snapshot 的规则；同时修复
有效 fixture 中 action 生命周期与 correlation 的矛盾。最终一致性审计和 30 项合约测试通过后，
Device Protocol v1 已于 2026-08-15 冻结；破坏性变更必须进入 protocol version 2。

### P0.6 冻结 Tool Schema v1

- [x] 定义稳定 room id；
- [x] 仅暴露当前可实现的 `character.get_state/character.go_to_room/character.set_activity/character.say/world.get_snapshot`；
- [x] 定义工具参数、结果与稳定错误码；
- [x] 明确 `sit/look_at/interact` 不属于 v1；
- [x] 建立至少 32 个中文意图到 ToolCall 的黄金场景；
- [x] 为五个工具定义互不混用的精确成功结果 schema；
- [x] 定义多工具顺序执行、前项成功后继续、失败即停止和每轮最多四项；
- [x] 完成 tool catalog、protocol payload、result schema 与 golden intent 的一致性内部审查；

实际结果（2026-08-15）：tool catalog、按工具分派的精确 result schema、错误码和 32 条中文黄金
场景已落到 `contracts/tools/v1/`；场景覆盖全部房间和工具、七组以上有序多工具调用，以及否定、
歧义、未知房间和越界能力的 no-tool 判定。catalog、protocol completed payload 与 tool result 的
分派定义由测试交叉核对。Tool Schema v1 已于 2026-08-15 与 Device Protocol v1 一并冻结；
破坏性变更必须进入 Tool Schema v2。

### P0.7 建立合约测试

- [x] 为 simulator/fake backend 增加 protocol peer；
- [x] 验证合法消息、非法 schema、重复 action_id、超时、取消；
- [x] 验证断线重连后 full snapshot；
- [x] 验证队列满时 reject；
- [x] 测试不依赖 Ollama 和真实 P4。

实际结果（2026-08-15）：`./scripts/validate-agent-contracts.sh` 的 30 项标准库测试通过；新增覆盖认证
失败、TLS 边界、相对 timeout 上下限、跨 session 幂等与过期、action ID 冲突、显式 resync、seq gap、
五类精确结果、fixture 生命周期一致性，以及多工具等待前项终态和失败即停止；
详见 [contract test evidence](../../../../evidence/agent-phase-0/contract-tests.md)。

### P0.8 固化硬件证据 harness

- [x] 恢复 ESP32-P4 自托管 build/flash/serial workflow；
- [x] 固定 artifact 名称与 `monitor.log`、`hardware-validation-manifest.json` 契约；
- [x] workflow 只负责传输证据，不用日志 grep 代替功能判定；
- [x] 将私密硬件配置限制在 GitHub Secret 或 runner 本机配置，不写入仓库；
- [x] 在 `feature/agent-harness` 的精确提交上完成一次 7,200 秒 workflow 回归并验证 artifact 完整性。

实际结果（2026-08-15）：workflow 与操作说明已恢复并按当前 artifact contract 更新，YAML 解析通过；
本地与 runner 已统一使用无交互 TTY 的原始串口采集脚本。远端 run
[`31873307218`](https://github.com/shenqislx/p4home/actions/runs/31873307218) 完成 checkout、输入校验和
私密配置加载，但 build 因严格 shell 下用户级激活脚本读取未设置的 `$1` 失败，判定为
`infra-fail`，其 artifact 不能作为功能通过证据。修复已提交为本地 `d05eaa0` 并通过严格 shell 构建、
烧录和启动验证。随后进一步修复私密全量 sdkconfig 覆盖仓库 defaults 的配置漂移，并在 manifest 增加
实际 main stack 配置；因 `github.com:443` 接收超时尚未同步远端，精确 SHA 的 7,200 秒 workflow 仍待重跑。
配置合并器的 2 项单测与合并后全新固件构建均已通过；workflow 会在 build 前运行同一组单测，并动态
核对最终配置与 `firmware/sdkconfig.defaults` 的 main stack 基线一致。
精确 SHA `c51fa4a` 的 run
[`31875154927`](https://github.com/shenqislx/p4home/actions/runs/31875154927) 已通过 checkout、harness 单测和
私密配置合并，但因仓库忽略 dependency lock 而解析到 `esp_hosted 3.0.6`，SDIO Kconfig 不兼容，仍判为
`infra-fail`；flash/capture 未执行。

依赖锁修复后的精确 SHA `b0aa443374360324a4a27dcc5a38c0a1849b0b45` 已由 run
[`31875576865`](https://github.com/shenqislx/p4home/actions/runs/31875576865) 完成正式回归，三层结论如下：

- workflow 状态：`completed/success`，build、flash、7,200 秒 capture、manifest 检查和 artifact 上传全部成功；
- artifact 完整性：通过；manifest SHA-256 为
  `cc2f5b25db3e2a68339efcf53925a604e328aa356e325e7e96f94e7b6ca72e30`，`monitor.log` SHA-256 为
  `507287844bcbe88932d53b3aeec0bd861b2a6499ce9963a5d0a6f05708d19b4a`；manifest 的 run id、job、
  精确 git SHA、7,200 秒时长、5,120 B main stack 与仓库 dependency lock 哈希均匹配；
- 功能判定：通过；两小时窗口内 HA、Pixel Home、资源和故障指标均满足 P0.4 基线。

manifest 同时记录 app image 为 `1,448,448 bytes`，固件 SHA-256 为
`e36373e9b09ef73cd48422cd0da844a61bf85bd18ae31c184f45c8454c5ba507`，dependency lock SHA-256 为
`f5f93d246735422a250bbb10dabb05338481f1c21556deebb2881e72e2275860`。

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
- [x] Device Protocol v1 与 Tool Schema v1 review 通过；
- [x] fake contract tests 覆盖正常和关键故障路径；
- [x] 用户 review 后完成阻塞项修订，冻结 v1，将本计划归档并启动 Phase 1。
