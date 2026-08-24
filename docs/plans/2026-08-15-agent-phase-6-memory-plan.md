# Agent Phase 6 — Memory Plan

> Status: `local_complete_pending_real_environment`
> Started: 2026-08-24
> Current Gate: 6F 真实模型和 6G HA 提交绑定只读门禁已通过；6I 文件系统子门禁本地通过、
> 待 clean-commit 复跑；其余真实环境证据 pending；
> Phase 7 等待另行明确授权
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2 stable; Router/Robot/Human/Cat 专项 eval 骨架 established
> Execution Environment: 6A–6E 为 WSL2 本地/模拟验证；6F/6G/6I 已在 macOS 真实环境执行；
> P4/Voice、家庭数据、剩余 SQLite 生产耐久及身份门禁保持 `pending`

2026-08-24 已启动独立的
[Phase 6 真实环境门禁计划](./2026-08-24-agent-phase-6-real-environment-gates-plan.md)。
6F 真实 35B + 脱敏合成 Memory 门禁已通过；6G 真实 HA 只读真值门禁已从
干净工作树复跑通过并绑定提交 `7e9aa4d`。6I 的 APFS 权限、WAL/NORMAL、受控
`SIGKILL`、完整性/损坏拒绝、在线备份和 checkpoint 冷备份子门禁已本地通过，待 clean-commit
复跑；P4/Voice、真实家庭数据、剩余 SQLite 生产耐久与家庭身份门禁继续 `pending`。

## 1. 目标

引入可追溯、可过期、可删除的长期记忆，不把 World State 或秘密误当 Memory；通过评测决定
Robot/Human/Cat 使用共享、分离还是混合记忆，不预先让角色互读。

## 2. 执行原则

1. 默认 `owner_only`，任何跨角色召回必须经过显式 projection policy；本 Phase 完成前产品默认仍不跨角色；
2. Router 不读写 Memory；World State、HA 实时状态、token、密码和原始音频不得进入 Memory；
3. 三种可见性方案复用同一 canonical record，不复制三份物理数据；
4. 删除必须同时影响结构化记录、标签、全文索引和所有 projection；SQLite/WAL 的取证级擦除另列生产门禁；
5. 每个 stage 完成编码和本地验证后，启动独立 subagent 进行 code review，并在进入下一 stage 前修复发现；
6. WSL2 不具备的真实环境验证不得伪装为通过，统一保留为 `pending` 并记录所需环境。

## 3. 纵切 6A — Memory Contract & SQLite Store

- [x] 定义 `conversation_summary`、`user_fact`、`task_outcome` 及 source、confidence、timestamps、
  expiry、sensitivity、owner_role、visibility_scope、source_interaction_id、policy revision；
- [x] SQLite schema 升级并支持 canonical Memory、标签、FTS、过期过滤、乐观 revision 和硬删除；
- [x] 所有查询有稳定上限；普通读取在 SQL 内强制 owner-only，不提供跨角色开关；
- [x] Worker 与同步 Store API 一致，覆盖创建、读取、更新、分页、搜索、删除和过期清理；
- [x] 覆盖迁移、中文搜索、非法输入、角色隔离、过期边界、删除与重开持久化测试；
- [x] 独立 subagent review 完成，确认问题已修复并补回归测试。

6A review（2026-08-24）：

- 将 v1→v2→v3 合并到同一 `BEGIN IMMEDIATE` migration transaction，新增中途 DDL 失败时
  `user_version`、审计数据、索引和部分 Memory table 全量回滚测试；
- 收紧 restricted/ACL、空查询数组、no-op update、policy revision 回退等输入，并在 SQLite
  schema 增加 restricted scope CHECK 与 ACL trigger；
- owner-only `get/list/search/update/delete` 保持 SQL 级 owner filter；即使记录预置
  `explicit_roles`，6A 仍不能跨角色读取或更新；
- Memory 复合读取使用单一 read transaction；并发同 revision 更新仅允许一个成功；
  FTS 查询只接受转义后的字面量，更新、删除和 purge 后由 trigger/cascade 同步清理；
- Worker operation/args 改为映射联合类型，初始化完成前已开始的请求会在 close 前排空，
  初始化/运行失败继续向调用方传播；
- WSL2 已安装项目要求的 Node v24.19.0、pnpm 11.19.0 和锁定依赖；`pnpm typecheck`
  通过，storage tests 29/29 通过，`git diff --check` 通过。完整 `pnpm test` 为
  335/341：5 个 Phase 4 timing 用例隔离重跑全部通过，1 个既有 Phase 5B Voice WebSocket
  用例在 WSL2 稳定复现 `socket hang up`；该失败不经过 Memory 代码路径，记录为 WSL2
  模拟兼容性待处理，不阻塞 6A 存储门禁。

退出门禁：Memory 可持久化、可检索、可过期、可删除；尚不接入模型 Context，也不允许跨角色召回。

## 4. 纵切 6B — Write Policy, Conflict & Deletion

- [x] 实现确定性写入策略和候选校验；模型不能直接写 Store；
- [x] 拒绝 token、密码、原始音频、实时 HA/World State 与不必要敏感家庭状态；
- [x] `user_fact` 仅接受显式或重复确认；`task_outcome` 只能来自已审计 terminal result；
- [x] 冲突记录保留来源与 lineage，不静默覆盖；同一 interaction 重试保持幂等；
- [x] 用户显式删除按 lineage 传播且不在删除审计中保留正文；
- [x] 独立 subagent review 完成，发现已修复或明确记录。

6B implementation evidence（2026-08-24）：

- Runtime 新增 `memory-policy.ts` 与 `memory-write-coordinator.ts`：调用方只能提交 bounded、
  structured-clone-safe candidate/evidence；Router 稳定拒绝，策略只产出 validated canonical
  `MemoryCreate` 或稳定拒绝码；
- provenance 同时经过结构化 evidence 分支和 SQLite audit trace 校验：摘要要求 completed
  interaction/run，用户事实要求显式陈述或两个不同 interaction 的一致确认，任务结果要求
  terminal run 中 exact tool result digest；模型自述不构成证据；
- data class/source allowlist 与内容扫描双门禁拒绝 credential、Authorization/Bearer、token、
  password/密码、Wi-Fi 密钥、raw audio/PCM、HA entity/world snapshot 和不必要实时家庭状态；
  restricted 写入无条件降为 `owner_only`；
- SQLite schema v4 增加 unique idempotency key、subject key、immutable supersession lineage
  和删除审计；v0/v1/v2/v3 均在单个 migration transaction 到 v4，冲突创建新 canonical
  record 并保留旧来源，ID collision 不按幂等重试处理；
- 新级联删除 API 在同一事务中删除目标及全部 superseding descendants，并由 FK/FTS trigger
  清理 tags、ACL 和全文索引；request id 幂等审计只含 request/memory ids、角色、原因和时间。
  SQLite hard delete/WAL 仍不等于取证级擦除，生产介质擦除与 WAL/checkpoint 策略保持后续门禁；
- `phase-6b-memory-policy.test.ts` 及 storage 回归覆盖写入证据、Router/敏感数据拒绝、restricted、
  幂等、ID 冲突、lineage 约束、级联删除、无正文审计、重复 request、跨 owner 与 v3 migration/
  rollback。review 修复后 `pnpm typecheck` 通过，6B + storage 45/45 通过；全量
  `pnpm test` 为 351/357，5 个 Phase 4 并发时序失败隔离重跑最终 43/43 通过；既有
  Phase 5B Voice WebSocket 用例在 WSL2 仍稳定复现 `socket hang up`（隔离 14/15），
  未修改无关 Voice 代码。

6B review（2026-08-24）：

- 移除 candidate 内可伪造的 submitter 身份，改为 runtime/model/router 三个独立 writer
  boundary；Router writer 无条件返回 `ROUTER_WRITE_FORBIDDEN`，model-facing writer 不暴露
  Store API；
- conversation summary、user fact 与 task outcome 现在必须逐项绑定唯一 start/terminal event、
  interaction、owner role、run/message/tool identity、runtime-controlled message metadata 和 exact
  tool result digest；取消/超时还必须绑定对应 tool error code，任意摘要或伪造 confirmation
  不能借用已完成 run；
- data class 与 kind、Store kind 与 source 均强绑定；secret 扫描覆盖 content/subject/tags，
  扩充 token、私钥、audio、HA/World 和实时家庭状态探测；canonical record 不允许通过
  legacy update API 改写正文或 provenance，restricted 继续在 policy 与 schema 双层 owner-only；
- 幂等 retry 改为比较完整 canonical payload（包括 ID、ACL、tags、时间与 policy），相同正文的
  新 identity 也保留为新 lineage record；lineage 强制同 owner/kind/subject、单 successor、
  单调时间、无自引用/环，并新增双 Worker 并发 migration/idempotency/conflict 回归；
- migration 在获取 `BEGIN IMMEDIATE` 后重新读取 schema version，消除两个 Worker 同时打开 v0
  数据库时重复建表；v0/v1/v2/v3→v4 及失败回滚继续保持单事务；
- 显式删除 reason 改为固定 code，审计无自由正文；request 全参数参与幂等冲突校验，递归限定
  256 层/1000 条并在超限时整事务回滚；删除 tombstone 同时保留 memory ID 与 idempotency key，
  禁止删除后复用身份，FK/FTS trigger 继续清理 tags、ACL 与全文索引。

退出门禁：写入、冲突和删除行为均为确定性策略，错误或敏感候选 fail closed。

## 5. 纵切 6C — Recall, ACL Projection & Context Budget

- [x] 实现结构化标签 + FTS 检索和 `private/shared_acl/hybrid` projection；
- [x] restricted Memory 在所有策略下保持 owner-only，旧 policy revision fail closed；
- [x] 为 Context Builder 增加独立 memory token budget 和稳定裁剪；
- [x] Human、Robot、Cat 分别召回；Router 零 Memory；混合 assignment 不共享 projection；
- [x] Memory 内容按不可信数据包装，不得成为 system/tool 指令；
- [x] 独立 subagent review 完成，发现已修复或明确记录。

6C implementation evidence（2026-08-24）：

- SQLite Store/Worker 新增独立 `recallMemories` API；原 `get/list/search/update/delete`
  owner-only 语义不变。projection 的 owner、explicit role ACL、restricted、kind、approved policy
  revision 与 expiry 条件全部位于 SQL 谓词内，FTS/短词 literal 查询、tags/kinds/limit 均有界，
  并以 relevance、confidence、更新时间和 ID 稳定排序；ACL 撤销、过期和删除在下一次查询立即生效；
- Runtime 新增 `role-memory.ts` 与 `role-context-builder.ts`。产品 runner 只接受带
  `strategy: private` 的 `RoleMemoryRuntime`，工厂不暴露共享配置，非 private 值在产品入口运行时
  拒绝；`shared_acl/hybrid` 仅由显式 experimental projection 函数调用，留给后续 evaluator，
  未开启跨角色产品召回；
- Human/Robot/Cat frozen profile 分别升级到 v2/v5/v3，并加入独立 512/384/256 token budget。
  Context 固定为 system/safety → 独立 untrusted Memory user message → retained conversation →
  当前 assignment/event；仅投影 memory ID/kind/body，控制字符与 HTML 边界安全转义，
  不投影 sensitivity、ACL、policy revision、tags 或 provenance 内部字段；
- 注入式 `TokenCounter` 支持精确预算边界；无 tokenizer 时仅标记为 conservative estimate。
  选择按 relevance/confidence/update/ID 稳定进行，超预算整条丢弃且不占用 system、当前 input
  或会话历史预算。每次 run 重新查询、不缓存 projection；error/timeout 降级为空 Memory，
  result metadata 仅含 status、selected IDs、token count/method 与 candidate count，不保存正文；
- Human/Robot mixed assignment 分别只用各自 span 查询；Cat room/object 只从 policy-approved
  normalized event 与自身 capability metadata 构造查询；Router 与 route contracts 保持零 Memory
  引用。未配置 Memory 时消息顺序和动作路径保持兼容；
- `phase-6c-memory-recall.test.ts`（runtime + storage）11/11，通过三策略/restricted/旧 revision、
  SQL ACL、ACL 撤销、过期/删除、FTS literal/bounds、精确预算/稳定裁剪、prompt injection、
  private 产品边界、Router 零调用、mixed 独立召回、Cat 无原文、room/object 接入、error/timeout
  降级、动作不变与逐 run 查询；完整 storage 43/43、相关 Human/Robot 51/51、Cat 45/45 通过；
- Node 24.19.0 `pnpm typecheck` 与 `git diff --check` 通过。全量 `pnpm test` 为 362/368：
  5 个既有 Phase 4 并发时序用例隔离重跑分别 22/22、21/21 通过；既有 Phase 5B Voice
  WebSocket 用例在 WSL2 仍稳定复现 `socket hang up`，隔离为 14/15，未修改 Voice 代码。

6C review（2026-08-24）：

- 产品 `RoleMemoryRuntime` 改为只能接受工厂创建且冻结的真实 private runtime，structural fake
  即使伪装 `strategy: private` 也不能进入 runner；工厂显式复制闭包配置，调用请求不能借额外字段
  覆盖 Store、policy revision、clock 或 strategy；
- Runtime 不再信任 Store 返回项：逐条复验 canonical shape、owner/ACL/restricted、policy revision、
  expiry、query、kind、tags 和 limit 后才进入 Context。错误或恶意 Store 返回的跨角色、restricted、
  过期、错误筛选或畸形记录均 fail closed；SQL 的 private/shared_acl/hybrid 矩阵同时覆盖 FTS 与
  无 query 路径，ACL 撤销、policy revision 更新、过期、删除和正文 revision 更新下一次查询生效；
- 0 memory budget 现在定义为不访问 Store 的空召回；异常 TokenCounter fail closed。每个 runner
  先按 `num_ctx - num_predict`、trusted system/current input 与保留历史计算独立 headroom，再同时
  应用角色 memory budget 和保守 context budget，整条稳定选择且 Memory 不挤占保留上下文；
  recall 同时监听 run cancellation，及时退出且已超时/取消 Store 的后续 rejection 会被消费；
- Memory envelope 只保留 ID、kind 和正文，移除可能误导模型的 source/owner；Builder 只接受单个、
  exact-shape、可解析 JSON 的 plain user data message，拒绝 system/tool role、tool_calls、额外字段
  及非 canonical envelope，且不向模型或审计写入 sensitivity、ACL、policy、tags、candidate count
  或 Memory 正文；
- Cat room/object 使用短小的 policy-approved room/target query，不含用户原文；Human、Robot
  read/write 与 Cat 继续在模型调用前接入召回。Cat audit 与 Human/Robot 一样在 frozen profile
  revision 变化时迁移到确定性新 session，保留旧 profile/session 历史不被改写；
- review 后 `pnpm typecheck`、6C 18/18、完整 storage 43/43、Robot read/write 与 Cat 相关
  定向回归通过；全量 `pnpm test` 为 369/375，其中 5 个既有 Phase 4C/4D 并发或 socket
  时序用例隔离重跑 43/43，既有 Phase 5B Voice
  WebSocket 在 WSL2 仍为 14/15、`socket hang up`。`git diff --check` 通过，未修改 Voice 代码。

退出门禁：默认 private 召回稳定接入角色上下文，ACL、预算和降级有确定性测试。

## 6. 纵切 6D — Visibility Strategy Eval & Privacy Regression

- [x] 使用同一数据集分别评测角色私有、共享 ACL、共享 user_fact + 角色私有摘要/任务；
- [x] 分别报告 Recall@K、Precision@K、归属准确率、冲突选择、预算违规和各角色 deterministic
  retrieval case accuracy；
- [x] 跨角色泄漏与过期/删除残留 count 为 0；仅对 mutation 前可见的策略报告 ACL 撤销传播 100%，
  空分母报告 `null`；
- [x] 不输出综合总分，不用回答质量掩盖隐私失败；
- [x] 独立 subagent review 完成，发现已修复或明确记录。

6D implementation evidence（2026-08-24）：

- Eval CLI 新增 `memory-evaluator.ts`、冻结场景与独立 canonical fixture 定义；22 条 Memory
  只写入一个 SQLite Store，`private/shared_acl/hybrid` 复用同一 dataset fingerprint 和
  experimental `role-memory` projection boundary。产品 `RoleMemoryRuntime` 与 runner 未修改，
  `product_runtime_strategy` 仍为 `private`；
- 数据集覆盖 Human/Robot/Cat、三种 kind、显式 ACL、restricted、旧 policy revision、过期、
  动态删除、动态 ACL 撤销、冲突 lineage、prompt injection 和预算超限。ACL 撤销与删除均先对
  三策略查询，再在同一 Store 变更，随后立即对三策略复查，不以静态期望代替传播验证；
- 每个策略分别输出逐角色 Recall@K、Precision@K、deterministic retrieval case accuracy、
  owner/source attribution，以及泄漏、过期/删除残留、ACL 撤销、conflict top choice、预算和
  prompt-injection data-boundary 指标；逐 case 只保留 expected/actual Memory ID、pass/reason，
  `aggregate_score` 固定为 `null`，不输出 Memory 正文、secret/token；
- `phase6` / `pnpm eval:phase6` 不接受 model 参数，默认 `:memory:`，文件数据库只允许新路径，
  `--output` 产物强制 `0600`。本地证据为
  `evidence/agent-phase-6/phase-6d-memory-eval.json`：三策略 gate 均通过，跨角色未授权泄漏、
  过期/删除残留 count 和 budget violation 均为 0；shared_acl/hybrid ACL 撤销传播、
  owner/source attribution、conflict top choice 及 Human/Robot/Cat deterministic retrieval
  均为 100%，private 的不可适用 mutation rate 为 `null`；
- `memory-evaluator.test.ts` 14/14 覆盖全通过、三策略实际差异、单 Store、正文/canary 不落报告、
  CLI 参数与文件权限，以及 recall adapter/fault mutation 注入的泄漏、过期、删除、ACL 撤销、
  owner/source attribution、recall/precision、预算和报告泄密故障；`pnpm typecheck` 与
  eval + 6C + storage 72/72 通过；
- 完整 `pnpm test` 为 383/389；5 个既有 Phase 4 并发/时序失败隔离重跑 43/43 通过。既有
  Phase 5B Voice WebSocket 在 WSL2 隔离仍为 14/15、`socket hang up`，未修改 Voice；
- WSL2 无真实 Ollama、P4/HA 硬件及代表性家庭环境，真实模型 grounded answer evaluation
  明确记录为 `pending`，本阶段仅宣称确定性 retrieval/context 证据通过。

6D review（2026-08-24）：

- 将 deterministic retrieval、三角色 budget/context 和 prompt-injection 复验全部放在 ACL
  revoke/delete 之前；破坏性 mutation 最后执行，三策略继续共用同一个物理 Store 和同一初始
  canonical dataset。fingerprint 现在覆盖全部 canonical metadata 与正文 SHA-256，但报告不含正文；
- Recall@K/Precision@K 的空分母改为 `null`，命中按唯一 ID 计算且 Precision 使用 top-K 分母；
  private 因撤销/删除 probe 在变更前不可见，ACL propagation 与 deleted residue rate 明确为
  `null`，不再虚报 100%/0%。报告不再把确定性 retrieval 称为 grounded answer；
- gate 不再仅信任汇总字段：逐策略重新核对冻结 expected、逐 case actual/metric/attribution、
  三角色 recall/precision/source/owner、mutation、context budget、prompt boundary 和所有汇总
  一致性。缺失、误召、归属、泄漏、过期、删除、撤销、冲突和预算均有独立故障注入回归；
- recall adapter/fault mutation 返回的未知 ID 统一脱敏为固定占位符；Context envelope 逐字段、
  逐 record 对照 canonical fixture，报告只保留安全 Memory ID 与固定 reason。测试确认正文、
  prompt injection、Bearer/password canary 无法经 fault hook 或 artifact 泄漏；
- evaluator API 以独占新建方式取得文件数据库，拒绝任何既有路径，失败时清理数据库/WAL/SHM；
  CLI 拒绝未知/重复参数及 database/output/sidecar alias，原子写入 `0600` artifact，gate 失败退出
  码为 2，并覆盖 symlink output 不跟随及既有数据库不变；
- 重新生成 `phase-6d-memory-eval.json`（schema v2，`0600`）：gate 通过，产品仍为 `private`，
  real model calls 为 0，真实 Ollama 与代表性家庭/硬件 grounded-answer 验证保持 `pending`。
  `pnpm typecheck`、6D + 6C + storage 72/72 通过；全量 383/389，Phase 4 隔离 43/43；
  既有 WSL2 Voice 仍为 14/15、`socket hang up`，未修改 Voice。

退出门禁：三种方案具有可重复的确定性对照；产品默认仍为 private。2026-08-24 用户随后批准
visibility matrix v1 保持 private。

## 7. 纵切 6E — Local Gate & Deferred Real-environment Evidence

- [x] 完成 WSL2 可执行的 typecheck、单元/集成测试、SQLite 重开与模拟门禁；
- [x] 更新 README、里程碑、架构稳定结论和 Phase 6 evidence；
- [x] 明确记录 WSL2 无法完成的真实 P4/HA/Ollama/语音/长期运行验证及后续复现命令；
- [x] 独立 subagent review 完成，发现已修复或明确记录；
- [x] 用户已 review 并批准最终可见性矩阵 v1 保持 `private`；三类 Memory 均保持
  `owner_role` private，未启用任何跨角色召回；
- [x] 当前不立项 Vector DB：确定性 FTS 已满足冻结场景；真实家庭数据集和真实模型证据不足，
  不把当前结果外推为长期充分性结论。

6E implementation evidence（2026-08-24）：

- 新增 `pnpm gate:phase6`，只执行一次 Node runtime preflight，随后 fail-fast 执行 typecheck、
  6B/6C runtime、memory evaluator、完整 storage tests 和确定性 Phase 6 eval；任何子命令或
  artifact verifier 失败均非零退出；
- 门禁在 Node `v24.19.0`、pnpm `11.19.0` 下通过：6B/6C `20/20`、evaluator `15/15`、
  storage `43/43`。确定性 eval 使用单一 22-record Store，三策略 retrieval `42/42`、
  context budget `9/9`、prompt-injection data boundary `3/3`、mutation probe `6/6`；
- eval 先生成同目录 mode `0600` 临时 artifact；独立 verifier 固定核对 report schema/suite、
  canonical dataset fingerprint、三策略逐 case/mutation/context 结果、gate、产品 `private`、
  real model calls `0` 和无 Memory 正文/credential canary，通过后才原子替换
  `phase-6d-memory-eval.json` 并再次验证。固定 artifact 路径若意外成为 SQLite 数据库会拒绝覆盖；
- 最新完整 `pnpm test` 为 `383/389`，明确未通过：并发全量运行中 5 个既有 Phase 4
  timing/socket 用例和 1 个既有 Phase 5B Voice WebSocket 用例失败。Phase 4 首次隔离
  `42/43`、相同命令立即复跑 `43/43`；Voice 隔离稳定 `14/15`、`socket hang up`。
  这些失败未被 gate 吞掉或改写成全仓库通过，且未修改无关 Voice；
- 本地证据见
  [phase-6e-local-gate.md](../../evidence/agent-phase-6/phase-6e-local-gate.md)；
  用户已批准的版本化矩阵见
  [visibility-matrix.md](../../evidence/agent-phase-6/visibility-matrix.md)；
- 所有真实环境项目均以 `status=pending` 逐项记录：真实 `qwen3.6:35b-mlx` grounded answer/
  prompt injection、代表性家庭 recall/precision/conflict、真实 HA Robot + Memory（HA 仍是真值）、
  真实 P4 Cat + Memory（World 仍是真值）、长期 SQLite/WAL/crash/power-loss/backup/quota/retention/
  权限/加密/secure-delete、多用户/subject 身份、依赖 Phase 5E 的 Voice + Memory。
  每项所需环境和复现入口或新计划要求均在 6E evidence 中；当前 WSL2 未运行任何硬件或网络服务。

6E final decision evidence（2026-08-24）：

- 用户明确选择“批准 v1 保持 private（推荐）”；visibility matrix 状态已记为 `approved`；
- `conversation_summary`、`user_fact`、`task_outcome` 均保持 `owner_role` private，产品跨角色召回
  继续禁用；
- `shared_acl/hybrid` 继续只用于 experimental evaluator；未来任何放开必须新建版本化矩阵并
  再次 review，当前裁决不构成启用授权；
- 该用户决策已完成，不属于真实环境 pending；Phase 6 仍不得表述为生产验收完成，长期 SQLite
  与全部真实模型/家庭/HA/P4/Voice 证据继续 pending；
- Phase 7 未获授权、未启动。

6E independent defect-first review（2026-08-24）：

- 修复 `agent/package.json` 与 gate script 各自执行 runtime preflight 的重复；现在
  `pnpm gate:phase6` 只由 gate script 执行一次 preflight，仍保持任一步失败立即非零；
- 原 gate 在最终 artifact 路径直接生成，只复验 mode、汇总 gate、private 和零模型调用，无法独立
  证明固定 dataset/case coverage。现改为临时生成 → 独立 exact verifier → 原子提升 → 再验证，
  并固定 schema/suite、dataset SHA-256、三策略/三角色 expected cases、mutation/context、0600、
  无正文/secret canary；新增回归测试证明 mode、fingerprint 和 body canary 篡改均非零失败；
- 增加固定 artifact 路径和通用 `--output` 的 SQLite header 防护，避免 artifact 意外覆盖用户
  数据库；gate 继续只使用 `:memory:`，evaluator 文件数据库入口仍只接受独占新路径，既有数据库
  不打开、不删除；回归测试验证作为 output 的既有 SQLite 内容保持逐字节不变；
- 修复 Phase 6 两份 Markdown evidence 被 `.gitignore` 忽略的问题；现在 Phase 6 JSON artifact 和
  review/evidence Markdown 都可版本化；
- 修复 `agent/README.md` 将当前数据库误写为 schema v2 的漂移：当前 DB `user_version=4`，
  Memory record `schema_version=1`；同时把 Context 顺序、private 产品 runtime 与实验 projection
  边界写成与代码一致；
- 修复架构第 13 节仍称可见性“尚未决定”的过时语义：用户尚未批准的是跨角色产品策略，而代码现状
  已明确为产品仅 `private`、`shared_acl/hybrid` evaluator-only。visibility matrix 与 SQL/runtime
  对照后确认 owner、restricted、approved/旧 policy revision、expired/deleted、Router 路径一致；
- 补全长期 SQLite pending 中的 quota/retention，并复核 production TODO 未把权限、加密、
  durability、backup、secure-delete 或身份模型误报为完成；
- review 后本地 gate 重新通过；未运行或修改 Phase 4/Voice 实现，未启动 Phase 7，未启用跨角色
  产品召回。最新完整 `pnpm test` 仍引用既有 `383/389` 失败结果，不改写为 pass。

退出门禁：编码、本地模拟门禁和用户 visibility matrix v1 private 裁决完成；真实环境项目保持
`pending`，不得据此宣称 Phase 6 生产或硬件验收通过。

## 8. 完成定义

- [x] 记忆来源可追踪、可删除；
- [x] 确定性写入策略拒绝凭证和原始音频候选，evidence 不保存 Memory 正文；
- [x] 实现边界保持 World State 从 P4/HA 读取，Memory 不作为真值；真实端到端证据仍 pending；
- [x] 召回效果有确定性量化证据；真实模型和代表性家庭效果仍 pending；
- [x] 角色记忆可见性有量化对照，且用户已确认 v1 保持 private；跨角色读取不会隐式发生；
- [x] WSL2 无法完成的真实环境验证已逐项记录为 `pending`；
- [ ] Phase 7 获得另行明确授权并启动（当前未授权、未启动）。
