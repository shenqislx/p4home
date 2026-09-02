# Cloud Codex Hardware Validation

## 1. 职责边界

P4 Home 硬件验证采用 artifact-first 模式：

- GitHub Actions 只负责 `checkout → build → flash → serial capture → artifact upload`；
- Codex 先验证 artifact 身份与完整性，再根据当前改动解释串口证据；
- workflow 绿色只说明硬件执行链成功，不代表具体功能通过；
- workflow 不因缺少某个业务 `VERIFY:` 标记而失败。

本协议对应 workflow：

- [Firmware Self-Hosted Flash Serial](../.github/workflows/firmware-self-hosted-flash-serial.yml)

self-hosted runner 的 checkout 从 GitHub API 下载由 `GITHUB_SHA` 锁定的 repository archive，避免
Git Smart HTTP 暂时不可用时阻塞硬件门禁。归档解包前必须验证 workspace 边界；dependency lock
则在构建前后分别计算 SHA-256，替代对 `.git` 元数据的依赖。

## 2. Runner 前置条件

Runner 必须带有以下标签：

- `self-hosted`
- `macOS`
- `ARM64`
- `esp32-p4`

Runner 还必须具备：

- ESP-IDF v5.5.4，且用户级激活脚本位于
  `$HOME/.espressif/tools/activate_idf_v5.5.4.sh`；
- 已连接的 ESP32-P4 串口；
- 私有硬件 `sdkconfig`，通过以下方式之一提供：
  1. GitHub Actions secret `P4HOME_HARDWARE_SDKCONFIG_B64`；
  2. runner 本机文件 `$HOME/.config/p4home/sdkconfig.hardware`。

推荐把已经验证可连接 Wi-Fi/HA 的 `firmware/sdkconfig` 做 base64 后保存为
Actions secret。workflow 只把解码结果写入 `$RUNNER_TEMP`，不会复制到仓库、artifact
或构建日志。私密配置先作为机器/凭据基线，再由 `scripts/merge-sdkconfig-defaults.py` 应用
仓库中的 `firmware/sdkconfig.defaults`；同名配置始终以受版本控制的项目默认值为准，避免旧的
全量私密配置回退安全或资源基线。不得把 SSID、密码、HA token 提交到 Git。

## 3. 触发参数

`workflow_dispatch` 接受：

| 参数 | 默认值 | 约束 |
|---|---|---|
| `validation_profile` | `generic` | `generic`、`phase2d_agent`、`phase3d_object`、`phase4c_ha`、`phase5a_voice`、`phase5b_voice`、`phase5c_stt`、`phase5e_e2e`、`phase5e_ui`、`phase6h_cat_memory`、`phase7_autonomy` 或 `product_human` |
| `serial_port` | `/dev/cu.usbserial-210` | runner 上的字符设备 |
| `monitor_seconds` | `120` | `10–7200` 秒 |
| `agent_host` | 空 | Agent profile 时必填；P4 可访问的 runner LAN host |
| `agent_port` | `8443` | `1–65535` |

两小时 Phase 0 长跑使用 `monitor_seconds=7200`。Phase 2D 必须选择 `phase2d_agent` 且固定
`monitor_seconds=7200`；workflow 额外保留 300 秒给启动、100 次动作与重连，因此 manifest 中的
`capture_seconds` 为 7500。该 profile 在 runner 临时目录生成一次性 P-256 TLS key/cert、256-bit
device token 与 SPKI pin，不把凭据写入仓库、日志或 artifact。同一时间只允许一个硬件 job，且
新任务不会取消正在执行的刷写或采集。

Phase 3D 对象门禁使用 `phase3d_object`，`monitor_seconds` 至少为 120 秒，workflow 额外保留
120 秒给 Protocol v2 握手、`go_to(living_room.sofa) → sit`、重连 snapshot、主动取消和 Agent
离线后的 UI fallback。该 profile 强制把临时固件配置设为 Device Protocol v2；Phase 2D 与默认
固件仍使用 v1。两个 Agent profile 共用同一套一次性 TLS 凭据边界。

Phase 4C HA 收敛门禁使用 `phase4c_ha`，`monitor_seconds` 至少为 120 秒，workflow 额外保留
180 秒，并在同一个不重新打开串口的连续采集会话中，为 Robot 客户端关闭后至少保留 60 秒。
runner 必须在仓库外提供权限为
`0600` 的 `$HOME/.config/p4home/robot-ha.token`、`robot-ha-policy.json` 和 `robot-ha.url`。
workflow 先把 token/policy 冻结到本次任务的 `0700` 临时目录，再从同一份冻结 policy 把唯一且已被
P4 whitelist 跟踪的目标注入临时固件配置；Phase 4C 不向仓库新增真实 entity id，Kconfig 默认值
保持为空，但目标必须匹配仓库中既有的 panel whitelist 条目。该 profile 明确关闭
Agent transport。烧录前
先让 P4 停留在 ROM bootloader，证明 P4 应用离线时 Robot 仍可反向切换并恢复。烧录后串口出现
`VERIFY:ha:subscribed:PASS`，再执行一次在线切换/恢复，并从 Robot 客户端关闭后的串口后缀核对
`VERIFY:phase4c:p4_standalone:PASS` 与 `VERIFY:ui:8fps:PASS`。token 不进入命令行、Git、日志或
artifact；私有 policy 及其任务副本不进入 Git 或 artifact。原始串口先写入
runner 私有临时目录，追加 harness 后再对完整或截断的 HA entity 样式做等长脱敏与残留扫描；只有
成功后才原子生成 artifact 路径，失败时不会上传原始串口。artifact 只保留非管理员身份、alias、
accepted/observed/restored 结果和 P4 目标状态 marker。

Phase 5A 本地语音基线使用 `phase5a_voice`，`monitor_seconds` 至少为 180 秒。该 profile 只在
runner 临时 sdkconfig 中打开 audio startup selftest、ESP-SR 和 Phase 5A marker，并显式关闭 Agent
transport；它不创建 Voice socket、不向 Agent 发送 PCM，也不接入 STT/TTS。自动证据覆盖 codec、
非零 PCM、AFE feed/fetch、lease、资源/看门狗和 UI；真实 `Hi ESP`、`turn on the light` 口播与
speaker 可听播放属于人工观察，必须和自动 marker 分开报告。

Phase 5E 无扬声器闭环使用独立的 `phase5e_ui`，`monitor_seconds` 至少为 900 秒。runner 通过
Mac 系统扬声器只生成固定的麦克风测试输入，依次覆盖 Robot 读取、Robot 写入并恢复，以及 Human
聊天；Agent 使用固定版本 STT、真实 Ollama 模型、非管理员 Robot HA 身份、生产 Memory/审计策略，
并将 `ui_output` 设为 `required`、`audio_output` 设为 `disabled`。每轮只有在 P4 Home 页面实际接受
对话更新并回送匹配的 `ui.applied` 后才算完成。上传证据必须同时出现 3 个
`VERIFY:phase5e:ui_conversation:PASS`、3 个 `VERIFY:phase5e:ui_applied:PASS`、Agent 汇总
`VERIFY:phase5e:voice_ui_e2e:PASS` 与隐私审计 marker；不得出现 playback opened。P4 扬声器输出在
该 profile 中明确记为 deferred，不作为失败，也不得被报告为通过。

日常人工聊天使用 `product_human`，`monitor_seconds` 至少为 180 秒。它不是自动业务门禁：runner
从本机 `0700` 的 `~/.config/p4home/product-voice` 读取 `0600` 的稳定 device identity、RSA-2048 TLS identity
与 SPKI pin，生成仅存在于 runner 临时目录的产品 sdkconfig。该 profile 启用 SR、Voice transport
以及固定 `actor_id=human_avatar` 的 Device Protocol v3 Agent transport，同时关闭 startup selftest、
Phase 5A/5B validation marker 和全部 Robot HA 装配。Voice 端口使用 workflow 的 `agent_port`；独立
Device 端口从私有 product config 的 `device-port` 读取，旧配置缺少该文件时只使用固定默认值
`18444`，不会改写身份或密钥。刷写前必须确认本机常驻 Voice 与 Device 服务分别监听，且 Voice
服务呈现匹配的 SPKI。屏幕 Cat 仍仅由固件本地 timer 和自有状态推进；Agent Cat autonomy 在
`product_human` 中硬关闭，且不接收 Human transcript。上传候选必须扫描稳定 token、TLS
私钥、raw-audio 字段和二进制/长 Base64 材料，审计失败时不得上传 artifact。manifest 中的
`product_human_*` 字段只证明配置、刷写、启动和隐私传输边界；真人 `Hi ESP`、中文 STT、Human
回复、UI 可见性、P4 扬声器听感，以及屏幕 Human 的移动、坐下或互动仍需独立人工观察。常驻服务
启用固定 Kokoro TTS，并要求 P4 playback 完成；workflow 绿色及 product profile 的刷写 manifest
都不自动证明语音或角色动作已完成。常驻安装与日常使用见
[Human-only 常驻语音聊天](./product-human-voice.md)。

Phase 6H Cat + Memory 使用独立的 `phase6h_cat_memory`，`monitor_seconds` 至少为 120 秒，
Device Protocol 固定为 v2。runner 在 `0700` 临时目录创建 `0600` SQLite，只写入一条 Cat-private、
带随机 canary 且故意与实时 World 冲突的旧记录；Memory 以 `untrusted_memory` 数据进入 Cat 上下文，
但动作目标和最终坐姿必须服从 P4 Object snapshot。原始串口和 harness 输出只保存在 runner 私有
临时目录；上传候选在写 manifest 前扫描一次性 device token、TLS 私钥、Memory canary，以及完整、
截断和编码形式的私密材料，审计通过后才原子生成 `firmware/monitor.log`。审计失败时不打印原始
串口、不生成发布日志并跳过 artifact 上传。artifact/manifest 只允许出现 Memory ID、projection 状态、P4 最终状态与
`phase6h_artifact_audit_status`。专用证据为 `VERIFY:phase6h:cat_memory_recall:PASS`、
`VERIFY:phase6h:world_truth_wins:PASS`、`VERIFY:phase6h:artifact_privacy:PASS` 和审计 marker；
缺少任一功能 marker 时，Cloud Codex 必须判为 `inconclusive`，不能只凭 workflow 绿色通过；
harness 业务退出码和 `VERIFY:*:FAIL` 本身不改变 transport job 状态，隐私发布失败仍会 fail closed。

Phase 7 Cat Autonomy 真实环境门禁使用 `phase7_autonomy`，`monitor_seconds` 至少为 300 秒，
Device Protocol 固定为 v2。runner 使用一次性 P4 TLS/device token，并从仓库外权限为 `0600` 的
Robot HA URL/token/policy 建立真实非管理员只读连接；Cat autonomy 不获得 HA 写 Tool。P4 固件
保留独立 HA client，但门禁要求其周期指标中 `service_calls=0`。harness 先用真实
`qwen3.6:35b-mlx` 处理一次 60 秒 Timer，再把真实 HA allowlist 快照转换为
隔离的 in-process 状态变化，验证 HA source bridge 的第二次 Cat action。后者不是家庭现场实体真的
变化，证据必须保留 `origin=isolated_transition_from_real_allowlist_snapshot`，不得写成“真实 HA
实体事件已发生”。随后门禁验证 P4 断线重连 snapshot、pause/disable 各 60 秒零模型调用、覆盖
两次 action 和两段控制观察的 Agent RSS 1 秒采样峰值、Agent RobotHaClient 仍 ready 且 outbound
`call_service=0`，并校验 P4 内置 HA client 的独立 `service_calls=0` 指标；这些计数不代表 HA
服务端全局写入计数。串口捕获最长 1,235 秒；harness terminal 后仍继续至少 35 秒，以覆盖下一次
30 秒 P4 HA heartbeat，auditor 只接受 terminal sentinel 之后仍有 READY/零写样本，实际采集秒数
写入 manifest。该采样不是瞬时内存硬上限。
原始串口和 harness 日志只在 runner 私有
临时目录合并；上传前基于 Robot policy、固件 panel catalog 和最终 sdkconfig 的并集扫描一次性 P4
凭据、Robot HA token、所有在册真实 HA entity id、崩溃和 reset-loop
标记，审计通过后才原子发布。功能判定要求 manifest 身份一致，并同时核对
`VERIFY:phase7:product_ready:PASS`、`timer_action:PASS`、`ha_projection_action:PASS`、
`p4_reconnect:PASS`、`pause_disable:PASS`、峰值 RSS `resource_stability:PASS`、
`ha_read_only:PASS` 与
`artifact_audit:PASS`；workflow 绿色本身仍不构成 Phase 7 通过。

## 4. Artifact Contract

Artifact 名称固定为 `esp32-p4-monitor-log`，至少包含：

```text
firmware/monitor.log
firmware/hardware-validation-manifest.json
```

manifest schema version 1 的必需字段：

```json
{
  "schema_version": 1,
  "mode": "artifact-only",
  "verdict_owner": "cloud-codex",
  "git_sha": "<commit sha>",
  "run_id": "<github run id>",
  "run_attempt": "<github run attempt>",
  "job": "flash-and-monitor",
  "serial_port": "/dev/cu.usbserial-210",
  "monitor_seconds": 120,
  "capture_seconds": 120,
  "validation_profile": "generic",
  "log_file": "monitor.log"
}
```

workflow 还写入 app image 文件名、字节数与 SHA-256；这些字段用于确认刷写镜像，不能
代替 `git_sha` 与 run identity 检查。manifest 同时记录
`main_task_stack_size_bytes` 与 `agent_transport_task_stack_size_bytes`，用于确认私密全量配置
没有覆盖仓库的主任务及 Agent worker 栈安全基线；并记录
`dependency_lock_sha256`，用于确认 managed component 解析使用了仓库锁文件。构建后若
`firmware/dependencies.lock` 被解析器改写，workflow 必须失败，不允许隐式组件升级进入硬件验证。
Agent profile 还会写入无凭据的 `agent_harness_status` 与 `agent_hardware_result`；它们仍需和
`monitor.log` 的设备侧、Agent 侧 marker 交叉判定，不能单独替代串口证据。
`phase4c_ha` 还记录 `phase4c_validation_enabled=true`，证明目标实体回刷 marker 来自专用门禁
构建，而不是普通固件日志；`phase4c_agent_transport_disabled`、
`phase4c_policy_binding_verified`、P4 应用离线时的 Robot 结果、
Robot 客户端关闭后的 P4 standalone/8 FPS 状态，以及串口实体 ID 脱敏状态分别记录，不能由单个
在线切换结果替代。Robot 业务 gate 的退出码写入 manifest，不改变 artifact-only workflow 的运输
语义；业务 PASS/FAIL 仍由 manifest 与原始 `VERIFY:` marker 共同判定。
`phase5a_voice` 还记录 `phase5a_validation_enabled=true`、`phase5a_sr_enabled=true`、
`phase5a_audio_selftest_enabled=true` 与 `phase5a_agent_transport_disabled=true`。这些字段只证明专用
构建边界，不能替代非零 PCM、AFE、wake、固定命令、播放和稳态 marker；人工听觉观察也不能由
manifest 推断。
`phase5e_ui` 还记录 `phase5e_ui_input_driver_status=0`、固定 STT 版本、Agent gate 结果与
`phase5e_artifact_audit_status=pass`。Mac input driver 成功只证明测试语音已注入，不能替代 P4 UI
渲染/ACK marker、真实模型调用、HA 读写恢复和 Agent 汇总判定。harness 或 input driver 的业务
失败不会阻断已通过隐私审计的证据上传；隐私审计失败仍会 fail closed 并跳过 Phase 5E artifact。
`product_human` 还记录 `product_human_agent_transport_enabled=true`、
`product_human_agent_protocol_version=3`；兼容字段 `product_human_agent_transport_disabled` 必须为
`false`。这些字段只证明最终 sdkconfig 启用了 Human-avatar v3 transport，不包含私有 Device 端口，
也不证明任一角色动作已发送、完成或被屏幕渲染。`product_human_voice_transport_enabled`、
`product_human_validation_disabled` 与 `product_human_artifact_audit_status` 仍分别证明 Voice 配置、
验证 marker 关闭和发布隐私审计，不能互相替代。
`phase7_autonomy` 还记录 `phase7_artifact_audit_status=pass` 与结构化
`agent_hardware_result`，并以 `capture_actual_seconds` 记录动态提前结束后的实际串口采集时长；
结构化结果中的 HA 字段只有 alias 数量、只读 frame 计数和上述隔离投影
来源，不得包含 token、entity id 或模型请求正文。harness 业务退出码与结果的 `passed` 仍由
Cloud Codex 按原始 marker 复核，不能由 transport job 代判。

## 5. 判定顺序

1. 确认 workflow run 对应待测 commit 和分支；
2. 下载 `esp32-p4-monitor-log`；
3. 先读 manifest，确认 `git_sha`、run id、串口、采集时长和日志文件名；
4. 确认 `monitor.log` 存在且非空；
5. 根据当前任务需要查找稳定 `VERIFY:` 标记与确定性错误；
6. 分别报告 workflow status、artifact integrity、functional verdict 和证据行。

功能结论只能是：

- `pass`：目标行为有明确、无矛盾的强证据；
- `fail`：目标行为明确失败或被日志反证；
- `inconclusive`：执行链成功，但日志不足以判断目标行为；
- `infra-fail`：checkout/build/flash/capture/upload 链路失败。

通用 boot 行只能证明基础设施可启动，不能单独证明功能。优先使用：

```text
VERIFY:<area>:<check>:PASS
VERIFY:<area>:<check>:FAIL reason=<stable_reason>
```

## 6. 最小失败模型

workflow 应在以下情况失败：

- checkout、构建或刷写失败；
- 串口采集脚本失败；
- `monitor.log` 或 manifest 缺失/为空；
- artifact 上传失败。

workflow 不负责判定某个功能是否通过，也不扫描并据此拒绝业务级
`VERIFY:*:FAIL`。这保证同一个传输 workflow 可以服务不同 Phase 和不同验收目标。

本地短回归与 workflow 共用 `scripts/capture-esp-serial.py`，以原始串口方式采集日志，
不依赖交互式 TTY，避免本地 `idf_monitor` 与自托管 runner 的采集行为漂移。
