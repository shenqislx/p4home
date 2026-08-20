# Phase 3A Object Registry Contract Evidence

> Date: 2026-08-20
> Runtime: Node.js 24.19.0
> Firmware: ESP-IDF v5.5.4 / ESP32-P4
> Verdict: `pass`

## 完成范围

Phase 3A 新增冻结的 World Object Registry v1，首批稳定对象为 `living_room.sofa`、`study.desk` 与
`living_room.window`。每个对象包含 room ownership、内部 art anchor、supported actions、默认可用性
和逐动作 animation binding；对象 ID 使用房间限定名，显示文案不作为协议键。

Agent 通过 TypeScript loader 使用 JSON Schema 和本地不变量复验注册表；公共 API 不导出原始
注册表，只根据 P4 提供的完整实时可用性投影 `object_id`、`room_id`、`supported_actions` 与
`available`。anchor、默认可用性和 animation binding 不进入模型侧 capability projection。P4
`world_service` 组件新增零动态分配的只读 C 注册表、lookup、action support 与 binding 查询；3A
没有开放对象执行 Tool，也没有修改冻结的 Device Protocol v1 / Tool Schema v1。

## 验证结果

| 检查 | 结果 |
|---|---:|
| Node 24.19 TypeScript strict typecheck | 通过 |
| Agent 全量确定性测试 | 120/120 |
| Python contract tests | 48/48 |
| `-Wall -Wextra -Werror` world host test | 1/1 |
| ESP-IDF v5.5.4 固件对象编译与 ELF 增量链接 | 通过 |
| ESP-IDF v5.5.4 全量固件构建 | 3A 初始实现通过；本轮重跑受沙箱限制 |
| 固件体积 | `0x164d40`，3 MiB app 分区剩余 54% |

专项测试覆盖稳定顺序、精确容量、重复 ID、room-qualified ID、anchor 边界、动作规范顺序、binding
完整性与动作-动画精确映射、防御性 projection、实时可用性完整性、公共 API 无原始执行元数据、
JSON/TypeScript/C 严格一致性、固件 lookup 与不支持/越界动作。Agent WebSocket 测试本轮直接通过。
ESP-IDF 全量构建重跑仍因沙箱禁止 `psutil` 读取系统进程列表而停在配置阶段；复用已配置构建目录后，
本轮修改的 RISC-V 固件对象编译和最终 ELF 增量链接均通过。3A 初始实现的完整全量构建记录仍有效。

据此，3A 退出门禁满足，可以进入 3B P4 Object Runtime。对象级 Tool、真实传输和实机动作尚未
实现，因此不得把本证据描述为 Phase 3 整体完成。
