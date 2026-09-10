# 识别失败状态清理与超时兜底

## 修复范围

本轮修复“失败后停留在正在识别”，不调整 VAD 阈值、采音长度、声学输入时序或半双工策略，
不宣称已经解决间歇性 `too_short` 的声学根因。之前失败复测见同目录 `2026-09-05-reflash-retest.md`。

1. Unified Voice Runtime 接收 STT 结果，把静音、过短、过长、空识别、服务错误、超时和取消
   映射为有身份绑定的 Conversation UI v1 终态。无用户 transcript，不调用 Role/TTS。
2. 新采音、断线和关闭均隔离旧失败回包；相同终态不重复发送。诊断回调抛错不能阻止终态处理。
3. 固件记录当前采音 epoch，拒绝旧 UI，并阻止较晚的本地 transcribing 通知覆盖已到达的远端终态。
4. 本地识别界面 125 秒超时兜底，使用单调时钟，不依赖 NTP。超时提示不参与远端 revision/ACK，
   不强制停止扬声器，也不会让 Human 永久保持会话活跃。新一轮采音重置期限，远端进展解除计时。

## 本地验证

- 完整 Agent 回归 552/552；TypeScript typecheck 通过。
- 新增 7 类失败路径及新 epoch/关闭隔离测试，覆盖故障日志回调不影响 UI 终态。
- 直接编译真实 conversation_service C 实现，测试 125 秒边界、下一轮恢复、旧 epoch、
  “远端失败先到、本地 transcribing 后到”以及 thinking 进展解除超时；通过。
- Phase 5 契约 31/31、Human 契约 3/3、ESP-IDF v5.5.4 构建及 diff check 通过。

## 实机验证

当前工作区 `5c0d160` 加未提交改动，Device Protocol 仍为 Human v3。
最终 app SHA-256：`7a0c5f1e5706a1c52890f3281bafbd16eca16095413990b0a627872eae6dea68`。
最终 ELF SHA-256：`02ce6f36762ec3fd4fc8404da873c67018e6bc3f633e68e0a997000212e80863`。
USB `/dev/cu.usbserial-210` app-flash 回读哈希验证通过；常驻 Agent 已重新加载。
中间版本仅用于烧录准备，没有计入最终验证。

原始私有证据：`evidence/voice-review-20260905/recognition-recovery.6FrFoV/`，以
`hardware-validation-manifest.json`、`final-flash.log`、`final-monitor.log`、`acoustic.json` 为准。

实机结果分开记录，不能视为全部验收通过：

- 首次最终版本启动受 HA 初始同步阻塞，未进入声学用例；该次结论为 inconclusive。
- 受控重启后 HA 就绪，三次仅播放唤醒词均产生识别和回答，分别完成 4、3、4 个播放段；
  因未触发空识别失败，不能作为失败提示分支的验证。证据在
  `evidence/voice-review-20260905/recognition-recovery-retry.BeacyY/`。
- 无复位故障探测临时暂停本项目 STT 工作进程，触发的是模型预热超时；服务自行回收该进程，
  新进程完成识别，界面从 transcribing 进入 thinking/completed，完成 1 个播放段，无丢帧、
  崩溃或非预期复位。该次仍未触发识别失败终态，结论为 inconclusive，不能记为失败提示通过。
  证据在 `evidence/voice-review-20260905/recognition-fault.pZnzUz/`。
- 准备调整为模型就绪后注入故障，但启动新一轮串口取证的权限审核连续两次超时，测试未启动。
  原暂停进程已被回收，没有遗留暂停状态；本轮没有再次重启或烧录设备。

本地 125 秒兜底边界测试通过，但尚无实机触发兜底或失败终态后重新唤醒的闭环证据。
真人听感及肉眼确认仍单独待验收；间歇性识别过短和唤醒词被当成输入的问题不在本轮已解决范围。
代码及证据未提交、未推送。
