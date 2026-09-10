# P4Home Human-only 常驻语音聊天

## 产品边界

此模式用于日常人工聊天，不是 `phase5e_ui` 自动化门禁：

- P4 本地以 `Hi，小星` 唤醒，上传一次有界语音会话；
- Human 的固定自我认知是“我是文曲星，你可以叫我小星”；
- 唤醒后本地播放固定 Human 人声“在呢”，并保留最近 800 ms 句首音频；
- HA 尚未完成鉴权、事件订阅和初始白名单状态同步时，只播放固定 Human 人声“正在连接，请稍后”，
  不开启采音、STT、LLM 或本地固定命令窗口；
- 固定 STT 的 final transcript 仍进入统一 Role Router；
- Human 决策正常执行；Robot 或混合决策 fail-closed 为 Human 澄清；
- Agent 不读取 HA URL、token 或 policy，也不构造 Robot HA 客户端；
- 屏幕上的 Cat 只运行固件本地 timer 驱动的独立状态机，不读取 Human 位置或 transcript；
  Agent Cat autonomy 在 `product_human` 中保持硬关闭；
- Human 普通对话没有执行工具；只有 Router 明确识别为屏幕 Human avatar 动作时，Runtime 才提供
  `go_to_room/go_to/sit/look_at/interact` 白名单 Tool。`actor_id=human_avatar` 由 Runtime 固定，模型
  不能选择 Cat、坐标或 Home Assistant；
- `ui_output=required`，P4 必须确认 UI revision；
- `audio_output=required`，Human 回复按安全中文分段进入常驻 Kokoro worker；每段 PCM 增量生成后
  立即按 P4 credit 播放，不再等待整轮模型回复和整段音频全部完成；
- Role Router 与 Human 的每次 Qwen API 请求都显式携带 `think: false`，不依赖模型默认值；
- Agent readiness 前真实预热 Qwen，并以 `keep_alive=30m` 在最后一次请求后保温 30 分钟；活跃
  请求会续期，闲置超时后 Ollama 可自动释放约 `22–25 GB` 主机内存，下一次请求需要重新冷加载；
- 可用 `P4HOME_OLLAMA_KEEP_ALIVE_MINUTES` 设置 1–120 的整数分钟数；例如 `10` 可恢复此前驻留窗口。
  provider 的单次显式 `keep_alive` 仍可覆盖产品默认值；
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
Conversation UI 和 P4 playback。Human-only 是默认，继承的 launchd 角色环境变量不能扩大到 Robot。
STT/TTS 模型路径均由安装器绑定到固定 revision，启动时缺失即 fail closed。

### 显式启用 Robot 的常驻接线

启动 wrapper 现在支持私有配置目录中的 `role-mode` 文件：仅接受 `human-only` 或 `human-robot`，
文件必须为非符号链接的私有普通文件（`0600` 或 `0400`）。缺失时维持原来的 Human-only 行为。
启用 Robot 后从 `~/.config/p4home` 读取既有 `robot-ha.url`、`robot-ha.token`、
`robot-ha-policy.json`；可用 `P4HOME_PRODUCT_HA_CONFIG_DIR` 指向另一套私有 HA 配置。
不修改既有 HA allowlist，不轮换凭据，也不因此启用 Cat。

HTTPS/WSS 是默认要求。仅在明确允许沿用未加密的现有 HA 连接时，才在产品私有配置目录
写入 `ha-allow-insecure`，值为 `1`；缺失或 `0` 均不允许未加密连接。
已有 installer 不覆盖这两项设置。修改后需要重启常驻服务。

Cat 与 Human 屏幕动作同时在线仍需要补齐
[多角色共存实现](plans/2026-09-04-device-protocol-v4-multi-actor-design.md)，不能靠 `role-mode` 完成。

从旧版 Human Voice 安装升级时可直接替换代码后重启。若既有私有配置中尚无 `device-port`，启动脚本
只为当前进程使用固定默认值 `18444`，不会重写或轮换 `device-token`、TLS 私钥、证书或设备身份；
再次运行安装器会原子补写该配置。现有身份文件若不是私有普通文件，安装器仍会拒绝隐式修复。
如果旧配置的语音端口正是 `18444`，必须先显式选择另一个 Device 端口，避免端口身份混用。

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

Device 端口不是 `workflow_dispatch` 输入。工作流从 runner 私有配置
`~/.config/p4home/product-voice/device-port` 读取；旧配置缺少该文件时使用固定默认值 `18444`，且
必须与 `agent_port` 不同。

产品 profile 启用 SR、Voice transport、Device Protocol v3 Human-avatar transport、外部内存栈与
TLS SPKI pin，同时关闭 startup selftest、Phase 5A/5B validation marker、Robot/HA 和 Cat autonomy。
工作流会在刷写前确认本机 Voice 与 Device 服务均在监听，但 workflow 绿色只证明构建、刷写、启动
与 artifact 传输，不代替真人聊天或角色动作观察。

manifest 中 `product_human_agent_transport_enabled=true`、
`product_human_agent_protocol_version=3` 和兼容字段 `product_human_agent_transport_disabled=false`
只证明固件配置启用了 Human-avatar v3 transport；manifest 不记录私有 Device 端口，也不证明移动、
坐下或互动动作已经完成。

## 日常使用

1. 等待顶部 HA 状态完成连接；如果提前唤醒，设备会说“正在连接，请稍后”并在对话框显示同样提示，
   这一轮不会排队，连接完成后需重新说唤醒词；
2. 清楚地说 `Hi，小星`；
3. 听到 Human 人声“在呢”或看到“请说话…”后开始说中文，例如“陪我聊两句吧”；
4. P4 对话框依次显示“请说话… → 正在识别… → 正在思考…”；
5. Human final transcript 与回复显示在同一对话框中；扬声器会在模型完整回复结束前开始播放已完成的
   安全语句。

也可以直接说“让屏幕上的 Human 去书房”“去客厅沙发坐下”或“去窗边看看”。动作规划不会使用
流式聊天文本；只有 P4 返回 `completed` 后，UI/TTS 才会确认完成。目标含糊、未知、带条件或混合
复杂意图时只会请求澄清，不会猜测执行。

Cat 的画面移动不是一次 Agent 决策：它由固件本地 timer 从自身固定初始房间和自身状态推进。
`product_human` 不启动 Cat runner、Session、Memory 或 Device Protocol v2 autonomy，因此 Human
transcript 不会成为 Cat 输入。

普通 Human 对话 profile 的 `allowed_tools` 始终为空；avatar 使用独立、零 Memory 预算的 executor
profile，只授权上述五个 `character.*` 动作。该 executor 不与 Cat profile 共用授权、Session 或历史。

上述省略 Human 主语的直接祈使句已经纳入 Router 契约与本地 mock 回归；真实 Qwen 对不同口语表达的
稳定分类仍属于真实模型门禁，不能由 mock 测试代替。

这里的“流式”是端到端的增量文本、clause 级 Kokoro 生成和 PCM 帧级传输。Kokoro 仍会先完成一个
有界 clause 的声学生成，再输出该 clause 的 PCM，因此不等同于声学模型逐帧推理；实际首声延迟和
句间连续性必须以 P4 扬声器人工听感为准。

“在呢”结束到远端 capture 打开之间使用 800 ms 的 PSRAM 环形预卷；预卷按时间顺序以 2×
实时速率追赶，避免一次性灌满 Voice 帧队列。它用于保护稍早开口的句首，但不鼓励在提示人声播放时
抢话。

灯具等家居控制语句仍会进入 Human 澄清，不会调用 HA。当前板卡是无回放参考通道的单麦方案：远端
回复播放期间暂停 WakeNet，播放关闭后再保留 400 ms 尾音保护，然后恢复 `Hi，小星` 唤醒。因此产品
语音采用半双工，播放期间再次喊唤醒词不会触发 barge-in；协议层取消与 epoch fencing 仍保留。

单轮收音以 1.2 秒连续尾部静音作为自然结束条件，并以 8 秒作为硬上限，用于容纳普通句中停顿；这
不会把 8 秒内的静音无限延长为持续监听。

静音、语音过短、空识别、识别服务错误或超时均发送对应的 UI 终态，提示重新唤醒；
失败提示不合成语音，也不调用角色模型。新采音会取消旧失败提示的待确认发送，旧 epoch 的结果
不能覆盖新对话。设备还设有独立的 125 秒识别界面兜底（覆盖服务端最高 120 秒 STT 时限和
回包余量），超时后显示重试提示并结束 Human 会话活跃状态，不中断正常长回复播放。
同一轮重复的识别通知不会延长该期限；超时后的迟到 listening/transcribing 更新不能重新
进入识别状态。新一轮采音会建立新期限，迟到的真实 thinking/终态进展仍可正常显示。

每次唤醒只选择一条识别路径：远端接受采音后，本轮中文对话不再送进英文 MultiNet 固定命令
解码器，也不会因本地命令误匹配而提前结束；传输中途失败不会切换到另一条识别路径。
未注册远端采音监听器的独立本地命令模式仍保留。产品模式在 Agent 断线或繁忙时结束本轮，
不会回退到英文解码器。正常回复和唤醒提示音在结束静音前排空 I2S 中的尾部
PCM；取消播放仍立即停止，不等待尾音排空。

流式长回复的整轮音频预算为 180 秒，各段仍独立限制为 60 秒，等待播放的分段队列最多为两段。
累计预算只统计已传输数据，不在内存中保留整轮 PCM；非流式批量合成的原有 60 秒上限保持不变。

## 默认 Human-only 模式验收

以下用于默认 Human-only 安装；已显式启用三角色时，使用文末三角色配置和启用记录。
部署完成至少分别核对：

1. launchd 进程启动后输出 `product_voice_ready`，其中 `role_mode=human-only`、`ha_entities=0`；
2. P4 串口显示 SR/WakeNet 和 Voice transport ready/connected，且无 panic/watchdog/reset loop；
3. 真人连续完成三轮 Human 对话，UI 中文 transcript 与回复完整可见，扬声器回复清晰可听；
4. 重启 P4 与 Agent 主机后自动恢复；
5. 分别说一次移动、坐下和互动命令，确认屏幕 Human 执行动作，Cat 不接收 transcript；
6. 说一次灯具控制语句，确认没有 HA 写入，UI 只显示安全澄清；
7. SQLite/日志/artifact 不含 token、TLS 私钥或原始音频。
8. 让回复正文包含近似唤醒词，确认整段播放仍以 `completed` 终止且播放中没有开启新 capture；播放
   结束 400 ms 后再次说 `Hi，小星`，确认能正常开始下一轮。

自动 marker、Agent 日志、SQLite 审计和用户肉眼 UI 观察必须分别报告，不能互相替代。

## Human、Robot 与 Cat 同时使用（Device Protocol v4）

在保留 Human 聊天、语音、屏幕身体动作、休眠/唤醒能力的前提下，三角色使用同一个产品服务。
Robot 继续使用已有 Home Assistant 白名单；Cat 使用独立角色状态、记忆和低优先级自治策略。
Cat 不接收用户原始语音转写，也没有 HA 写权限。

v4 固件通过一条 TLS `/v1/device` 连接发送 `human_avatar` 和 `cat` 两份完整状态。
两个角色共享对象占用和一条有界动作队列。Human 交互会取消 Cat 的低优先级动作；已被另一角色
占用的对象返回 `OBJECT_OCCUPIED`。断线动作保持 unknown，Agent 不会自动重发。

已安装服务的私有目录 `~/.config/p4home/product-voice/` 增加以下设置，文件权限为 0600：

| 文件 | 内容 / 用途 |
| --- | --- |
| `role-mode` | `human-robot`：打开已有 Robot 白名单 |
| `ha-allow-insecure` | 已明确允许局域网 HTTP 时为 `1` |
| `device-protocol-version` | `4`，必须与设备固件匹配 |
| `cat-enabled` | `1`：装配 Cat；缺失时关闭 |
| `cat-autonomy.json` | 自治策略，格式见 `agent/config/cat-autonomy.example.json` |
| `cat-control-token` | 单独的随机控制令牌，不复用设备令牌 |

Cat 配置错误会记录 `cat_autonomy_disabled`，Human 身体和语音服务仍保持装配。
暂停 Cat 使用经过令牌认证的本机 `PUT /v1/autonomy/mode`，请求体为 `{"mode":"paused"}`；
`GET /v1/autonomy/status` 和 `/v1/autonomy/audit` 可检查状态与动作审计。端口默认 9477。
运行时暂停不修改文件；若需重启后仍暂停，同步将私有配置的 `initial_mode` 设为 `paused`。

日常建议沿用低频配置：每小时一个定时事件、两次模型触发至少间隔 15 分钟、每天最多 24 次，
23:00–07:00 安静时段。暂停自治不删除 Cat，也不影响 Human 和 Robot。
恢复 v3 需要同时恢复 v3 应用固件和私有 `device-protocol-version=3`，并关闭 Cat；无需重做配网或配对。

2026-09-10 的实现及本地/实机证据见
[三角色启用记录](../evidence/agent-phase-5/2026-09-10-three-role-enablement.md)。
