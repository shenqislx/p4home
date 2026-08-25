# Phase 5E Conversation UI Speakerless Closure

日期：2026-08-25
状态：`local_precommit_pass / real_p4_pending / user_visual_pending`
基线：`feature/agent-harness`，HEAD `7179938ef10528508aafc25034d0f450f23f557a`，dirty worktree

## 结论边界

本记录只证明无扬声器闭环的实现和本地门禁已经完成，不证明真实 P4 功能通过。真实 P4 必须在代码
提交并推送后，用 commit-bound 的 `phase5e_ui` workflow 生成 manifest/串口 artifact，再由 Codex 按
artifact-first 协议判定；用户还需独立观察 P4 对话框的三轮文本。扬声器输出保持 `deferred`。

## 已实现闭环

1. Voice final transcript 继续进入既有统一 Router/Orchestrator；Human、Robot、HA 与 Memory 边界不变。
2. 新增独立 Conversation UI Protocol v1，以 session/stream/epoch/revision 做严格身份与过期 fencing；
   只承载有界 final transcript、Composer 结果、role 和 execution status，不写入 World/Cat speech。
3. P4 Home 页接受更新、切回 Home、更新既有对话框，并在 LVGL 已应用后异步回送 `ui.applied`；
   网络 ACK 不在 LVGL 回调中阻塞。
4. Agent 只有收到匹配 ACK 才记录 `ui_delivery=completed`；Role/HA、UI 和音频投递分别记录，互不伪造。
5. 产品入口使用真实 Ollama、固定 STT、Robot HA、private Memory 和 SQLite；无扬声器模式固定
   `ui_output=required`、`audio_output=disabled`，因此成功结果为 `audio_delivery=deferred`。
6. 独立 `phase5e_ui` 实机 profile 计划依次验证 Robot 只读、低风险写入并恢复、Human 聊天；使用真实
   模型，要求 3 次 P4 UI render/ACK，禁止 playback opened，并对上传候选做凭据/原始音频审计。

## 本地自动化证据

以下命令在 Node `v24.19.0` 下通过：

```text
pnpm typecheck
pnpm test
```

最终 Agent 结果：`417/417 pass`。为避免全量并发负载把既有 Phase 4C 不可用 socket fixture 的
20 ms 测试计时误判为 transport error，仅把该 fixture 的测试时间压缩上限改为 100 ms；产品超时与
运行逻辑未改变。

Python 门禁：

```text
python3 -m unittest discover -s tests/harness -p 'test_*.py' -v
python3 -m unittest discover -s tests/contract -p 'test_*.py' -v
```

结果分别为 `32/32 pass`、`96/96 pass`。workflow YAML 可解析，两个 Python artifact/input driver
脚本通过 `py_compile`。

独立 review 还修复并回归了以下边界：UI/TTS 取消不再覆盖已完成的 Role/HA truth；UI 发送同步失败
会移除 AbortSignal listener；Agent 与 P4 同步拒绝孤立 UTF-16 surrogate；硬件 workflow 不再用
harness 退出码或业务 `VERIFY:` marker 决定传输成功。Phase 5E 隐私审计只决定证据是否可以发布，
业务失败仍可形成 artifact；隐私失败则跳过上传且不会把 monitor tail 打入 Actions 日志。

ESP-IDF v5.5.4 clean temp build：

```text
build_dir=/tmp/p4home-phase5e-ui-build-20260825
sdkconfig=/tmp/p4home-phase5e-ui-sdkconfig-20260825
image=p4home_firmware.bin
image_size=0x169650
partition_free=53%
sha256=35c34a76d4e5de91d821a2411c67d5225e4101bcb75efc10d52d31275c95ea7c
```

构建使用临时 `sitecustomize.py` 让 ESP-IDF component manager 在 macOS managed sandbox 中走其
`os.getppid()` fallback；没有修改仓库、ESP-IDF 安装或受版本控制的 sdkconfig。

## 尚未通过的门禁

- 未提交、未推送，因此不能触发与本次代码绑定的 self-hosted P4 workflow。
- 尚无 `phase5e_ui` 的 `hardware-validation-manifest.json`、原始 `VERIFY:` 串口证据或 Agent gate artifact。
- 尚未由用户观察 P4 对话框中的读、写、聊天三轮显示。
- 扬声器未连接，任何可听输出仍为 deferred；数字链路或 UI 证据不得冒充听觉通过。
- Phase 5 尚未最终 review/关闭，Phase 7 未获授权且没有开始。

## 下一门禁

获得明确提交/推送授权后：提交当前变更并确认远端 SHA，触发
`Firmware Self-Hosted Flash Serial`：`validation_profile=phase5e_ui`、`monitor_seconds=900`，下载
`esp32-p4-monitor-log`，先核对 manifest identity，再判读 3 组 UI markers、真实模型/HA/恢复汇总、
隐私审计、reset/crash 和 playback absence，最后请求用户核对屏幕可见文本。
