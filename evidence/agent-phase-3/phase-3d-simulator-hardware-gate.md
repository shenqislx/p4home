# Phase 3D Simulator & Hardware Gate Evidence

日期：2026-08-20

## 当前结论

`pass`。本地 simulator/host、目标硬件配置全量构建与真实 ESP32-P4 artifact 均已通过。最终判定
基于 run `32382940058`、提交 `8287476726a6c22b0f88ed88925d454cfe61ce32`；workflow 绿色本身
未被当作功能证据。

## 本轮修复

- Pixel Home renderer 读取权威对象 target、room-local anchor、facing、pose 与 active animation；
- 新增左右朝向的 object idle/walk、sit、look、paw 像素帧，保持 4x nearest-neighbour 与 8 FPS；
- 完整 LVGL simulator 增加 `--verify-object-gate`，核对 sofa/desk 的全局 anchor、左右朝向、坐姿、
  四个 animation binding、取消恢复与 `OBJECT_OCCUPIED`；
- WebSocket receive callback 不再持锁同步完成动作；worker 异步推进，并给对象动作保留 250 ms
  渲染/取消窗口；
- 短暂传输中断保留权威对象 snapshot 10 秒供自动重连，超过窗口后 local fallback 才释放旧对象
  占用与 target，兼顾 reconnect 一致性与离线 HA/UI 接管；
- 修复失败重连反复重置 10 秒离线宽限、导致 fallback 永不到期的问题；只有已认证连接真正断开才
  启动一次宽限，失败重连不能延长它，宽限到期时 Agent 连接状态、对象 target 与占用原子释放；
- fake-device 的 started、活动取消/超时与只读完成现在和 P4 一样推进 `state_version` 并发送
  `world.changed`，避免 3C 断线对账建立在较弱的假状态机上；
- 幂等缓存重放不再输出 `device_object_action/device_object_cancel` 强 marker；静态 object-idle 不再每个
  8 FPS tick 重复 invalidation；object go-to 在终态 anchor 发布前持续渲染 walk binding；
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
- Agent tests：140/140 通过；
- Python contract：58/58 通过；
- Python hardware helper：4/4 通过；
- ESP32-P4 `agent_transport.c` 与 `ui_home_actor.c` 使用已配置 IDF 编译命令单文件编译：通过；
- ESP-IDF v5.5.4 使用私有目标硬件 sdkconfig 在临时目录全量 build/link：通过，固件约 1.48 MB，
  app 分区剩余 53%；self-hosted workflow 对最终提交再次完成相同构建与烧录。

## 实机证据

manifest-first 核对结果：

- run `32382940058` / attempt `1`，`git_sha=8287476726a6c22b0f88ed88925d454cfe61ce32`；
- `validation_profile=phase3d_object`，Device Protocol v2，串口 `/dev/cu.usbserial-210`，采集 240 秒；
- 固件 `1482304` bytes，SHA-256
  `393cbdac855c63d9ef6c8ff57d757d37e376553701b92fa96303926d76c2dec5`；
- main task stack `5120` bytes，Agent task stack `12288` bytes，dependency lock SHA-256 与仓库一致；
- harness status `0`，动作终态延迟约 `438.9/407.4 ms`，取消结果 `CANCELLED`。

串口与 harness 强证据：

```text
VERIFY:phase3d:device_object_action:PASS action=go_to target=living_room.sofa pose=standing
VERIFY:phase3d:device_object_action:PASS action=sit target=living_room.sofa pose=sitting
VERIFY:phase3d:ui_object_state:PASS target=living_room.sofa facing=right pose=sitting
VERIFY:phase3d:device_object_cancel:PASS action_id=hardware-phase3d-action-cancel
VERIFY:phase3d:device_agent_offline:PASS released_target=living_room.sofa state_version=9
VERIFY:phase3d:ui_agent_offline:PASS released_target=living_room.sofa fallback_room=客厅
VERIFY:phase3d:object_action_chain:PASS target=living_room.sofa pose=sitting occupied=true
VERIFY:phase3d:reconnect_snapshot:PASS state_version=6 target=living_room.sofa pose=sitting occupied=true
VERIFY:phase3d:object_cancel:PASS error=CANCELLED
```

离线释放发生在设备启动后 `24.462 s`，UI 于 `24.492 s` 消费同一终态。240 秒内持续出现
`VERIFY:ui:8fps:PASS denied=0`；Agent worker 最低剩余栈 `1964` bytes，HA worker `4084` bytes，
HA 最终为 `READY`，时间同步为 `PASS`。日志未出现 Guru Meditation、panic、assert、watchdog、
stack overflow/protection、brownout 或 abort。

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
VERIFY:phase3d:device_agent_offline:PASS released_target=living_room.sofa
VERIFY:phase3d:ui_agent_offline:PASS released_target=living_room.sofa
VERIFY:ui:8fps:PASS
```

同时不得出现相关 `VERIFY:*:FAIL`、assert、watchdog、stack overflow、brownout，且基础 HA/UI marker
必须继续存在。workflow 绿色只代表 transport artifact 成功，不是本项功能结论。
