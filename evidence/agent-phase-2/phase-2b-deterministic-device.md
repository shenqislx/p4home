# Phase 2B Cat Action Adapter & Deterministic Device Evidence

> Date: 2026-08-18
> Runtime: Node.js 24.19.0
> Device: Agent 进程内 deterministic fake device
> Real P4 / Home Assistant / network: 未连接

## 验收范围

本纵切只验证 Cat 的归一化测试事件、Agent 侧 Device Protocol v1 adapter 和确定性设备端状态机，
不修改 P4 固件、`world_service`、真实 WebSocket 鉴权或现有 HA 链路。`test.room_target` 在
Cat Event Policy 通过后只向 Cat 模型暴露 `character.go_to_room`，模型返回的 ToolCall 必须与批准的
目标房间精确一致才会进入设备 adapter。确定性测试使用 fake provider，Run 审计记录
`model_turns=1`；尚未执行 live Cat 模型专项评测。

所有 Agent 和 fake device 的收发帧都经过冻结的 `message.schema.json` 校验和 16 KiB UTF-8
上限检查。adapter 只在 `device.hello → device.capabilities → world.snapshot` 完成后接收动作，
并限制同时等待的 action 数量。

## 退出门禁

| 门禁 | 结果 | 证据 |
|---|---:|---|
| 过期、越权、含用户原文的 event 在 WebSocket 前拒绝 | 通过 | 拒绝后 action request 计数不变，且不创建审计 Run |
| 相同 `action_id` 重发不产生第二次副作用 | 通过 | 收到 2 次 request，设备 execution count 为 1 |
| 连续 100 次 fake device 动作无静默丢失 | 通过 | 100 个 completed，100 个 execution count 均为 1，state_version 由 1 到 101 |
| accepted / started / completed / failed | 通过 | 自动与手动执行模式分别覆盖成功和失败终态 |
| queue full / deadline / cancel | 通过 | 第 9 个并发动作返回 QUEUE_FULL；取消返回 CANCELLED；过期动作无副作用 |
| 断线 unknown、重连 snapshot 对账且不盲重放 | 通过 | snapshot 只记录 state_satisfied/state_not_satisfied 证据，不伪造 action completed，request 计数不变；协调窗口内晚到的显式 action.completed 可恢复成功 |
| Cat Run 与 ToolCall / Action / Event 审计关联 | 通过 | SQLite trace 包含 Cat Run、模型批准 ToolCall、Action 与模型/终态事件，不保存用户原文 |
| seq gap / resync correlation | 通过 | 本地无效 frame 不消耗 seq；仅匹配 correlation_id 且 reason=resync 的 snapshot 可结束 resync |
| dispatch / lifecycle fail-closed | 通过 | 预取消动作不发送；live transport 的 in-band hello 被拒绝；与请求矛盾或改写既有终态的 completed 被拒绝 |
| 缓存边界 | 通过 | Event 去重、Agent Action 记录和 fake device 幂等记录均有 TTL/容量限制；保护期内达到容量时 fail-closed，不提前遗忘 ID；fake device 终态缓存按协议至少保留 600000 ms |

## 确定性测试

专项测试：

```text
tests 19
pass 19
fail 0
```

全量回归：

```text
tests 111
pass 111
fail 0
duration_ms 959.449833
```

严格类型检查通过：

```text
node v24.19.0
tsc --noEmit -p tsconfig.json
exit 0
```

仓库 `pnpm typecheck` 的运行时引导器在本环境尝试访问 `registry.npmmirror.com`，随后因无 TTY
拒绝清理 `node_modules`；为避免改动依赖树，本次使用同一 bundled Node 24.19.0 直接运行本地
TypeScript、tsx 和完整测试集。该环境问题没有被计为代码通过证据，最终门禁均来自本地已锁定依赖。

## 结论与后续边界

Phase 2B 的 deterministic fake device 退出门禁满足，可以进入 2C 的 host simulator、
`world_service` 和 UI 语义真值拆分。当前结果不能替代真实 WSS 鉴权、P4 固件状态机、资源指标或
实机连续动作证据；这些仍分别属于 2C/2D。由于冻结的 v1 snapshot 不包含动作终态历史，状态满足
只能作为 reconciliation evidence，不能证明某个 `action_id` 已完成。
