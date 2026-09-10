# Phase 5 收尾：HA 首包读取与识别失败恢复

日期：2026-09-09。工作分支：`feature/agent-harness`。本轮使用本地 USB 刷写与连续串口采集，
没有 GitHub Actions run，也没有向远端推送。机器证据和人工观察分别记录。

## HA 前置阻塞与修复

第一轮刷写上一轮构建的识别期限修复，app 回读哈希通过；但 HA 连续握手重试，声学探测等待
240 秒仍未就绪，未开启故障注入。该轮为 `inconclusive`，私有目录为
`evidence/voice-review-20260909/closure/`，保留 manifest、flash、monitor 和 probe 记录。

检查固定 ESP-IDF v5.5.4 源码发现：`ws_connect()` 已保存 HTTP Upgrade 响应后一起到达的
WebSocket 字节，但 `ws_poll_read()` 和 `ws_read_header()` 仍先等待底层 socket。若首个
`auth_required` 全部进入缓存而对端等待鉴权，没有新网络数据唤醒读取，就会卡住握手。

本地 C harness 直接编译这几个真实 SDK 接收函数，以“缓存已有完整 auth_required、网络无新
数据”分别复现两个入口失败。修复后完整缓存、部分缓存接网络、缓存为空时的超时/错误、普通
网络帧均通过。SDK 来源变化会被 SHA-256 校验拒绝，不会默默套用未经 review 的补丁。

修复由 `firmware/cmake/ws-buffer-readiness.cmake` 在构建目录生成源文件副本，替换
tcp_transport target 的原 `transport_ws.c`；全局 SDK 和 managed components 均未修改。
编译命令已确认只有这一份生成的 WebSocket 源文件参与构建。

## 本地验证

- 新 SDK 缓存读取回归 3/3，通过原始行为复现与修复后验证。
- Phase 5 契约 31/31；相关 C/Python harness 合计 14/14。
- ESP-IDF v5.5.4 / ESP32-P4 产品固件构建通过，diff check 通过。
- Agent 源码未在本轮修改；同一源码此前全量复验 552/552、typecheck 通过，见
  [识别期限修复记录](./2026-09-09-recognition-deadline.md)。

## 修复后实机取证

私有证据目录：`evidence/voice-review-20260909/closure-ws-fix/`。

| 产物 | SHA-256 |
| --- | --- |
| app bin | `d9b39661ddbd03ad274f31352d45b488822d129af280692989bef733c9972855` |
| ELF | `87388ae6dcf8a8c5bcdd56ec96d3eb0ba44442c9ebf8d3424f39b091129628f1` |
| 受测 SDK `transport_ws.c` | `281a84a82c1e00f0198204a0ea80b981090fc3ec00b480ede3d79c9c5fc5bbfd` |

使用同一块 USB `/dev/cu.usbserial-210` ESP32-P4，app 位于 `0x10000`；不改 bootloader、
分区表、NVS 或模型分区。烧录工具回读哈希通过，受测源文件哈希写入 manifest。
串口覆盖受控启动，但日志等级没有打印 ELF 哈希；不声称拥有未采集的启动哈希证据。

最终机器结论：`pass`，范围为 HA 首次就绪、远端 STT 超时 UI 终态与下一轮唤醒恢复。

| 用例 | epoch | 结果 |
| --- | --- | --- |
| 正常基线 | 11403265 | UI/audio completed，1 段播放完成；capture 打开后约 18.931 秒完成 |
| 暂停已预热 STT | 11403266 | timed_out，UI failed 且 revision 1 applied；约 126.904 秒；未调用 Role/TTS |
| 无重启恢复 | 11403267 | UI/audio completed，2 段播放完成；约 16.098 秒；没有旧失败状态回退 |

以上耗时从 capture 打开后的探测点计到整轮完成，包括测试口播，不是模型加载或首字延迟。

- HA 约启动后 42.996 秒完成 36 项初始同步，后续采样一直 READY、reconnect=0；相比
  首轮握手持续失败，本轮首次连接即成功。`service_calls=0` 仅覆盖该 P4 客户端。
- `monitor.log:174`：HA initial_sync_ready；`:279–280`：故障轮 failed UI 和 applied ACK；
  `:292`：下一轮 capture；`:309`、`:311`：恢复后的两段播放 completed/dropped=0。
- `monitor.log:313` 开始结束后 60 秒观察，总采集 278 秒。零 panic/watchdog/assert/backtrace，
  仅一次受控启动 reset；新 epoch 后无旧故障 epoch 的 UI 更新。
- 故障注入只暂停 Agent 59919 的已就绪 STT 子进程 89142，另设 150 秒独立恢复守护。
  超时后旧进程由 provider 回收；最终只读核验旧 PID 不存在、新 STT PID 89603 正常运行。
- 机器声学输入来自 Mac Tingting，经实际扬声器/P4 麦克风；不向协议直接注入 transcript。
- 本轮由服务端 120 秒超时发送 failed UI，未触发设备本地 125 秒兜底；后者仍只有本地 C
  边界回归证据，不能把本轮当作设备兜底实机通过。

用户表示可以观察，但尚未明确确认重试提示、屏幕和尾音均正常；这些人工项保持待确认。
随后用户明确反馈 LLM 加载速度太慢，希望尝试更小的 Qwen3 模型。因此响应体验不关闭，
下一步转为小模型的冷加载、首字延迟、热态吞吐与现有角色/工具门禁对比。Phase 5 继续保持
`pending_real_environment`，不因故障恢复机器通过而整体关闭。
