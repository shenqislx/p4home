# Phase 3D Simulator & Hardware Gate Evidence

日期：2026-08-20

## 当前结论

本地 simulator 与静态/host 门禁通过；真实 ESP32-P4 功能结论在专用 workflow artifact 审阅前为
`inconclusive`，不能用本地构建或 workflow 配置替代。

## 本轮修复

- Pixel Home renderer 读取权威对象 target、room-local anchor、facing、pose 与 active animation；
- 新增左右朝向的 object idle/walk、sit、look、paw 像素帧，保持 4x nearest-neighbour 与 8 FPS；
- 完整 LVGL simulator 增加 `--verify-object-gate`，核对 sofa/desk 的全局 anchor、左右朝向、坐姿、
  四个 animation binding、取消恢复与 `OBJECT_OCCUPIED`；
- WebSocket receive callback 不再持锁同步完成动作；worker 异步推进，并给对象动作保留 250 ms
  渲染/取消窗口；
- local fallback 接管时释放旧对象占用与 target，避免 Agent 离线后对象和 HA 房间状态矛盾；
- 新增 `phase3d_object` 硬件 profile，使用 Device Protocol v2、一次性 TLS 凭据和确定性 Cat
  `go_to(living_room.sofa) → sit` harness；harness 还核对 reconnect snapshot 与 started 后取消。

## 本地证据

完整 simulator/host CTest：3/3 通过，关键输出：

```text
VERIFY:phase3d:sim_object_anchor:PASS targets=sofa,desk facing=right,left
VERIFY:phase3d:sim_object_pose:PASS pose=sitting floor_anchor=stable
VERIFY:phase3d:sim_animation_bindings:PASS animations=walk,sit,look,paw fps=8
VERIFY:phase3d:sim_cancel:PASS restored=sitting
VERIFY:phase3d:sim_occupancy_conflict:PASS error=OBJECT_OCCUPIED
```

其余本地门禁：

- Node 24.19 strict typecheck：通过；
- Agent tests：139/139 通过；
- Python contract：58/58 通过；
- Python hardware helper：4/4 通过；
- ESP32-P4 `agent_transport.c` 与 `ui_home_actor.c` 使用已配置 IDF 编译命令单文件编译：通过；
- fresh ESP-IDF configure：受当前 sandbox 禁止 `psutil` 枚举进程影响，不能在本地完成；最终全量
  build/link 由 self-hosted hardware workflow 验证。

## 实机 artifact 判定要求

必须先确认 manifest 的 `git_sha`、run id、`validation_profile=phase3d_object`、采集时长、固件镜像
SHA-256 与 dependency lock，再读取非空 `monitor.log`。`pass` 至少需要无矛盾地同时出现：

```text
VERIFY:phase3d:device_object_action:PASS action=go_to target=living_room.sofa pose=standing
VERIFY:phase3d:device_object_action:PASS action=sit target=living_room.sofa pose=sitting
VERIFY:phase3d:ui_object_state:PASS target=living_room.sofa facing=right pose=sitting
VERIFY:phase3d:object_action_chain:PASS target=living_room.sofa pose=sitting occupied=true
VERIFY:phase3d:reconnect_snapshot:PASS ... target=living_room.sofa pose=sitting occupied=true
VERIFY:phase3d:device_object_cancel:PASS
VERIFY:phase3d:object_cancel:PASS error=CANCELLED
VERIFY:phase3d:ui_agent_offline:PASS released_target=living_room.sofa
VERIFY:ui:8fps:PASS
```

同时不得出现相关 `VERIFY:*:FAIL`、assert、watchdog、stack overflow、brownout，且基础 HA/UI marker
必须继续存在。workflow 绿色只代表 transport artifact 成功，不是本项功能结论。
