# Agent Phase 1 — Text Agent Runtime Plan

> Status: `in_progress`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 0 complete

## 1. 目标

在不连接真实 P4 的前提下，建立可测试的 TypeScript Agent Runtime，跑通文本输入、Ollama 原生 Tool Calling、Mock Character Tool 和有限执行循环。

## 2. 实施步骤

1. 建立 Node.js 24.19 LTS workspace 与 `apps/runtime`、`packages/core`、`contracts`、`provider-ollama`、`domain-p4home`、`storage-sqlite`；
2. 导入并验证 Phase 0 的 JSON Schema；
3. 实现 `AgentProfile / Session / Run / ToolCall / Action / Event` 类型；
4. 实现带 `AbortSignal`、相对 timeout、每轮最多 4 个顺序 ToolCall 的 Run Loop；
5. 实现 Ollama capability probe、generate、stream/cancel 能力边界；
6. 接入原生 tool calling 与 structured output 校验；
7. 实现 mock character tools 与安全 allowlist；
8. 用 SQLite 保存 session、run、message、tool call 和审计事件；
9. 增加结构化日志，贯通 `run_id → tool_call_id → action_id`；
10. 建立中文黄金场景 eval，比较 8B/14B/30B 候选的准确率与延迟；
11. 提供 CLI 或最小 HTTP 调试入口；
12. 文档化启动、配置、测试与故障排查。

## 3. 当前进展

- [x] 建立 Node.js 24.19 + pnpm 11 TypeScript workspace 与分层目录；
- [x] 使用 AJV 2020 导入并验证冻结的 Device Protocol v1 与 Tool Schema v1；
- [x] 定义 `AgentProfile / Session / Run / ToolCall / Action / Event` 核心类型；
- [x] 实现 `AbortSignal`、相对 timeout、重复 ID 拒绝和最多四项的顺序 Tool Loop；
- [x] 实现不连接真实 P4 的五工具 Mock、房间 allowlist 与精确错误码；
- [x] 实现 Ollama capability probe、generate、stream 与 cancel；
- [x] 接入 Ollama 原生 chat/tool calling、本地 structured output 校验与有限文本 Agent Loop；
- [x] 实现 SQLite 审计存储与结构化日志；
- [x] 建立模型 eval、性能基线与最小调试入口。

实际结果（2026-08-16）：Node runtime 已由 22.16 统一升级到 24.19 LTS，preflight 精确通过 `24.19.0`；AJV 报告 14 种消息、
17 条合法 fixture、6 条非法 fixture、5 个工具与 32 条 golden intents 全部符合冻结契约；
TypeScript 严格类型检查通过，首批 8 项测试覆盖顺序执行、失败即停止、重复 ID、四项上限、
相对超时、取消、Mock 房间移动/说话和未知房间拒绝。依赖锁已生成，pnpm 安装脚本 allowlist
仅包含 `esbuild`。升级后在 Node 24.19.0 下重新执行 runtime preflight、严格类型检查、契约校验
和 8 项 Agent 测试，并回归既有 30 项协议测试与 2 项 harness 测试，全部通过。

Ollama provider 里程碑（2026-08-16）：使用 Node 原生 `fetch` 实现 `/api/version`、
`/api/tags`、`/api/show` 的无模型加载 probe，以及 `/api/generate` 的非流式响应和 NDJSON
流式解析；外部取消、100–600,000 ms 相对 timeout、模型不存在、HTTP 失败、不可达与非法响应
均映射为稳定错误码并 fail closed。新增 11 项 provider 测试，覆盖传输分片、缺少终态、generate
和 stream 取消等边界。本机 Ollama `0.32.6` 使用已安装的 `qwen3:8b` 完成 1 项显式 live smoke，
probe 返回 `completion / tools / thinking`，冷启动 probe + generate 用例约 4.6 秒。该数字不是正式
性能基线；运行日志显示模型上下文被钳制到 40,960、KV cache 约 5.76 GiB，模型对比阶段必须
固定 `num_ctx` 后重新测量。

Tool Calling 里程碑（2026-08-16）：`/api/chat` 已支持 system/user/assistant/tool 历史、原生
function tools、tool calls、thinking、`format` 与固定 `num_ctx`。Runtime 从冻结 Tool Schema v1
生成模型可见的五工具目录；模型返回值先拒绝未知工具、非法参数和单轮超过四项，再生成稳定
`tool_call_id` 顺序调用 Mock 执行器；Tool Result v1 再校验通过后才会回送模型。整个文本 Run
最多四个 ToolCall、四个工具轮次，超预算 fail closed。structured output 即使由 Ollama `format`
约束，也会再次执行 JSON.parse + AJV 2020 本地校验。

新增后的确定性测试为 30 项，覆盖原生 chat 请求/响应、非法工具调用、冻结契约桥接、structured
output、完整 Mock 闭环及跨轮预算。本机 Ollama `0.32.6` + `qwen3:8b` 的 4 项显式 live 回归
全部通过：generate smoke 约 2.74 秒、原生 ToolCall 约 2.28 秒、structured output 约 0.61 秒，
“文本请求 → 去书房 Mock Tool → 最终回复”的有限闭环约 1.86 秒。该次服务最初未运行，启动
`ollama serve` 后通过；这些单次数字只作功能证据，不替代第 10 步的正式 p50/p95 模型评测。

边界 review 修复（2026-08-16）：关闭 7 个 chat/tool/loop 异常路径缺口，并将同类修复扩展到
`generate`。携带 `format` 的 generate/chat 现在由 provider 强制执行本地 JSON/AJV 校验；模型
可见工具与 Runtime allowlist 求交集；空最终回复不再标记成功；provider 的取消、超时和传输错误
映射为可审计 Run 终态。Core 会将任意工具错误规范到 Tool Result v1 的 256 字符上限，拒绝
`NaN`、Infinity 和小数 timeout，并使用组合 `AbortSignal` 消除查找工具期间的取消竞态。新增
11 项回归后，确定性测试为 41 项；本机 `qwen3:8b` 的 4 项真实回归仍全部通过，测试后已停止
临时 Ollama 服务。

SQLite 审计里程碑（2026-08-16）：基于 Node 24 内置 `node:sqlite` 完成 schema version 1，使用
WAL、STRICT table、外键、JSON 校验和关联索引保存 AgentProfile、Session、Run、Message、
ToolCall、Action 与 Event；`getRunTrace()` 可按 Run 还原完整消息、工具、Action 和事件链。写入层
禁止修改 Session/Run/Action 身份、禁止终态生命周期回退，并确保每个 ToolCall 只能从 pending
进入一次 success/error。构造或 migration 失败会关闭数据库句柄，正常路径支持显式资源释放。

Runtime 的可选 audit 接口已记录 system/user/assistant/tool 消息、模型请求与响应、ToolCall、
ToolResult 和 Run 终态；抛出的 schema/contract 异常也会留下 `run.failed`。JSON Lines 日志固定关联
`run_id / session_id`，按阶段携带 `tool_call_id / action_id`，递归脱敏 token、password、secret
等凭证字段但保留 token 计数。Phase 1 Mock 不产生设备 Action，实际闭环止于 tool_call_id；
Action 表和日志字段已验证 `run_id → tool_call_id → action_id` 外键关系，Phase 2 可直接接入。

新增 9 项后确定性测试为 50 项，Node 24.19.0 严格类型检查通过；既有 30 项协议测试和 2 项
harness 测试继续通过。本机 Ollama `0.32.6` + `qwen3:8b` 的 4 项显式 live 回归全部通过，
其中有限文本 Agent Loop 已同时断言真实模型 ToolCall 的 SQLite 终态 trace；测试后已停止临时
Ollama 服务。

SQLite 风险边界修订（2026-08-16）：优先关闭会影响当前 Demo 的问题。Runtime 现在从审计
Session 读取 AgentProfile，并以 `allowed_tools` 和进程工具表的交集构造模型可见及可执行工具；
Run 启动、模型完成、Tool 请求/结果和 Run 终态分别通过 batch transaction 原子写入。Tool 事件
在 SQLite payload 中保存 `tool_call_id`；Run 终止前检查不存在 pending ToolCall 或未终止 Action；
审计时间对 wall clock 回拨执行单调钳制；`getRunTrace()` 改为直接按 `run_id` 在同一读快照查询。
`failed / cancelled / timed_out` 使用独立终态事件，不再伪装为 `run.completed`。

新增 6 项风险回归后确定性测试为 56 项，覆盖 Profile 越权、回拨时钟、provider timeout 终态、
pending ToolCall 拒绝、batch rollback 和并发终态写入前的 trace 快照。同步 SQLite Worker、数据库
身份与 migration、文件权限/加密、Profile revision、断电耐久、配额/分页和启动 reconciliation
等生产化事项延后，并记录在
[Agent SQLite Production TODO](./2026-08-16-agent-sqlite-production-todo.md)。修复后再次执行本机
`qwen3:8b` 的 4 项显式 live 回归，真实 ToolCall + Mock Tool + SQLite trace 闭环全部通过，临时
Ollama 服务已停止。

模型 eval 与调试入口里程碑（2026-08-16）：新增 `apps/eval-cli`，从冻结契约读取 32 条中文
golden intents 和五工具目录；评测固定 Runtime system prompt、`temperature=0`、`seed=42`、
`num_ctx=8192`、`num_predict=256`，逐例执行本地 Tool Schema 校验，分别汇总 exact、工具名顺序、
工具场景、无工具拒绝、provider/contract error、p50/p95 和 tokens/s。CLI 支持多模型、单场景、
前 N 条、1–10 轮重复和 JSON 证据输出；标准 pnpm `--` 参数分隔符已回归验证。

Apple M4 Pro 14 核、64 GB 本机对已安装的 `qwen3:8b`、`qwen3-coder:30b`、
`qwen3.6:35b-mlx` 做了固定上下文对照；缺失的 14B 未临时下载。选定 35B MLX 为开发默认，8B
只作 structured-output/低内存功能 fallback，且不得自动承接真实 Action。默认模型最终 64 次
结果为 exact 73.44%、工具名顺序 82.81%、工具场景
75%、无工具拒绝 70%，contract/provider error 均为 0，p50 538 ms、p95 1,420 ms、
64.03 output tokens/s，Ollama 常驻约 25 GB。32 个场景中 30 个在两轮间返回相同 ToolCall，
重复一致率 93.75%；固定 seed 不能保证该模型完全确定。当前 Mock Demo 门槛定为 contract/provider error=0、
exact≥70%、工具名顺序≥80%；均已通过。无工具拒绝尚未达到真实动作安全要求，接入 Phase 2
设备 Action 前必须增加确定性策略/确认门禁并重新评测，不得仅依赖模型判断。

最小调试 CLI 已用默认模型跑通“去书房，然后说我到了”：首轮生成两个有序 ToolCall，Mock
执行成功，第二模型轮返回最终文本，SQLite trace 包含完整消息、两个 ToolCall 和十个 Event，且
没有真实 P4/HA Action。35B live 的 generate、ToolCall 和完整 Loop 通过，但它忽略 structured
output JSON Schema，provider 正确返回 `INVALID_RESPONSE`；8B 的 4 项 live（含 structured
output 本地 AJV 复验）全部通过。详细数据、候选比较和失败场景见
[Phase 1 model eval](../../evidence/agent-phase-1/model-eval.md)。下一项为第 12 步文档收尾与 Phase 1
整体 review；仍不启动真实 P4 WebSocket。

整体 review 修订（2026-08-16）：修复多调用首项失败或非法 Tool Result 时审计残留 `pending`、
Run 无法终止的问题；未执行调用现在以合成失败结果和 Run 终态原子提交。Provider stream 对完整
structured output 执行 JSON/AJV 校验并拒绝终态后的额外数据；metadata-only capability probe 不再
把 completion 声明误报成已验证 structured output；cancel/timeout 同时发生时按首个 abort 来源
分类。协议门禁新增 invalid fixture 预期 AJV 路径、fixture/golden ID 唯一性、tool/no_tool 互斥与
调用上限检查。评测报告升级为 schema v2，保存最终文本并拒绝空无工具响应。

修复后 Node 24.19.0 严格类型检查和 65 项确定性测试通过。8B 与 30B Coder 在同一当前提示词、
同一 32 场景、各两轮下重新评测；35B 默认模型也完成 v2 两轮回归，仍为 exact 73.44%、工具场景
75%、工具名顺序 82.81%、无工具安全拒绝 70%，contract/invalid/provider error 均为 0。工具 timeout
只能停止 Runtime 等待，不能强制终止忽略 AbortSignal 的任意 Promise；内置 Mock 已在副作用前检查
signal，真实设备必须在 Phase 2 通过 deadline、action_id 幂等和 reconciliation 关闭该物理边界。

## 4. 验证

- 单元测试：schema、budget、cancel、duplicate call、policy；
- 集成测试：Ollama 正常、不可达、超时、非法 ToolCall；
- 场景测试：至少 50 次中文意图，无不存在工具执行；
- 性能：记录首 ToolCall p50/p95、tokens、常驻内存；
- 安全：模型不可读取 token 或执行任意 HA/service/shell。

## 5. 完成定义

- [x] 选定默认开发模型与降级模型；
- [x] ToolCall schema 成功率达到 Mock Demo 约定门槛；
- [x] timeout/cancel/budget 可重复验证；
- [x] Runtime 无需真实 P4 即可完成全套测试；
- [ ] 用户 review 通过后启动 Phase 2。
