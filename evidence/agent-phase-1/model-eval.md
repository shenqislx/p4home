# Agent Phase 1 模型评测与调试闭环

> Date: 2026-08-16
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
- `qwen3-coder:30b` 不作为 fallback：占用接近 35B，但工具场景准确率更低；
- Mock Demo 验收门槛为 contract/provider error=0、exact≥70%、工具名顺序≥80%，35B 已通过；
- 失败主要集中于 `character.say` 末尾标点、多动作遗漏，以及沙发/随便/条件委托等应拒绝场景；
- `zh-030` 隔离复测会把“保持清醒”误映射为不相关 `character.say`；最终两轮一次正确、一次复现，
  确认是模型非确定性输出问题，不是评测器跨场景共享历史；
- 35B 的 Ollama 模板声明 completion/tools，但实测忽略 structured-output schema，返回 fenced JSON
  且字段错误；provider 正确 fail closed 为 `INVALID_RESPONSE`。capability probe 不加载模型，
  `structuredOutput=true` 只表示 Ollama API 接受 `format`，模型遵循度必须由 live test 验证；
- 真实设备 Action 不能沿用 70% 无工具拒绝率。Phase 2 必须由确定性策略或明确确认把安全集提升到
  100%，任何模型误调用都不得到达 Device WebSocket。

## 调试闭环

`pnpm debug:agent -- --text "去书房，然后说我到了"` 使用默认模型完成两轮模型请求：第一轮按
顺序生成 `character.go_to_room(study)`、`character.say("我到了")`，两个 Mock Tool 均成功；
第二轮返回最终文本。SQLite 审计记录 system/user/assistant/tool 消息、2 个 ToolCall 和 10 个
Event，Run 终态为 `completed`，Action 为空，证明该入口未连接真实设备。
