# 识别 UI 期限与迟到状态回退修复

日期：2026-09-09。范围：在现有未提交语音修复之上，收口 conversation service 的识别超时边界。
Phase 5 保持 `pending_real_environment`；v4 多角色保持 `proposed`。

## 问题与改动

直接编译真实 `conversation_service.c` 的回归复现：本地进入 transcribing 后，同一 epoch 的
远端 transcribing 更新会清除 `recognition_started_us`。即使累计已经到达 125 秒，期限检查
仍返回 false；重复更新可以持续延后重试提示。

本轮修复：

1. 本地识别与同轮远端 transcribing 共用期限，提高 revision 不重新计时。
2. 记录当前识别已超时；同轮迟到的远端 listening/transcribing 被拒绝，本地 transcribing
   通知被忽略，避免重试提示回退为识别中。真实 thinking、completed、failed 等进展仍按
   原有身份/revision 规则接收，不取消扬声器或改变角色执行结果。
3. 同一 epoch 的重复 begin 不重置期限或超时标记；远端新 epoch 先于本地 begin 到达时，
   后到的 begin 同样不能续期。过期 begin 被拒绝，真正的新 epoch 建立新期限。

## 本地验证

- 修复前新增回归在 `check_recognition_timeout(1425000000)` 断言失败，证明重复更新会使
  原始 125 秒期限失效；修复后相同测试通过。
- C harness 覆盖：125 秒前一微秒/准确边界、同轮多个远端 revision、超时后远端
  listening/transcribing、本地迟到 transcribing、真实 thinking 进展、重复 begin、
  新 epoch 恢复，以及远端进展先于本地 begin 的交错顺序。
- Phase 5 契约：31/31；识别恢复、DMA 排空、Voice/Agent 分片、TTS 模型与 worker
  harness 合计 11/11；TypeScript typecheck 通过。
- Agent 全量首跑 550/552：两个 Phase 4D 用例的 100 ms deadline 在 HA mock dispatch 前
  到期。彼时同时执行全量固件编译；独立复跑该文件 21/21 通过。并发负载是可能原因，
  尚未作为根因定论，也没有放宽测试断言。
- Agent 全量第二次复跑 552/552 通过；没有修改 Phase 4D 代码或测试。

## 固件构建与产物身份

- ESP-IDF v5.5.4 / ESP32-P4 Human-only 产品固件构建通过，未烧录。
- 默认 `firmware/build` 的已有配置选择了不匹配的 H2/SPI 协处理器，编译被板级守卫拒绝；
  旧产品临时目录的 sdkconfig 和部分 CMake 文件也已被清理，不能直接复用。
- 在独立临时目录从旧产品 `sdkconfig.json` 与 `kconfig_menus.json` 恢复私有配置，保留
  Kconfig 十六进制类型；最终生成的 2,303 项配置与旧产品快照完整一致。配置值未写入报告，
  没有改变设备上的固件、私有身份或常驻服务。
- app 大小 `0x2dfb20`，分区 `0x300000`，剩余 `0x204e0`（4%）。容量余量仍需在 v4 前处理。
- 基线提交 `5c0d160` 加已有及本轮未提交改动；没有提交或推送。

| 文件 | SHA-256 |
| --- | --- |
| `conversation_service.c` | `219cdb910c6eda9ecac4ff99bceb6488910c8aa585ebe1eacc6c2befffedb712` |
| `test_recognition_ui_recovery.py` | `97b4c961483f92435e2882a127297abd6ccbd1f00b4369163be89c15833a9424` |
| `firmware/dependencies.lock` | `7a9dd40763204be5a8385d837d31f1af1482a712766546245e10ebcc2cff9a95` |
| `p4home_firmware.bin` | `e21956d8bcd2c87ff9988066a911a2c80d680bbae28732b6bb11d8cdabd00e0f` |
| `p4home_firmware.elf` | `4949a5b16280321dadfa87515c652f85bba2a20604ed5c6ae8932c1a59e3151c` |

本地产物目录：`/private/tmp/p4home-20260909-recognition/build/`。
构建日志：`/private/tmp/p4home-20260909-final-build.log`；Agent 首跑、复跑日志分别为
`/private/tmp/p4home-20260909-agent-tests.log`、`/private/tmp/p4home-20260909-agent-retest.log`。
这些临时文件可能被系统清理，长期结论以本报告与可重跑的源码测试为准。

## 实机边界与下一门禁

本轮没有烧录、重启设备、暂停常驻 STT 进程或执行声学故障注入。上述测试属于本地证明，
不能替代 2026-09-05 尚未获得的实机失败恢复证据，也不代表真人听感/屏幕观感通过。

后续受控实机验证应分别记录：

1. 固件 bin/ELF、受测源码哈希、实际烧录目标和串口身份。
2. 同轮采音进入识别后，实际发生失败终态或本地
   `VERIFY:voice:recognition_timeout:PASS action=show_retry`，并出现对应重试提示。
3. 无需重启再次唤醒，下一轮普通对话的 UI 和播放均完成；旧 epoch 不覆盖新轮。
4. 结束后观察窗口无 panic/watchdog/非预期 reset，故障注入进程全部恢复；机器证据与
   真人听感、屏幕观察分别判定。未触发目标分支时继续记为 `inconclusive`。

历史记录：[2026-09-05 识别失败恢复](./2026-09-05-recognition-recovery.md)。
