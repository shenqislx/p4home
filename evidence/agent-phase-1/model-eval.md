# Agent Phase 1 模型评测与调试闭环

> Updated: 2026-08-17
> Scope: Ollama 原生 Tool Calling + Mock P4 Home；不连接真实 P4/HA

## 环境与方法

- Mac mini，Apple M4 Pro（14 核），64 GB 统一内存；
- Node.js 24.19.0，Ollama 0.32.6，arm64；
- 冻结 Tool Schema v1：5 个工具、32 条中文 golden intents；
- 固定 `temperature=0`、`seed=42`、`num_ctx=8192`、`num_predict=256`；
- 每次请求只携带 system + 当前 user 消息，不跨场景共享对话历史；
- 模型输出逐次通过本地 AJV Tool Schema 校验，再比较工具名、顺序和参数；
- 14B 候选未安装，因此没有下载；只测本机已有候选。

原始完整逐例证据：

- [qwen3:8b 初始 64 次](./qwen3-8b-eval.json)
- [qwen3-coder:30b 初始 32 次](./qwen3-coder-30b-eval.json)
- [qwen3.6:35b-mlx 初始 32 次](./qwen3.6-35b-mlx-eval.json)
- [qwen3.6:35b-mlx 最终 64 次](./qwen3.6-35b-mlx-eval-final.json)
- [8B 与 30B Coder schema v2 同口径 128 次](./qwen3-8b-vs-coder-30b-eval-v2.json)
- [qwen3.6:35b-mlx schema v2 最终 64 次](./qwen3.6-35b-mlx-eval-v2.json)
- [qwen3.8:27b-mlx schema v2 最终 64 次](./qwen3.8-27b-mlx-eval-v2.json)
- [qwen3.6:35b-mlx 在 Ollama 0.32.14 的同环境复测](./qwen3.6-35b-mlx-eval-v2-ollama-0.32.14.json)

## 候选对照

初始同提示词对照用于筛选候选；准确率均为工具名、顺序和参数完全一致：

| 模型 | 次数 | exact | 工具场景 exact | 无工具拒绝 | p50 | p95 | output tok/s | 常驻 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `qwen3:8b` | 64 | 59.38% | 68.18% | 40% | 719 ms | 1,710 ms | 45.09 | 6.6 GB |
| `qwen3-coder:30b` | 32 | 59.38% | 59.09% | 60% | 656 ms | 1,221 ms | 73.86 | 19 GB |
| `qwen3.6:35b-mlx` | 32 | 62.50% | 68.18% | 50% | 531 ms | 1,351 ms | 68.39 | 25 GB |

统一并强化 Runtime/评测提示词后，35B 最终两轮结果：

| 指标 | 结果 |
|---|---:|
| 总次数 / 通过 | 64 / 47 |
| exact accuracy | 73.4375% |
| 工具名顺序准确率 | 82.8125% |
| 工具场景 exact | 75% |
| 无工具拒绝 | 70% |
| contract / provider errors | 0 / 0 |
| 全场景 p50 / p95 | 538 ms / 1,420 ms |
| 工具场景 p50 / p95 | 538 ms / 1,422 ms |
| 输出速度 | 64.03 tokens/s |
| Ollama 常驻 / context | 25 GB / 8192 |
| 两轮 ToolCall 重复一致率 | 93.75%（30/32） |

首次加载或多模型互相换出后的单请求曾观察到约 6–11 秒，因此上述 p50/p95 主要代表模型常驻后
的交互延迟。`zh-018` 与 `zh-030` 在两轮间返回不同调用，证明即使固定 temperature/seed，当前
Ollama + 35B MLX 组合也不是完全确定性的；门槛必须按多轮统计，不能依赖单次通过。

## 结论与边界

- 默认 ToolCall 开发模型：`qwen3.6:35b-mlx`。在当前机器上热态延迟、路由准确率和拒绝能力
  综合最佳；
- structured-output/低内存 fallback：`qwen3:8b`。常驻仅约 6.6 GB，4 项 live 全部通过；但无工具
  拒绝明显不足，不能作为真实 Action 的自动安全降级；
- `qwen3-coder:30b` 不作为 fallback：本机模型是 30.5B 总参数、每 token 仅激活约 3.3B 的 MoE
  （[Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct)），
  不是 30B 稠密模型；占用接近 35B，但当前房间路由工具场景准确率更低；
- Mock Demo 验收门槛为 contract/provider error=0、exact≥70%、工具名顺序≥80%，35B 已通过；
- 失败主要集中于 `character.say` 末尾标点、多动作遗漏，以及沙发/随便/条件委托等应拒绝场景；
- `zh-030` 隔离复测会把“保持清醒”误映射为不相关 `character.say`；最终两轮一次正确、一次复现，
  确认是模型非确定性输出问题，不是评测器跨场景共享历史；
- 35B 的 Ollama 模板声明 completion/tools，但实测忽略 structured-output schema，返回 fenced JSON
  且字段错误；provider 正确 fail closed 为 `INVALID_RESPONSE`。capability probe 不加载模型，
  现在仅以 `structuredOutputApi=true` 表示 API 声明，并让未经 live 验证的 `structuredOutput=false`；
- 真实设备 Action 不能沿用 70% 无工具拒绝率。Phase 2 必须由确定性策略或明确确认把安全集提升到
  100%，任何模型误调用都不得到达 Device WebSocket。

## schema v2 同口径复测与真值边界

修复评测器后，逐例证据会保存 `actual_text`，没有 ToolCall 且最终文本为空时记为
`invalid_response`；8B、30B Coder 均使用当前同一 system prompt、同一 32 条场景、各两轮：

| 模型 | exact | 工具场景 exact | 工具名顺序 | 无工具安全拒绝 | p50 / p95 |
|---|---:|---:|---:|---:|---:|
| `qwen3:8b` | 53.13% | 72.73% | 68.75% | 10% | 705 / 1,687 ms |
| `qwen3-coder:30b` | 46.88% | 59.09% | 62.50% | 20% | 583 / 1,301 ms |
| `qwen3.6:35b-mlx` | 73.44% | 75% | 82.81% | 70% | 546 / 1,414 ms |
| `qwen3.8:27b-mlx` | 78.13% | 68.18% | 81.25% | 100% | 1,276 / 2,406 ms |

8B 与 30B 的参数完全匹配错误均为 10/44；差距来自工具选择/序列错误：8B 为 2/44，30B 为
8/44。30B 会把“待一会儿/等着”扩展成额外 `set_activity`，把“醒醒”改成状态查询，并在角色状态
查询后追加世界快照。这与其 agentic coding 训练偏好的主动检查、规划和追加工具行为一致，但违反
当前路由器“只执行用户明确要求动作”的真值策略。两轮各自 32/32 ToolCall 一致，说明这次差异
不是单次随机波动；但 32 条样本仍不足以外推通用工具能力。

参考真值来自冻结 Tool Schema v1 的五个工具、参数枚举、每轮顺序/失败即停策略，以及 Phase 1
明确排除 HA、任意房间和推断动作的安全边界。加载门禁会校验工具/场景 ID 唯一性、调用数量、参数
schema、tool/no_tool 互斥和 invalid fixture 的预期 AJV 失败路径。因此它对“本项目 v1 契约是否
精确匹配”是可靠的回归真值。

它不是独立、充分的通用模型基准：32 条由项目内人工编写，没有盲测集、真实用户分布、多人标注
一致性或语义等价评分；严格 exact 会把 `你好呀` 与 `你好呀。`、`饭好了吗` 与 `饭好了吗？`
判成不同结果；无工具指标只证明没有产生动作，不能证明解释文字完全正确。后续模型选型应增加未参与
提示词调优的 holdout、口语改写/对抗样本、至少两名人工复核和多轮置信区间。

## qwen3.8:27b-mlx 候选复测

2026-08-17 使用本机 Ollama 0.32.14 对已安装的 `qwen3.8:27b-mlx` 执行同一 schema v2 冻结评测。
`ollama show` 报告该 tag 为 27.8B、NVFP4，声明 completion、vision、tools 和 thinking。四项 live
smoke 中 capability/generate、原生 ToolCall 和完整 Mock Agent Loop 通过；structured output
返回非 JSON，provider 正确 fail closed 为 `INVALID_RESPONSE`，因此结果为 3/4。

旧 35B 基线来自 Ollama 0.32.6。为避免把 runner 版本差异误判为模型差异，又在当前 Ollama
0.32.14 下用同一参数重跑 35B 两轮；新结果为 exact 75%、工具场景 77.27%、工具名顺序 85.94%、
无工具拒绝 70%、p50/p95 561/1,410 ms、60.15 tokens/s。以下对照均使用这份同环境结果：

| 指标 | 27B MLX | 当前 35B MLX | 差异 |
|---|---:|---:|---:|
| exact | 78.13% | 75% | +3.13 pp |
| 工具场景 exact | 68.18% | 77.27% | -9.09 pp |
| 工具名顺序 | 81.25% | 85.94% | -4.69 pp |
| 无工具拒绝 | 100% | 70% | +30 pp |
| contract / invalid / provider error | 0 / 0 / 0 | 0 / 0 / 0 | 相同 |
| p50 / p95 | 1,276 / 2,406 ms | 561 / 1,410 ms | 约 2.27x / 1.71x |
| output tokens/s | 27.54 | 60.15 | 约为 46% |
| Ollama 运行态 SIZE | 31 GB | 28 GB | +3 GB |

27B 的 32 个基础场景在两轮中 ToolCall 和最终文本全部一致；同环境 35B 为 27/32。它在 10 个
无工具基础场景的两轮中全部拒绝动作，是当前候选里最好的安全路由结果；但这只有 10 个独立负例，
不能替代 Phase 2 的确定性策略/确认门禁。

错误也高度集中且可解释：单动作场景 24/26 通过；两动作只有 6/14，通过率 42.86%；三动作 0/4。
除 `zh-010` 保留了用户输入末尾句号外，其余失败均是在首轮只返回第一个 ToolCall。补跑完整 Agent
Loop 后，模型会在收到第一个工具结果后于第二轮补发 `character.say`，第三轮结束 Run，能够完成
两个动作，但把 `我到了` 改成 `我到了。`，仍违反逐字复制约束，而且增加模型轮次和端到端延迟。

评测请求固定 `num_ctx=8192`，但 `ollama ps` 在完成请求后报告 27B 运行态 CONTEXT 为 262,144、
SIZE 为 31 GB；同一时刻 35B 为 8,192、28 GB。故本次准确率仍与冻结输入口径可比，但 27B 的
内存和速度不能解释为严格的 8K context 资源基线；在确认该 MLX tag/runner 是否接受 `num_ctx`
前，不用它替换当前 35B 默认模型。

综合裁决：保留 `qwen3.6:35b-mlx` 作为默认 ToolCall 开发模型；`qwen3.8:27b-mlx` 记录为高拒绝、
高稳定候选，不作为 structured-output 或低内存 fallback。Phase 2 确定性策略建立后，应增加 holdout
负例和多动作端到端成功率，再决定是否切换默认模型。

## 调试闭环

`pnpm debug:agent -- --text "去书房，然后说我到了"` 使用默认模型完成两轮模型请求：第一轮按
顺序生成 `character.go_to_room(study)`、`character.say("我到了")`，两个 Mock Tool 均成功；
第二轮返回最终文本。SQLite 审计记录 system/user/assistant/tool 消息、2 个 ToolCall 和 10 个
Event，Run 终态为 `completed`，Action 为空，证明该入口未连接真实设备。
