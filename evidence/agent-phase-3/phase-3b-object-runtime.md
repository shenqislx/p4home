# Phase 3B P4 Object Runtime Evidence

> Date: 2026-08-20
> Runtime: Node.js 24.19.0
> Firmware: ESP-IDF v5.5.4 / ESP32-P4
> Verdict: `pass`

## 完成范围

P4 `world_service` 已成为对象位置、朝向、姿态、占用和可用性的唯一运行时权威。对象动作
`character.go_to`、`character.sit`、`character.look_at` 与 `character.interact` 复用 Phase 2 的单队列、
相对 deadline、幂等记录、取消和终态缓存；对象不存在、不支持动作、不可用、被占用与未到达均返回
稳定错误码。执行开始时 P4 内部 snapshot 记录 active animation，完成后由对象 anchor 确定性更新位置，
Agent 或 UI 不提供目标坐标。

新增独立 Device Protocol v2 与 Tool Schema v2 candidate。v2 是 v1 的严格顺序超集，capabilities 和
snapshot 只发布稳定对象 ID、房间、支持动作、实时可用性/占用与角色姿态，不包含 anchor、坐标、
朝向或动画名。`agent_transport` 默认仍选择 v1；只有显式配置 v2 才发布对象 capabilities、解析对象
动作和发送对象 snapshot。对象请求拒绝 `origin=user`，现有 RoleProfile 也尚未获得对象 Tool，角色
接入留在 3C。复审后，原始 JSON Schema 也会独立约束注册表顺序、房间归属、支持动作、目标/姿态、
对象动作结果和错误 retryable 语义；不会只依赖 TypeScript 辅助校验器阻止漂移。

## 确定性场景

独立 host runtime 覆盖：未知对象、不支持 `sit` 的 desk、不可用 window、被占用 window、未到达
对象、四种成功动作、动作-动画精确映射、坐下占用、移动释放占用、执行中取消、deadline、重复
action id、action id 参数冲突，以及对象在排队后或动作启动后变为不可用/被占用时的三阶段重验与
权威状态回收。host 二进制同时通过 AddressSanitizer 与 UndefinedBehaviorSanitizer。

## 验证结果

| 检查 | 结果 |
|---|---:|
| Node 24.19 TypeScript strict typecheck | 通过 |
| Agent 全量确定性测试 | 123/123 |
| Device Protocol v2 AJV gate | 6 valid / 9 invalid messages |
| Tool Schema v2 AJV gate | 4 valid / 7 invalid results / 9 tools |
| Python contract tests | 54/54 |
| `-Wall -Wextra -Werror` host tests | 2/2 |
| ASan + UBSan host tests | 2/2 |
| ESP-IDF world_service + agent_transport RISC-V 对象编译 | 通过 |
| 显式 Device Protocol v2 agent_transport RISC-V 编译 | 通过 |
| ESP-IDF 最终 ELF 增量链接 | 通过 |

当前沙箱仍禁止 ESP-IDF component manager 通过 `psutil` 枚举系统进程，因此没有重复运行全量配置；
本轮所有变更组件均已使用 ESP32-P4 RISC-V 工具链重新编译并完成最终 ELF 链接。完整全量构建的
3A 基线仍有效。

据此，3B 退出门禁满足，可以进入 3C Cat Object Event & Role Boundary。当前 v2 契约仍标记为
Phase 3B candidate，须在 3C 完成 Agent 适配、Cat 策略、审计与 fake-device 断线对账后再冻结；不得
把本证据描述为 Phase 3 整体完成或实机对象动作已通过。
