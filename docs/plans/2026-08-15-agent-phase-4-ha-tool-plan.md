# Agent Phase 4 — Robot HA Tool & Multi-role Split Plan

> Status: `in_progress`
> Started: 2026-08-20
> Current Gate: 4A 实现与本地门禁完成，等待用户 review；4B 尚未启动
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 3 complete；HA 环境与隔离测试实体可用

## 1. 目标

由 Agent Runtime 中的 Robot 直接连接 Home Assistant，提供受 schema、entity/service allowlist 和
执行策略共同约束的家居 Tool；再把 Role Router 从单 assignment 升级为安全的语义分割，使一个
Interaction 可以产生相互隔离的 Human 与 Robot Run，并由确定性 Response Composer 呈现结果。

## 2. 不可变边界

1. Robot 直连 HA，不通过 P4 代发；P4 与 Robot 使用不同账号/token，任一凭证可独立撤销；
2. HA token 只从仓库外的受限文件读取，不能进入模型上下文、命令行参数、Git、SQLite、日志或
   artifact；缺失、权限过宽或格式错误时必须在联网前 fail closed；
3. 不加载 HA 全量状态，只读取版本化 allowlist 中的实体；模型只看到 allowlist 投影，HA 的名称、
   attributes 和事件均按不可信输入处理；
4. 模型不获得任意 `call_service(domain, service, json)`。Tool 名、参数、entity alias、domain 和
   service 都由本地契约与 policy 再校验，Router 或 prompt 不能扩大权限；
5. Human 永远无执行 Tool，Cat 只有 P4 World Tool，Router 无 Tool；任何错误路由也不能跨过
   RoleProfile 和 Tool Runtime 的运行期授权；
6. HA `result` 只证明请求被 HA 接受或拒绝，写侧完成还要关联目标实体的后续 `state_changed`；
   timeout、断线或缺少回刷属于 `unknown`，不得自动重放可能已产生副作用的写请求；
7. 4A–4C 保持单 assignment RoutePlan，先独立关闭 Robot HA 安全边界；只有 4C 真实写侧门禁通过后，
   4D 才能放开多 assignment；
8. Phase 4 不修改冻结的 Device Protocol v1/v2 或 Cat Tool Schema v1/v2；Robot HA Tool 使用独立的
   Agent 侧版本化契约。

## 3. 启动准备（已完成）

- [x] 确认 Phase 3 已通过实机 artifact 与用户最终 review，并归档 Phase 3 计划；
- [x] 核对现有单 assignment Router、RoleProfile、Scheduler、SQLite 审计和 Tool Loop 入口；
- [x] 核对 P4 已有 HA WebSocket/read/writeback 行为，确定 Robot 不复用固件凭证或经 P4 代发；
- [x] 把原始串行清单拆成 4A–4E 五个可独立 review 的纵切；
- [x] 冻结准备阶段的凭证、allowlist、未知副作用和跨角色隔离原则；
- [x] 记录准备证据：[Phase 4 Preparation](../../evidence/agent-phase-4/phase-4-preparation.md)。

准备阶段只建立边界与门禁，没有创建 HA 账号/token、没有打开 Robot HA socket、没有执行真实家居
动作，也没有向 Robot RoleProfile 开放任何 HA Tool。

## 4. 纵切 4A — Robot HA Contract & Credential Boundary

- [x] 建立 Agent 侧版本化 HA Tool/allowlist contract，使用稳定 alias 映射真实 `entity_id`，并明确
  允许的 domain、读写能力、期望状态和敏感 attribute 投影；仓库只保存 schema 与脱敏示例；
- [x] 新建独立 HA transport adapter，覆盖 WebSocket auth、单调 request id、有界 pending 表、
  `state_changed` 订阅、重连 snapshot 和 metrics；不复制 P4 C 实现，但保持已验证的协议语义；
- [x] 凭证入口固定为 URL、token file、policy file；token file 必须是普通文件且仅当前用户可读，
  token 不允许从 CLI 参数或模型可见环境投影进入 Runtime；
- [x] 为 fake HA transport 建立 auth invalid、协议异常、重复/乱序 result、事件洪水、断线与重连测试；
- [x] 建立 HA 连接与 policy 审计字段，但不得持久化 token、原始 auth frame 或未投影 attributes；
- [x] Robot RoleProfile 仍保持无 Tool，4A 不产生任何真实 HA 副作用。

退出门禁：本地 schema/fake transport 能证明只加载 allowlist、凭证全链路脱敏、pending 有界、重连不
重放写请求；非法配置在 socket 创建前失败；Human/Cat/Router 的工具集合不变。

4A 实现与本地退出门禁已完成，证据见
[Phase 4A HA Contract & Credential Boundary](../../evidence/agent-phase-4/phase-4a-ha-contract-credential.md)。
2026-08-21 已完成代码 review 并修复首事件/快照竞态、旧状态残留、REST 重定向、公开 policy
泄漏、投影类型混淆和文件有界读取等问题。当前仍停在 4A review gate；在用户明确通过前不得开始 4B。

## 5. 纵切 4B — Read-only Robot HA Tool

只有 4A review 通过后开始：

- [ ] 先只向 Robot 的新 RoleProfile revision 开放 `home.get_entity(alias)`；模型不可传真实 entity id；
- [ ] Robot 上下文只接收当前 assignment、必要的 allowlist capability 和最小状态投影；friendly name、
  attributes 与事件文本不能成为新的指令；
- [ ] 将模型 ToolCall、policy 决策、HA request/result、状态 observation 与
  `interaction_id/route_plan_id/assignment_id/run_id/tool_call_id` 完整关联；
- [ ] 增加未知 alias、未允许 domain、prompt injection、HA 离线、auth invalid、timeout、取消、重连和
  状态陈旧测试；
- [ ] 用 Robot 专用非管理员 HA 账号在真实 HA 上完成 allowlist 读侧验证，不读取全量 `get_states`。

退出门禁：Robot 只能读取投影后的 allowlist 状态；任何未允许实体、敏感字段或注入文本都不能扩大
工具调用；Human/Cat 无法看到或调用 `home.get_entity`；HA 离线不影响 Cat/P4 主链。

## 6. 纵切 4C — Low-risk Write & HA/P4 Convergence

只有 4B review 通过后开始：

- [ ] 仅向 Robot 增加 `home.turn_on(alias)`、`home.turn_off(alias)` 和
  `home.activate_scene(alias)`；首批 domain 限于显式 allowlist 的 `light/switch/scene`，若加入
  `climate.turn_on/turn_off` 必须逐实体显式授权；
- [ ] `lock`、`alarm_control_panel`、门禁、购买、删除、任意 service/data、温度设定与温控极值在
  Phase 4 硬拒绝，不以 prompt 或“确认文本”代替执行层策略；
- [ ] 每次写请求先冻结 policy decision，再发送唯一 request id；HA `result` 后等待目标实体状态回刷，
  将 `accepted/completed/rejected/unknown` 分开审计和呈现；
- [ ] timeout、断线与取消后不自动重发；只允许一次只读状态查询协助判定，仍无法证明时保留 unknown；
- [ ] 在隔离的低风险真实实体上验证单次写入、物理/HA 状态、Robot 观察与 P4 现有订阅最终一致；
- [ ] 回归 P4 离线时 Robot 可工作、Agent/Robot 离线时 P4 ↔ HA 与触控 UI 不受影响。

退出门禁：未授权或高风险写入零执行；允许实体的真实动作可由 HA result 与后续 state change 共同
证明，Robot/P4 最终一致；重复、超时和重连测试没有盲目重放或伪造完成。

## 7. 纵切 4D — Multi-assignment RoutePlan & Response Composer

只有 4C review 通过后开始：

- [ ] 新增显式版本的 RoutePlan，最多产生两个 assignment，目标只允许 Human/Robot；每个 assignment
  使用原始文本的 UTF-16 span，必须非空、顺序稳定、首尾连续覆盖全文、互不重叠且不能切开代理对；
- [ ] 无法安全分割、输出遗漏/重叠/未知角色、Robot clarify 或 provider error 时，整体 fail closed 为
  单个 full-span Human clarification，不保留部分 Robot 执行；
- [ ] 每个 assignment 只把自己的 `text.slice(start,end)` 送入独立 Role Session 和 Run；不得把完整
  用户文本、另一角色历史或 Tool observation 复制给另一个角色；
- [ ] 保持有界调度和用户优先级，定义同一 Interaction 的取消、部分失败与完成时序；
- [ ] 实现确定性 Response Composer，只消费各 Run 的结构化终态；Human 文本不能覆盖 Robot 的真实
  accepted/completed/failed/unknown，Robot 也不能代替 Human 生成共情文本；
- [ ] 增加单意图兼容、混合意图、标点/emoji span、holdout、路由注入、部分失败和审计还原测试。

退出门禁：单 assignment 行为保持兼容；混合输入可稳定分段且全文无遗漏/重叠；任一非法 RoutePlan
在创建 Robot Run 前 fail closed；SQLite 可从 Interaction 还原两个独立 Run 与最终组合结果。

## 8. 纵切 4E — Security, Eval & Real Environment Gate

只有 4D review 通过后开始：

- [ ] 分别报告 Router span、Robot ToolCall/policy、Human 文本与 Composer 的指标和失败样本，不生成
  掩盖单项失败的综合分；
- [ ] 加入未参与提示词调优的“我好累，打开空调”等混合意图 holdout，以及越权、prompt injection、
  HA/P4 任一离线、auth 失效、超时、取消、重连与进程恢复场景；
- [ ] 在真实 HA + P4 环境核对 Robot 直连写入和 P4 订阅回刷，artifact 先核对身份再判强 marker 与
  矛盾证据；workflow 绿色本身不代表功能通过；
- [ ] 核对日志、SQLite、CI artifact、进程参数和 Git 历史均不含 token 或原始敏感 HA attributes；
- [ ] 长跑期间验证 Agent 离线不影响 P4 ↔ HA，P4 离线不影响 Robot HA，UI 8 FPS 与固件资源基线
  无回归。

退出门禁：所有 4A–4E 技术门禁和真实环境证据通过，再交由用户最终 review。Phase 4 的 review 通过
只关闭并归档本 Phase，不自动授权启动 Phase 5。

## 9. 完成定义

- [ ] Robot 不经过 P4 即可控制允许的 HA 实体；
- [ ] Robot 与 P4 从 HA 回刷到最终一致状态；
- [ ] 任意 `call_service(json)`、未授权实体与高风险动作不会到达 HA；
- [ ] Human/Cat/Router 无法取得 Robot HA Tool，错误路由不能绕过 policy；
- [ ] 混合输入可拆给 Human/Robot，全文 span、上下文、审计、文本和真实执行结果不串角色；
- [ ] 凭证和敏感 HA 数据不进入模型、日志、SQLite、Git 或 artifact；
- [ ] 用户最终 review 通过，Phase 4 关闭；
- [ ] Phase 5 需用户另行明确授权后启动。
