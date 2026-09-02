# P4Home Human-only 常驻语音聊天

## 产品边界

此模式用于日常人工聊天，不是 `phase5e_ui` 自动化门禁：

- P4 本地以 `Hi ESP` 唤醒，上传一次有界语音会话；
- 唤醒后本地播放固定 Human 人声“在呢”，并保留最近 800 ms 句首音频；
- HA 尚未完成鉴权、事件订阅和初始白名单状态同步时，只播放固定 Human 人声“正在连接，请稍后”，
  不开启采音、STT、LLM 或本地固定命令窗口；
- 固定 STT 的 final transcript 仍进入统一 Role Router；
- Human 决策正常执行；Robot 或混合决策 fail-closed 为 Human 澄清；
- Agent 不读取 HA URL、token 或 policy，也不构造 Robot HA 客户端；
- Human 没有执行型 Tool，不能控制灯具；
- `ui_output=required`，P4 必须确认 UI revision；
- `audio_output=required`，Human 回复按安全中文分段进入常驻 Kokoro worker；每段 PCM 增量生成后
  立即按 P4 credit 播放，不再等待整轮模型回复和整段音频全部完成；
- Role Router 与 Human 的每次 Qwen API 请求都显式携带 `think: false`，不依赖模型默认值；
- Agent readiness 前真实预热 Qwen，并以 `keep_alive=-1` 持续驻留；这会长期占用约 `22–25 GB`
  主机内存，直至显式卸载模型或重启 Ollama；
- 原始 PCM 不落盘，审计与 private Memory 写入受现有生产策略约束。

## 一次性安装

在常驻 Agent 主机上准备固定 LAN 地址，然后执行：

```sh
python3 scripts/install-product-human-voice.py --agent-host <AGENT_LAN_IP>
```

安装器以幂等方式创建：

- `~/.config/p4home/product-voice/`：`0700`；
- 稳定 device id、随机 token、长期自签 RSA-2048 TLS identity 与 SPKI pin：`0600`；
- `~/Library/Application Support/p4home/product-voice/`：SQLite 状态目录；
- `~/Library/LaunchAgents/local.p4home.product-human-voice.plist`：无密钥的 launchd 描述；
- `~/Library/Logs/p4home/`：常驻进程日志目录。

安装器不会覆盖或轮换一套完整的既有 identity；如果 identity 只有部分文件，会 fail closed，要求人工
检查后处理。

产品身份固定使用 RSA-2048。ESP32-P4 当前的 MbedTLS/PSA 组合在解析部分 EC 证书公钥时可能在
SPKI verifier 执行前失败，因此 `product_human` 工作流会拒绝 EC 产品证书；临时验证 profile 的
一次性凭据边界保持不变。

加载服务：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.p4home.product-human-voice.plist
launchctl kickstart -k gui/$(id -u)/local.p4home.product-human-voice
```

产品入口固定使用 Node `v24.19.0`，启动真实 Ollama、固定 STT/TTS、Human Runtime、private Memory、
Conversation UI 和 P4 playback。Human-only 是默认且由启动 wrapper 强制设置，不能从 launchd
环境意外扩大到 Robot。STT/TTS 模型路径均由安装器绑定到固定 revision，启动时缺失即 fail closed。

## 刷写产品固件

常驻服务开始监听后，使用自托管硬件工作流的 `product_human` profile。该 profile 从同一台 runner
的私有配置目录读取稳定 identity，只把 token 写入 runner 临时 sdkconfig；Git、命令行、日志、
manifest 和 artifact 均不得包含 token。

建议输入：

- `validation_profile=product_human`
- `serial_port=/dev/cu.usbserial-210`
- `monitor_seconds=180`
- `agent_host=<AGENT_LAN_IP>`
- `agent_port=18443`

产品 profile 启用 SR、Voice transport、外部内存栈与 TLS SPKI pin，同时关闭 startup selftest、
Phase 5A/5B validation marker 和 Device Agent transport。工作流会在刷写前确认本机 Voice 服务正在
监听，但 workflow 绿色只证明构建、刷写、启动与 artifact 传输，不代替真人聊天观察。

## 日常使用

1. 等待顶部 HA 状态完成连接；如果提前唤醒，设备会说“正在连接，请稍后”并在对话框显示同样提示，
   这一轮不会排队，连接完成后需重新说唤醒词；
2. 清楚地说 `Hi ESP`；
3. 听到 Human 人声“在呢”或看到“请说话…”后开始说中文，例如“陪我聊两句吧”；
4. P4 对话框依次显示“请说话… → 正在识别… → 正在思考…”；
5. Human final transcript 与回复显示在同一对话框中；扬声器会在模型完整回复结束前开始播放已完成的
   安全语句。

这里的“流式”是端到端的增量文本、clause 级 Kokoro 生成和 PCM 帧级传输。Kokoro 仍会先完成一个
有界 clause 的声学生成，再输出该 clause 的 PCM，因此不等同于声学模型逐帧推理；实际首声延迟和
句间连续性必须以 P4 扬声器人工听感为准。

“在呢”结束到远端 capture 打开之间使用 800 ms 的 PSRAM 环形预卷；预卷按时间顺序以 2×
实时速率追赶，避免一次性灌满 Voice 帧队列。它用于保护稍早开口的句首，但不鼓励在提示人声播放时
抢话。

设备控制类语句会进入 Human 澄清，不会调用 HA。回复播放期间再次说 `Hi ESP` 会触发 barge-in，
取消旧播放 epoch 并开启新一轮采集。

## 验收

部署完成至少分别核对：

1. launchd 进程启动后输出 `product_voice_ready`，其中 `role_mode=human-only`、`ha_entities=0`；
2. P4 串口显示 SR/WakeNet 和 Voice transport ready/connected，且无 panic/watchdog/reset loop；
3. 真人连续完成三轮 Human 对话，UI 中文 transcript 与回复完整可见，扬声器回复清晰可听；
4. 重启 P4 与 Agent 主机后自动恢复；
5. 说一次设备控制语句，确认没有 HA 写入，UI 只显示安全澄清；
6. SQLite/日志/artifact 不含 token、TLS 私钥或原始音频。

自动 marker、Agent 日志、SQLite 审计和用户肉眼 UI 观察必须分别报告，不能互相替代。
