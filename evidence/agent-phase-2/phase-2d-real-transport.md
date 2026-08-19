# Phase 2D Real Transport Software & Hardware-Gate Preparation Evidence

> Date: 2026-08-19
> Runtime: Node.js 24.19.0
> Firmware: ESP-IDF v5.5.4 / ESP32-P4
> Hardware verdict: pending; no artifact has been interpreted yet

## 当前完成范围

本轮已实现 Agent 侧真实 TLS WebSocket server、稳定的 per-device Runtime Hub，以及 P4 独立
`agent_transport`。真实网络测试覆盖
`test.room_target → Cat Event Policy → Cat 模型 ToolCall → action.request → accepted / started /
completed → world.changed`，并在断线后复用同一 adapter，通过新的 hello/capabilities/full snapshot
恢复权威状态。该测试使用本机 loopback WebSocket 与确定性 Cat provider，不替代 P4 实机。

传输边界固定为 `/v1/device`：非 loopback 必须 TLS，P4 以配对 SPKI SHA-256 pin 验证 server，
Agent 在 HTTP upgrade 前校验单设备 Bearer token 与 `X-P4-Device-ID`。token 不进入协议 JSON 或日志，
双方都执行 16 KiB 文本帧上限；二进制帧、错误 session/sequence 与未完成握手均 fail closed。
Agent 侧协议违规会关闭坏连接，P4 侧不可恢复的 frame/sequence 错误会在 worker 中重启 WebSocket，
不会从 event callback 调用禁止的 stop API。

固件传输与 HA client 不互相依赖。`world_service` 先初始化，Agent transport 随后启动，HA client
仍按原链路初始化；Agent 离线时 `world_service_set_agent_connected(false)` 恢复既有本地 fallback。
动作请求由独立 mutex 串行进入容量 8 的 world action 状态机，保留 deadline、cancel、幂等缓存与
snapshot reconciliation 语义。

## 软件验证结果

| 门禁 | 结果 | 当前证据 |
|---|---:|---|
| 真实 WebSocket 鉴权、动作闭环、重连 | 通过 | loopback 集成测试 2/2；未鉴权和原型键身份在 upgrade 前拒绝 |
| Cat 产品入口到真实 transport | 通过 | `runCatRoomTargetEvent()` 经 Runtime Hub 获得 lifecycle completed 和 state_version 2 |
| 协议错误恢复 | 通过 | binary frame 1003、握手超时 1008、adapter 协议违规 1002；P4 安排 stop/start 重连 |
| 冻结协议与分层 | 通过 | Python contract 42/42 |
| workflow 私密配置 helper | 通过 | harness helper 4/4；输出文件 mode 0600，拒绝 ws/query/短 token/非法 pin |
| World 状态机 host 回归 | 通过 | 1/1，AppleClang 严格构建 |
| Agent 全量回归 | 通过 | Node 24.19.0，115/115，严格 TypeScript 检查通过 |
| ESP-IDF 默认配置构建 | 通过 | image `0x164d40`，3 MiB app 分区剩余 54% |
| ESP-IDF Agent-enabled 构建 | 通过 | 临时 TLS/token/pin 配置，image `0x164f20`，分区剩余 54% |

本机已安装的 GCC 14.2 工具日期为 `20251107`，IDF v5.5.4 清单期望 `20260121`；两次构建均成功，
但该工具版本 warning 不作为实机证据。自托管 workflow 仍通过仓库统一 IDF 激活入口构建。

提交前 review 进一步将固件的物理 socket 与“完整三帧握手后可用”状态分离，避免 worker heartbeat
插入 hello/capabilities/snapshot；Agent 发送失败会先固定 unknown outcome 再断线，已完成的握手也会
立即注销 handshake timeout。workflow harness 改为从 `agent/` workspace 启动，已验证 `tsx` 与
workspace package 可以正确解析。

## 实机门禁准备

`Firmware Self-Hosted Flash Serial` 新增 `phase2d_agent` profile。runner 会在临时目录生成一次性
P-256 TLS 证书、256-bit device token 与 SPKI pin，覆写到私密 sdkconfig 后启动真实 Runtime Hub。
硬件 harness 计划执行 100 次 Cat 房间动作，在第 50 次后由 server 主动断线并验证 reconnect full
snapshot，再关闭 Agent 并继续采集完整两小时。manifest 会记录 profile、实际 capture 时长、harness
状态与无敏感字段的延迟摘要；业务 marker 仍由 Codex 从 artifact 判定，workflow 绿色本身不代表通过。

待实机 artifact 同时出现且无矛盾证据后，2D 才可完成：

```text
VERIFY:agent_transport:cat_action_chain:PASS actions=100 ...
VERIFY:agent_transport:reconnect_snapshot:PASS ...
VERIFY:agent_transport:offline_2h_fallback:PASS
```

还必须结合周期 diagnostics 核对 heap/internal RAM/PSRAM、main 与 agent worker stack，以及持续的
UI 8 FPS 心跳。当前尚未触发该长跑，Phase 2 仍为 `in_progress`，不能进入 Phase 3。
