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
| `validation_profile` | `generic` | `generic`、`phase2d_agent`、`phase3d_object` 或 `phase4c_ha` |
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
