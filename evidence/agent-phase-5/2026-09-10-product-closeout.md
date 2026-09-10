# 产品收尾记录（2026-09-10）

## 当前结论

本机保留 `qwen3.6:35b-mlx`、Human/Robot/Cat、Device Protocol v4 和用户已授权的 Robot 局域网 HTTP。Human 使用 Qwen3-TTS Serena，音色已经用户验收。高灵敏度唤醒处于试用状态。Phase 5 继续为 `pending_real_environment`，不以本轮自动化通过代替真人唤醒和日常使用验收。

## 本轮关闭的代码问题

实机只读查询进入 Robot 后，角色执行与屏幕更新均完成，TTS 已生成 133,120 字节，但交互返回 `tts_failed`，没有开始播放。根因是播放协调器仍以 Kokoro 的固定音色表校验，而新 provider/pipeline 返回 Qwen3 的 Vivian。此前仅验证 provider 和 TTS pipeline，没有覆盖到这个模型切换边界。

修复将协调器的音色校验绑定到安装模型的固定 revision，产品组装显式传入同一 revision。Human 流式播报审计也由固定旧音色改为当前模型的 Serena。继续拒绝错误角色音色、错误模型音色和未知 revision，不通过放宽校验绕过边界。

新增回归覆盖：Qwen3 Human/Robot 混合结果实际到达播放回调、错误角色／旧模型音色在播放前被拒绝并清零 PCM、Human 流式审计记录正确音色。

## 自动验证

- Agent 最终完整回归 571/571；协调器定向测试 36/36；TypeScript 类型检查通过。
- Python 合同 117/117；harness 共 95 项，其中 92 项通过、3 项显式真实模型测试默认跳过；这 3 项随后用固定本机模型单独运行，3/3 通过。
- 初次 Agent 全量命令从仓库根目录运行，3 项依赖 Agent 工作目录的子进程入口失败；按 workspace 正常入口从 `agent/` 重跑后 568/568。修复协调器并增加 3 项回归后为 571/571。首次失败日志保留，不属于产品运行时故障。
- 固件使用 ESP-IDF v5.5.4，在全新临时 build 目录按显式产品配置重新生成 SDKCONFIG 并编译通过，依赖锁未变化。新产物 3,019,824 字节，应用分区剩余 125,904 字节（约 4%）；没有因收尾增加固件功能。
- 本轮仅更新 Agent，未刷入新的构建产物。新构建 SHA-256 为 `235e862410770520f84aa4cb579f03e0e7383947e858a22a878228ceb5b618c9`；实际在 P4 测试的应用仍为 `2a09472524d3ec37d5da035de8732ce5170e410d2517b4f6a6842635a3e243bb`。两者不混用身份；日期、ELF hash、镜像校验区域存在差异。

## 实机复验

保留两类失败：修复前 Robot 查询语义和 UI 成功而播放失败；修复后首次输入驱动在唤醒后才生成提问音频，错过收音窗口，返回 `too_short`，未派发角色。已将驱动改为唤醒前生成固定音频，后续结果另存，不覆盖失败证据。

修复后三条完整语音复验均通过：

| 场景 | epoch | 语义／工具 | UI／音频 |
|---|---|---|---|
| 查询书房顶灯状态 | 12845057 | Robot completed，`home.get_entity` success | completed／completed，130,560 PCM 字节 |
| 你好 | 12845058 | Human completed，无执行工具 | completed／completed，145,920 PCM 字节 |
| 请走到客厅 | 12845059 | Human completed，`character.go_to_room` success | completed／completed，64,000 PCM 字节 |

全部声学输入为 Mac 播放的固定合成测试短句，不是用户真人口播，也不替代 P4 听感或屏幕肉眼观察。Robot 场景只读取既有白名单灯态，不发送开关动作。该复验关闭新 TTS 模型下的 Robot 播放阻断，不覆盖所有复杂语句或现场多说话人情况。

终态后继续观察 35 秒：三次播放均有 `wake_resumed`，HA 保持 READY、设备侧 `service_calls=0`，本轮累计 13 个 UI 8 FPS PASS，没有捕获 panic／watchdog／栈破坏标记。Cat 控制接口最终为 `enabled`、`product_ready=true`、`ingress_inflight=0`。这是短时回归，不是长稳验收。

## 文档与交付

已同步 README、AGENT、架构 v4 状态、当前计划、里程碑和产品使用入口，区分默认 Human-only 安装与当前显式三角色部署，明确产品半双工行为。保留此前阶段、失败运行与延期事实。Serena 验收不扩大为 Robot Vivian 或整体语音体验验收。

本轮改动仍在 `feature/agent-harness` 本地工作区，未提交、未推送、未合并。凭据和真实麦克风音频不进入受版本控制的记录；本地原始串口含设备信息，只保存在已忽略目录。

## 仍未关闭

| 项目 | 现有证据 | 状态 |
|---|---|---|
| 真人唤醒 | “嗨小星”、20 cm、未播报时 10 次仅 1 次成功 | 高灵敏度已试用，用户本轮不方便复测，改善未确认 |
| 现场其他声音 | 用户确认其他声音导致误识别 | 单麦克风无说话人隔离，未解决；纯噪声过滤不计作解决 |
| Robot 音色 | Vivian 已接入 | 人工听感未验收 |
| 日常对话体验 | 已有机器时序与多轮交付记录 | 首声体感、长停顿句、失败恢复人工观察仍待确认 |
| 真实断线与长跑 | 既有本地 holdout 与历史实机证据 | 保留计划中的延期项，不以短句复测替代 |
| Phase 5 最终关闭 | 本地与实机分项证据 | 未满足全部退出门禁，保持待真实环境验收 |

## 证据入口

原始文件位于本地已忽略的 `evidence/product-closeout-20260910/`：完整测试日志、`build-summary.json`、前后声学结果和串口、`working-files-secret-audit.json`。本次工作文件敏感检查只覆盖修改及新增的非忽略文件，检查实际私有凭据原文与 Base64；不声称重新完成所有历史 Git、运行日志、SQLite 或进程参数的全面审计。

最终 `closure-manifest.json` 绑定运行源码、已刷／新构建镜像、日志哈希和三条语义结果。修改文档的 82 个本地链接均可解析，工作文件未检出上述实际私有凭据，`git diff --check` 通过。

此前的 [三角色启用](2026-09-10-three-role-enablement.md)、[中文 TTS](2026-09-10-qwen3-tts.md)、[唤醒与识别](2026-09-10-wake-stt-followup.md) 保留各自测量与验收边界。
