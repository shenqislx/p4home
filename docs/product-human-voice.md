# P4Home Human-only 常驻语音聊天

## 产品边界

此模式用于日常人工聊天，不是 `phase5e_ui` 自动化门禁：

- P4 本地以 `Hi ESP` 唤醒，上传一次有界语音会话；
- 固定 STT 的 final transcript 仍进入统一 Role Router；
- Human 决策正常执行；Robot 或混合决策 fail-closed 为 Human 澄清；
- Agent 不读取 HA URL、token 或 policy，也不构造 Robot HA 客户端；
- Human 没有执行型 Tool，不能控制灯具；
- `ui_output=required`，P4 必须确认 UI revision；
- `audio_output=disabled`，扬声器缺失记为 deferred；
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

产品入口固定使用 Node `v24.19.0`，启动真实 Ollama、固定 STT、Human Runtime、private Memory 和
Conversation UI。Human-only 是默认且由启动 wrapper 强制设置，不能从 launchd 环境意外扩大到
Robot。

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

1. 清楚地说 `Hi ESP`；
2. 等待唤醒后直接说中文，例如“陪我聊两句吧”；
3. P4 对话框显示 final transcript；
4. Human 回复显示在同一对话框中。

当前没有外接扬声器，因此不期待可听回复。设备控制类语句会进入 Human 澄清，不会调用 HA。

## 验收

部署完成至少分别核对：

1. launchd 进程启动后输出 `product_voice_ready`，其中 `role_mode=human-only`、`ha_entities=0`；
2. P4 串口显示 SR/WakeNet 和 Voice transport ready/connected，且无 panic/watchdog/reset loop；
3. 真人连续完成三轮 Human 对话，UI 中文 transcript 与回复完整可见；
4. 重启 P4 与 Agent 主机后自动恢复；
5. 说一次设备控制语句，确认没有 HA 写入，UI 只显示安全澄清；
6. SQLite/日志/artifact 不含 token、TLS 私钥或原始音频。

自动 marker、Agent 日志、SQLite 审计和用户肉眼 UI 观察必须分别报告，不能互相替代。
