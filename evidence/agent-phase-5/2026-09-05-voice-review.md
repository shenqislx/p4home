# 2026-09-05 语音代码 Review 与实机回归

后续更新：同日重新完整烧录后，两次独立测试复现 `too_short` 收音失败。
本文件下述五轮通过是当时结果，不代表间歇性收音问题已经排除；最新结论见
[重新烧录与语音复测](2026-09-05-reflash-retest.md)。

本次基于 `5c0d160` 的工作区，审查普通话女声改动及相关收音、播放边界。
Device Protocol 仍是 Human v3；v4 本次只修订设计歧义，没有实现或启用。

## 已修复的问题

1. **P1：中文远端采音同时进入英文 MultiNet，实机非法访存。**
   首轮短对话完成，第二轮长故事请求在采音约一秒后崩溃。串口第 230 行出现
   `Guru Meditation Error: Core 0 panic'ed (Load access fault)`；当时尚未开始第二轮 TTS。
   使用保留的 ELF 解码得到：
   `dl_esp32p4_memcpy → ctc_path_extend → ctc_path_append → ctc_output_run/model_detect → sr_service_runtime_task`。
   触发路径是每个 AWAKE 帧既送 MultiNet 又送远端采音。现在每次唤醒锁定识别路径：
   远端接受采音后，整轮不调用 MultiNet `clean/detect`，传输中途失败也不切换解码器。
   未注册远端监听器的独立本地命令模式保留；产品模式在远端拒绝采音时直接结束本轮，
   包括 Agent 断线或繁忙，避免隐式回退到英文解码器。这是产品路径修复，没有修改供应商二进制解码器。
2. **P2：播放结束立即 mute，DMA 尾音可能被截断。**
   `esp_codec_dev_write` 只将数据送入 I2S；当前固定 BSP 有 6 个 DMA 描述符，每个调整为
   256 个样本。正常播放结束先写入 1920 个静音样本，让尾部语音经过 DAC，再静音。
   取消路径保持立即关闭；排空失败报告 failed。唤醒提示音使用同样处理。
3. **P2：TTS 启动未校验仓库固定模型哈希。**
   原 worker 接受文件与旁置 manifest 自洽、但与固定 revision 不符的快照；异常类型的
   manifest 还可能触发非结构化启动异常。现与安装器共用固定哈希、文件树和版本校验，
   并保留 Python `-I` 隔离启动。损坏和异常快照返回 `MODEL_UNAVAILABLE`。
4. **P2：模型 CLI 提前 resolve 路径，绕过末级符号链接检查。**
   verify/output 保留末级路径用于检查，拒绝链接和悬空链接，避免验证或创建到意外目标。
5. **设计修订：v4 能力与 readiness 一致。**
   首版 v4 hello 只声明 `[4]`；区分“Cat Runtime 配置不可用”和“设备缺少 Cat 状态”：
   前者只禁用 Cat Runtime，后者使整个 v4 世界握手未就绪。
6. **P2：采音在 STT 前后失败时缺少产品终态日志。**
   增加 `voice_capture_terminal`，记录静音、过短、空识别、取消、超时等有界结果；不含原始
   音频或 transcript。零历史保留时也会上报，日志回调失败不改变语音处理结果。
7. **P1：单段 60 秒上限被误用于整轮流式长回复，造成中途截断。**
   崩溃路径修复后，同一长故事请求完成 12 段、累计 1,874,400 字节，随后第 13 段因累计
   PCM 超过 1,920,000 字节而取消，Agent 记录 `tts_failed`。现在每段仍限制 60 秒，
   流式整轮另设 180 秒累计预算；等待队列仍为两段，PCM 仍逐块清零，不保留三分钟整段音频。
   回归覆盖累计恰好 180 秒成功、再多一个样本失败、单段超 60 秒失败及失败样本清零。
8. **P1：误把 WebSocket FIN 当成接收缓冲分片结束，长文本触发断线。**
   解除累计 60 秒限制后，实机完成 19 段、2,809,600 字节，却在最终长文本下发时断线。
   固定版本 `esp_websocket_client` 对一个大帧按 buffer_size 多次回调，每次都携带相同 FIN；
   Voice/Agent receiver 原先在第一块 FIN 时就解析未收完整的数据。现在只有接收字节数
   等于预期总长才提交；Agent 同时拒绝缺片、重复片及偏移不连续，避免读取未初始化区域。
   HA receiver 已要求接收总长匹配，不受这一提前提交问题影响，本次未改 HA 实现。

## 本地验证

- 完整 Agent 回归 543/543；包含 TTS、STT、编排与播放针对性回归 87/87。
  真实回环 WebSocket 测试在获准开放本机端口后通过。
- TTS 模型/worker Python 回归 8/8；音频排空模拟 DMA 回归 1/1；Phase 5 契约 31/31；
  产品安装器回归 6/6。
- 新增实际 C 接收函数编译回归，覆盖 Voice/Agent 两条通道的大帧分块、缺片、重复片和恢复；
  Device Transport 契约 9/9 通过。
- TypeScript typecheck、`git diff --check` 通过。
- 真实固定 Kokoro 模型、`zf_xiaoxiao` 女声生成非静音 16 kHz PCM 通过。
- ESP-IDF v5.5.4 / ESP32-P4 构建通过。

## 实机证据

使用当前工作区直接构建和 USB 烧录，没有 GitHub Actions run。烧录工具逐项回读哈希验证通过；
首次崩溃日志、对应 ELF/bin 保存在本地 `evidence/voice-review-20260905/` 私有目录。
崩溃 ELF SHA-256 为 `02774fbecd73ea39389c7a49c9c31b0d83e599940158d041a1cc006a7b32b950`，
与串口打印的 `02774fbec` 一致。

### 最终修复后的实机回归：语音功能通过

本地工作区构建，ESP-IDF v5.5.4；P4 MAC `30:ed:a0:e1:8a:f5`，USB app-flash
完成且 `Hash of data verified`。不是 GitHub Actions 验证，也没有提交或推送这些改动。

- 固件 bin SHA-256：`0a3b34efff5390608801f6513880272c99906ab5d366fdb3568a08211e65d558`。
- ELF SHA-256：`9e7fd00b49e522f9652e89524797c61aeac7b40f0008d7576d6854c9c2f5240e`。
- 当前构建产物与归档 ELF/bin 哈希一致；manifest 同时记录受测源文件哈希。
- `monitor-complete.log` 采集 438 秒，包含结束后 60 秒观察；零 panic/watchdog/assert/reset。
  该日志从启动约 20 秒后开始，未采集本轮 ELF 启动打印；身份关联依据烧录目标、产物哈希和
  串口 MAC，不宣称存在未采集的启动哈希证据。

Mac `Tingting` 经真实扬声器发出固定测试语句，P4 实际麦克风完成 WakeNet → STT →
真实模型 → Kokoro 普通话女声 → 实际播放及 UI 回执链路；不是向协议直接注入 transcript。

| 用例 | 整轮耗时 | PCM 音频长度 | 完成分段 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 身份短问答 | 12.1 秒 | 3.4 秒 | 1 | completed |
| 第一次长故事 | 102.5 秒 | 93.7 秒 | 21 | completed |
| 长故事后的短问答 | 9.9 秒 | 7.7 秒 | 2 | completed |
| 第二次长故事 | 110.3 秒 | 101.2 秒 | 23 | completed |
| 最终恢复对话 | 3.4 秒 | 2.0 秒 | 1 | completed |

五轮各有一次 capture 和一次 `owner=remote local_detect=off`，48 段均
`playback terminal status=completed dropped=0`，UI/audio 终态均 completed。
串口关键位置：`monitor-complete.log:155` 首轮远端采音，`:287` 首次长故事末段完成，
`:438` 第二次长故事末段完成，`:469` 最终恢复播放完成，`:472` 开始结束后观察。
完整逐轮数据见私有目录中的 `acoustic-complete.json` 与 `hardware-validation-manifest.json`。

### 未闭环与限制

- 真人听感、尾音是否自然及屏幕实际观感仍待用户确认；机器声学输入、UI 回执与播放完成标记
  不等同于人工体验验收。
- 开机 HA 初始连接有重试，约 93 秒才完成 initial sync；其后五轮测试保持 READY。
  同时出现一次 `VERIFY:ui:8fps:FAIL interval_ms=10145`（`:140`），之后帧率标记恢复 PASS。
  这两项记录为待优化，不把本轮语音通过表述为所有系统检查通过。
- 固件 app 分区只剩约 4% 空间；本次可正常构建烧录，但后续新增 v4 功能前需要规划容量。
- 单轮收音仍有 8 秒硬上限，播放期间仍为半双工；本轮没有取消这些产品边界。
- 英文 MultiNet 的供应商二进制未修改；修复是让产品中文远端采音不再进入该崩溃路径。
