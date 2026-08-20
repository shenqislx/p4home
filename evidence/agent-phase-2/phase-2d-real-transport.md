# Phase 2D Real Transport & Hardware Gate Evidence

> Date: 2026-08-20
> Runtime: Node.js 24.19.0
> Firmware: ESP-IDF v5.5.4 / ESP32-P4
> Hardware verdict: `pass`; run `32262619021`, commit `91aa3e58d24fee48e40d98d159485717f1a4252a`

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

## 实机门禁结果

`Firmware Self-Hosted Flash Serial` 新增 `phase2d_agent` profile。runner 会在临时目录生成一次性
P-256 TLS 证书、256-bit device token 与 SPKI pin，覆写到私密 sdkconfig 后启动真实 Runtime Hub。
硬件 harness 执行 100 次 Cat 房间动作，在第 50 次后由 server 主动断线并验证 reconnect full
snapshot，再关闭 Agent 并继续采集完整两小时。manifest 会记录 profile、实际 capture 时长、harness
状态与无敏感字段的延迟摘要；业务 marker 仍由 Codex 从 artifact 判定，workflow 绿色本身不代表通过。

2026-08-20，GitHub Actions
[run 32262619021](https://github.com/shenqislx/p4home/actions/runs/32262619021) 完成并成功上传
`esp32-p4-monitor-log`。manifest 与 run 身份、仓库基线和 Phase 2D profile 一致：

| 检查 | 结果 | Artifact 证据 |
|---|---:|---|
| Workflow transport | 通过 | build、flash、7,500 秒 capture、manifest、artifact upload 全部 success |
| Artifact identity | 通过 | `git_sha=91aa3e5...`、`run_id=32262619021`、`run_attempt=1` |
| Profile / duration | 通过 | `validation_profile=phase2d_agent`、`monitor_seconds=7200`、`capture_seconds=7500` |
| Build baseline | 通过 | app `1,471,088` bytes；main stack `5,120` bytes；dependency lock SHA-256 与仓库一致 |
| 100 次真实动作 | 通过 | `actions_completed=100`，accepted/started/completed 最大延迟均小于 `595 ms` |
| 中途重连与 snapshot | 通过 | 第 50 次动作后重连，`reconnect_snapshot_version=102` |
| Agent 离线两小时 | 通过 | 设备在 `offline_ms=7,228,791` 时输出 fallback PASS，HA 同时保持 `READY` |
| 资源与 UI | 通过 | 891 个 8 FPS PASS；main/agent worker stack high-water 为 `800/2044` bytes；heap/PSRAM 稳定 |

三条目标强 marker 均出现且无矛盾证据：

```text
VERIFY:agent_transport:cat_action_chain:PASS actions=100 accepted_max_ms=589.862... started_max_ms=592.173... completed_max_ms=594.618...
VERIFY:agent_transport:reconnect_snapshot:PASS state_version=102
VERIFY:agent_transport:offline_2h_fallback:PASS
```

串口日志只有一次 `POWERON` 启动，未出现 panic、watchdog、brownout、assert 或重启。启动阶段的首个
8 FPS 周期为 `10,205 ms`，并在 SNTP 尚未同步时各产生一次 FAIL；随后 UI 连续 891 次 PASS，SNTP
在 `36.631 s` 输出 PASS。两者均为启动瞬态，不反证 Agent 动作、重连或两小时 fallback 门禁。
周期 diagnostics 从动作完成后到采集结束持续保持 `completed=100`、`failed=0`、
`protocol_errors=0`，最终 HA 仍为 `READY`、`reconnect=0`。

据此，workflow status 为 `success`，artifact integrity 为 `valid`，Phase 2D functional verdict 为
`pass`。2D 退出门禁已满足；2026-08-20 用户确认 Phase 2 最终 review 通过，Phase 2 已完成。
Phase 3 保持 `pending`，不会由本次收口自动启动。
