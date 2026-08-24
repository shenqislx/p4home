# P4 Home Agent Runtime

Phase 1 至 Phase 4 已关闭，Phase 5 保持 `pending_real_environment`；Phase 6A–6E 的本地实现与
确定性门禁已完成，状态为 `local_complete_pending_real_environment`。当前 workspace 包含冻结契约、Ollama
原生 Tool Calling、有限文本 Agent Loop、Role Contract/Router、Cat P4 World、Robot HA、Role-aware
Voice，以及可追溯/可过期/可删除的 role-scoped Memory。2026-08-24 用户已批准 visibility matrix
v1 保持 `private`；三类 Memory 均保持 owner-role private，跨角色产品召回禁用，
`shared_acl/hybrid` 仅用于 experimental evaluator。确定性测试不要求 Ollama、Home Assistant 或
P4。6F 真实 35B 门禁已通过；6G 真实 HA 只读门禁已本地通过，但仍需 clean commit
复跑。P4/Voice、真实家庭数据、长期 SQLite 与身份验证保持 `pending`。Vector DB 仍不立项；
Phase 7 需另行明确授权且尚未启动。

## 环境

- Node.js 24.19 或更新的 Node 24 LTS 版本；
- pnpm 11.19.0；
- 安装脚本 allowlist 仅允许 `esbuild`，用于 `tsx` 测试加载器。

```bash
cd agent
pnpm install --frozen-lockfile
pnpm typecheck
pnpm validate:contracts
pnpm validate:object-runtime
pnpm validate:ha-runtime
pnpm gate:phase6
pnpm test
```

所有验证入口都会先执行 Node 主版本 preflight，避免 pnpm 管理进程与实际 Runtime 使用不同
Node 主版本时产生假通过。

## 当前分层

- `apps/runtime`：有限文本 Agent Loop、Role Contract/Profile/Router、独立 Role Session、
  Router → Scheduler → Session → Runner/Audit 组合入口、Human 本地输出策略、有界调度、SQLite 审计
  接入与 JSON Lines 结构化日志；
- `apps/eval-cli`：中文黄金场景、Phase 4 和 Phase 6 Memory visibility 评测与单次文本调试入口；
- `apps/device-harness`：Phase 2D 自托管实机门禁入口，使用一次性 TLS/设备凭据执行 100 次动作、
  主动重连与 snapshot 检查；
- `packages/contracts`：AJV 加载并验证仓库根目录冻结的通用、对象运行时与 HA v1 契约；
- `packages/core`：核心实体类型、取消、相对 timeout、最多四项的顺序 Tool Loop；
- `packages/domain-p4home`：无需真实设备的五工具 Mock 与 allowlist；
- `packages/provider-ollama`：原生 HTTP capability probe、generate、chat/tool calling、NDJSON
  stream、`AbortSignal` 取消和相对 timeout；
- `packages/transport-ha`：凭证文件边界、HA WebSocket 鉴权/订阅、逐实体 REST 初始快照、
  allowlist 状态投影与无网络 Fake Transport；4B 由 Runtime 只读消费投影缓存；
- `packages/storage-sqlite`：基于 Node 24 内置 `node:sqlite` 的审计/Memory 存储、schema migration、
  FTS、bounded recall、expiry、revision、lineage 与删除。

Phase 1 至 Phase 4 已按各自证据门禁关闭。Robot 只开放 alias 级
`home.get_entity/turn_on/turn_off/activate_scene`，由固定 policy 映射并以 HA result + 后续状态回刷
判定，accepted/rejected/unknown 不混写且 unknown 禁止自动重放。Phase 5A–5D 技术主体完成，5E
仍为 `pending_real_environment`；该状态不因 Phase 6 本地门禁通过而改变。
任何阶段都不得把 token 暴露给模型、协议 JSON、日志或 artifact。

## Phase 6 本地门禁

```bash
pnpm gate:phase6
```

该入口只执行一次 runtime preflight，随后 fail-fast 执行 typecheck、6B/6C、Memory evaluator、
完整 storage tests 和确定性 Phase 6 eval。eval 先写入同目录临时文件；独立 verifier 再按冻结的
schema/suite、canonical dataset fingerprint、三策略逐 case 结果、private 产品边界、零真实模型
调用、无正文/secret canary 和 mode `0600` 复验，通过后才原子替换
`../evidence/agent-phase-6/phase-6d-memory-eval.json`。固定 artifact 路径若意外成为 SQLite
数据库会拒绝覆盖。该门禁不运行 Ollama、HA、P4 或语音服务，也不替代完整 `pnpm test`。最新本地
gate 通过；最近一次完整测试为 `383/389`，不是 pass；并发运行中的既有 Phase 4 timing/socket 与
WSL Voice 失败均如实保留。复现、隔离结果和所有 `pending` 项见
[Phase 6E local gate evidence](../evidence/agent-phase-6/phase-6e-local-gate.md)。

真实模型与只读 HA + Memory 门禁：

```bash
pnpm eval:phase6-live -- --model qwen3.6:35b-mlx --timeout-ms 300000 \
  --output ../evidence/agent-phase-6/phase-6f-live-model-memory.json
pnpm gate:phase6-ha-live
```

HA 入口要求仓库外的 URL/token/policy/result-file 环境变量，只暴露
`home.get_entity(alias)` 且硬性要求 `service_calls=0`。复现边界和当前证据见
[Phase 6 real-environment gates](../evidence/agent-phase-6/phase-6-real-environment-gates.md)。

产品 Context 的实际固定顺序为：trusted system/safety（含 Role Profile/Tool 边界）→ 独立
untrusted Memory data message → retained recent conversation → 当前 assignment/normalized event。
Memory 有独立角色预算且不能挤占 system、保留会话或当前输入；Router 不构建 Memory context。

Role Router 不向模型提供 Tool，也不依赖 Ollama `format`：历史 27B 已实测会在部分分类样例中违反
`format`。Router prompt 只允许三个精确 JSON，响应仍由 Runtime 使用 JSON Schema/AJV 本地复验；
非法 key、Markdown、ToolCall、thinking 与 provider error 全部闭合到 Human clarification。

运行 Phase 2A 四角色独立评测：

```bash
pnpm eval:roles -- --model qwen3.8:27b-mlx --repeat 2 \
  --output ../evidence/agent-phase-2/qwen3.8-27b-role-eval-v2.json
```

报告分别包含 Router/Human/Robot/Cat，`aggregate_score` 固定为 `null`。Robot 和 Cat 在 2A 只评估
确定性未上线/契约边界，不宣称真实 HA 或 P4 动作已经通过。任一角色存在失败、Router unsafe
misroute、Human policy failure 或禁用调用时，CLI 仍输出完整报告，但以非零状态结束。

## 评测与调试 CLI

默认模型已于 2026-08-24 按用户决策切回 `qwen3.6:35b-mlx`，以适配当前硬件的内存带宽约束；
structured output 或低内存功能 smoke 继续使用 `qwen3:8b`。历史 Phase 1/2 的 27B 评测命令与产物
保留原模型名，不改写既有证据；其中记录的多动作、structured output、延迟和内存退化仍作为
历史对照。Phase 2 起由同一已加载模型服务 Role Router、Robot、Human、Cat，但四者上下文、工具、
temperature、预算与评测独立；任何模型都不能自动承接真实设备动作。两条入口都固定使用
Runtime 的 system prompt、`temperature=0`、`seed=42`、
`num_ctx=8192`、`num_predict=256` 和 `think=false`。后续四个角色可分别调节 temperature，
但所有 Qwen 请求都必须保持 `think=false`。

运行冻结的 32 条中文场景两轮（64 次），保存完整逐例报告：

```bash
pnpm eval:ollama -- --model qwen3.8:27b-mlx --repeat 2 \
  --output ../evidence/agent-phase-1/qwen3.8-27b-mlx-eval-v2.json
```

`--model`、`--case` 可重复；`--limit` 用于前 N 条 smoke，不能和 `--case` 同时使用。
报告区分 exact accuracy、工具名顺序准确率、工具场景精确率、无工具拒绝准确率、契约/provider
错误、空响应、p50/p95 延迟和输出 tokens/s。schema v2 逐例保存模型最终文本，且没有 ToolCall
也没有非空文本的响应不会再计为通过。模型返回的每个调用仍会经过冻结 Tool Schema v1 本地校验。

运行一次真实 Ollama → Mock Tool → SQLite trace 闭环：

```bash
pnpm debug:agent -- --text "去书房，然后说我到了"
pnpm debug:agent -- --model qwen3:8b --text "查询角色状态" --database ./data/debug.sqlite
```

调试入口把结构化审计日志写入 stderr，把结果、Mock 状态和完整 Run trace 写入 stdout；它不会
连接真实 P4 或 Home Assistant。当前模型选择、性能数据和已知失败详见
[Phase 1 model eval](../evidence/agent-phase-1/model-eval.md)。

Provider 的 capability probe 不加载模型；`structuredOutputApi=true` 只表示模型元数据声明
completion API，`structuredOutput` 在这种 metadata-only probe 中保持保守的 `false`，不伪装成
模型已经实测遵循 schema。调用端必须保留本地 JSON/AJV 校验，并在
`INVALID_RESPONSE` 时显式选择已验证模型，不能透传或修补模型原文。

## SQLite 审计与结构化日志

`SqliteAuditStore` 当前数据库 `PRAGMA user_version=4`，使用 WAL、STRICT table、外键和 JSON
有效性约束，保存
AgentProfile、Session、Run、Message、ToolCall、Action 与 Event。Run、Session、Action 的身份字段
不可重写，终态 Run/Action 不可回退；一个 ToolCall 只能从 `pending` 写入一次终态结果。查询
`getRunTrace(runId)` 可获得同一读快照下的完整关联记录。Run 不能在 ToolCall 或 Action 未终止时
结束；前序工具失败导致后续调用未执行时，审计会以合成失败结果终止这些调用，再和 Run 终态原子
提交。同一审计阶段的 Run、Message、ToolCall、ToolResult 和 Event 使用 batch transaction 写入。
历史数据库 schema v2 曾为 Interaction → Run 关联增加可索引查询并按 `run_id` 去重；当前打开
v0/v1/v2/v3 数据库时会在单个 migration transaction 内升级到 v4。Memory record 自身的
`schema_version=1` 与数据库 `user_version=4` 是不同版本轴。
所有 `DatabaseSync` 操作在专用 Worker 中串行执行，SQLite 锁等待不会阻塞主线程的取消、健康检查
和心跳 timer。

默认打开数据库时会原子恢复上次进程遗留的 `pending/running` Run：审计生命周期关闭为失败，
ToolCall/Action 不再保持可执行态，同时 `run.recovered` 及 Tool error details 明确保存
`previous_outcome/outcome=unknown` 和 `replay_allowed=false`。这表示 Runtime 不得把它们盲目重放；
Phase 2 接入真实设备后，物理动作结果仍须通过 `action_id` 和 snapshot 对账。只有并发诊断读取器
才能显式设置 `reconcile_on_open: false`。

调用 `runTextAgent()` 前必须先保存 AgentProfile 和 Session，再通过可选 `audit` 参数接入存储。
审计启用后，system/user/assistant/tool 消息、模型轮次、ToolCall/ToolResult 和 Run 终态都会持久化：

```ts
await using store = new SqliteAuditStore("./data/p4home-agent.sqlite");
await store.saveAgentProfile(profile);
await store.saveSession(session);

const result = await runTextAgent({
  run_id: "run-001",
  user_text: "去书房",
  provider,
  tools,
  audit: {
    store,
    session_id: session.session_id,
    logger: createJsonLineLogger(),
  },
});
```

审计 Session 对应的 AgentProfile `allowed_tools` 是实际授权边界。Runtime 会在 Run 启动时读取
Profile，并只向模型暴露 `allowed_tools` 与传入 `tools` 的交集；缺少 Session/Profile 时拒绝启动。
审计时间会钳制为单调不减，避免系统 wall clock 回拨破坏 Tool outcome。

JSON Lines 日志固定携带 `run_id / session_id`，并在对应阶段携带 `tool_call_id / action_id`；
常见凭证字段会递归脱敏，token 计数等非凭证指标保留。Phase 1 Mock 工具不产生设备 Action，
因此实际 Mock trace 终止于 `tool_call_id`；Phase 2 设备适配器写入 `Action` 后可继续关联
`action_id`，无需修改 schema。SQLite 是审计事实源；可选日志 sink 故障不会改变已持久化的
Run 结果。

其余不影响当前单用户 Demo 的生产化工作记录在
[Agent SQLite Production TODO](../docs/plans/2026-08-16-agent-sqlite-production-todo.md)。

## Ollama Provider

`OllamaHttpProvider` 默认连接 `http://127.0.0.1:11434`，不依赖 Ollama SDK：

- `probe()` 依次读取 `/api/version`、`/api/tags`，仅在模型存在时调用 `/api/show`；
  probe 本身不会加载模型；
- `generate()` 使用 `/api/generate` 的 `stream: false` 响应；
- `chat()` 使用 `/api/chat` 的原生 `tools`、`tool_calls` 与 `format` 字段；
- `stream()` 按 NDJSON 增量解析，要求最终 `done: true` 终态且终态后不得继续输出；携带
  `format` 时会聚合文本并在交付终态块前执行本地 JSON/AJV 校验；
- 不可达、超时、取消、模型不存在、HTTP 错误和非法响应使用稳定错误码；Runtime 将 provider
  失败映射为可审计的 `failed / cancelled / timed_out` 终态；
- Ollama 返回的 ToolCall 必须再次通过冻结 Tool Schema v1；`generate()` 或 `chat()` 只要携带
  `format`，provider 就会强制执行 JSON.parse 和本地 AJV 校验；
- `runTextAgent()` 每个 Run 最多执行 4 个工具、最多 4 个工具轮次，并在每次回送模型前校验
  Tool Result v1。模型只看到冻结目录与当前执行 allowlist 的交集；空最终回复、未知工具、非法
  参数、超预算和非法结果全部 fail closed；
- Core 严格拒绝非有限数或小数 timeout，使用组合 `AbortSignal` 消除取消竞态，并把工具错误
  规范到 Tool Result v1 的 256 字符上限。timeout 只停止 Runtime 等待，工具实现必须在每次外部
  副作用前及每次 await 后协作检查 `context.signal`；真实设备还必须执行 deadline、幂等与恢复对账。

确定性测试不要求 Ollama 服务。真实本机 smoke 必须显式启用：

```bash
P4HOME_OLLAMA_LIVE=1 OLLAMA_MODEL=qwen3:8b pnpm test:ollama-live
```

若 smoke 返回 `UNREACHABLE`，先检查服务而不是重试模型请求：

```bash
curl http://127.0.0.1:11434/api/version
ollama serve
```

本机 Ollama `0.32.6` + `qwen3:8b` 已验证 generate、原生 ToolCall、structured output，以及
“文本请求 → Mock 工具执行 → 最终文本回复”的完整有限闭环。

接口依据：[Ollama API](https://docs.ollama.com/api/introduction)、
[model details](https://docs.ollama.com/api-reference/show-model-details)、
[generate](https://docs.ollama.com/api/generate)、[chat](https://docs.ollama.com/api/chat)、
[tool calling](https://docs.ollama.com/capabilities/tool-calling)、
[structured outputs](https://docs.ollama.com/capabilities/structured-outputs) 和
[streaming](https://docs.ollama.com/api/streaming)。
