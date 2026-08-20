# Phase 3A Object Registry Contract Evidence

> Date: 2026-08-20
> Runtime: Node.js 24.19.0
> Firmware: ESP-IDF v5.5.4 / ESP32-P4
> Verdict: `pass`

## 完成范围

Phase 3A 新增冻结的 World Object Registry v1，首批稳定对象为 `living_room.sofa`、`study.desk` 与
`living_room.window`。每个对象包含 room ownership、内部 art anchor、supported actions、默认可用性
和逐动作 animation binding；对象 ID 使用房间限定名，显示文案不作为协议键。

Agent 通过 TypeScript loader 使用 JSON Schema 和本地不变量复验注册表，并只投影 `object_id`、
`room_id`、`supported_actions` 与 `available`。anchor 和 animation binding 不进入模型侧 capability
projection。P4 `world_service` 组件新增零动态分配的只读 C 注册表、lookup、action support 与 binding
查询；3A 没有开放对象执行 Tool，也没有修改冻结的 Device Protocol v1 / Tool Schema v1。

## 验证结果

| 检查 | 结果 |
|---|---:|
| Node 24.19 TypeScript strict typecheck | 通过 |
| Agent 全量确定性测试 | 119/119 |
| Python contract tests | 47/47 |
| `-Wall -Wextra -Werror` world host test | 1/1 |
| ESP-IDF v5.5.4 全量固件构建 | 通过 |
| 固件体积 | `0x164d40`，3 MiB app 分区剩余 54% |

专项测试覆盖稳定顺序、重复 ID、room-qualified ID、anchor 边界、动作规范顺序、binding 完整性、
防御性 clone、无坐标 Agent projection、JSON/TypeScript/C 一致性、固件 lookup 与不支持动作。
Agent WebSocket 两项测试首次在沙箱内因禁止监听 `127.0.0.1` 返回 `EPERM`；在授权的本地执行环境
重跑后全量 119/119 通过。ESP-IDF 首次配置同样因沙箱禁止 `psutil` 读取进程列表失败；授权重跑后
完整构建通过，均不是代码或契约失败。

据此，3A 退出门禁满足，可以进入 3B P4 Object Runtime。对象级 Tool、真实传输和实机动作尚未
实现，因此不得把本证据描述为 Phase 3 整体完成。
