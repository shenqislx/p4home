# P4 Home World Object Registry v1

> Status: frozen for Phase 3A

`object-registry.json` 是对象 ID、房间归属和确定性执行元数据的单一版本化契约。对象 ID 必须是
room-qualified stable id；显示名不得作为协议键。

Agent 可获得的 capability projection 只包含：

- `object_id`
- `room_id`
- `supported_actions`
- `available`

`anchor` 与 `animation_bindings` 只供 P4 确定性执行和 UI 使用，禁止进入模型上下文。修改注册表必须
同步通过 JSON Schema、TypeScript loader、固件只读注册表和三者一致性测试；不得原地扩大已冻结的
Device Protocol v1 或 Tool Schema v1。
