# Harness Workflow

## 1. 当前工作入口

任何新上下文开始工作时，按顺序读取：

1. [AGENT.md](../AGENT.md)：仓库与组件边界；
2. [当前架构基线](./p4-local-agent-architecture.md)：当前长期设计与硬约束；
3. [当前工作计划](./plans/README.md)：唯一执行顺序与 Phase 状态；
4. 当前 `in_progress` Phase plan：本轮允许实施的具体范围；
5. 与本任务直接相关的代码和证据。

不要默认读取 `docs/archive/`。只有追溯历史决策、验证旧行为或定位回归时才读取归档。

## 2. 架构基线优先

当前主线是 P4 Home 本地 LLM Agent 化。

- 架构原则只维护在 `docs/p4-local-agent-architecture.md`；
- 阶段状态只维护在 `docs/plans/README.md`；
- 可执行任务、测试和证据只维护在对应 Phase plan；
- 每日进度不得写回架构正文；
- 若实现需要突破架构边界，先更新架构并邀请 review，再修改代码。

## 3. Plan 规则

`docs/plans/` 只保存当前尚未归档的计划。

- 任意时刻最多一个 Phase 为 `in_progress`；
- 只实施 `in_progress` Phase 范围内的任务；
- 后续 Phase 可定义边界，但前置退出门禁未通过时不得启动；
- 小任务优先写入现有 Phase plan，不为每个微小改动创建独立 plan；
- 只有任务跨多个工作包、引入新架构决策或需要独立 review 时才新建子 plan；
- 新 plan 必须引用当前架构、Phase、依赖与进入条件。

创建子 plan：

```bash
./scripts/new-plan.sh feature-name
```

## 4. 每个计划必须包含

- 背景与目标；
- 对应架构章节；
- Phase、依赖和进入条件；
- 范围与非范围；
- 可按顺序执行的工作包；
- 构建、功能、回归、故障和实机验证；
- 风险、回滚点；
- 需要保存的证据；
- 完成定义与退出门禁；
- review 清单。

“手工验证正常”不能单独作为完成证据。

## 5. 执行与证据

每完成一个工作包：

1. 更新对应 checkbox；
2. 写明实际结果，而不是只写预期；
3. 记录执行命令、关键版本和输出摘要；
4. 串口、性能或长跑证据存入 `evidence/<phase-or-feature>/`；
5. 若失败，保留失败原因和下一步，不把任务标记完成。

涉及固件时至少检查可重复构建、image、static DIRAM、heap、task stack、UI/HA 回归与必要的实机证据。

## 6. Review、完成与归档

```text
pending → in_progress → implementation complete
→ local/equipment validation complete
→ user review
→ archive plan + write durable record
→ commit/push
```

完成后：

- 计划移入 `docs/archive/plans/agent/`；
- 长期有效的实现与验证结论写入 `docs/records/`；
- 架构变化更新当前架构基线；
- `docs/plans/README.md` 将下一 Phase 标记为 `in_progress`；
- 不删除计划，不把历史计划散落在当前目录。

```bash
./scripts/finalize-plan.sh docs/plans/YYYY-MM-DD-feature-name-plan.md feature-name --archive-plan
```

兼容旧命令的 `--delete-plan` 现在也只会归档，不再删除。

## 7. Git 规则

功能完成后必须先邀请用户 review，再推送。

Agent 主线使用固定长期 feature branch：

- 工作分支固定为 `feature/agent-harness`；
- Phase 0–7 的文档、代码、测试、计划状态和归档改动全部提交到该分支；
- 单个 Phase 完成和 review 只允许在该分支内提交、推送，不提前合入 `main`；
- Phase 0–7 全部完成、所有退出门禁关闭并通过最终 review 后，才允许整体合入 `main`；
- 发现当前分支不是 `feature/agent-harness` 时，先暂停写入并切回该分支。

```bash
./scripts/git-commit.sh "feat: add feature-name"
./scripts/git-push.sh --reviewed
```

- commit 可以自动化；
- push 必须有明确的已 review 确认；
- commit 必须同时包含相应计划进度、证据索引或归档变更；
- Phase 0–7 期间禁止直接向 `main` 提交或推送；
- 不允许通过新增功能掩盖当前 Phase 的失败门禁。

## 8. 归档规则

```text
docs/archive/
├── architecture/     # 被取代的历史架构
├── plans/
│   ├── legacy/       # M1-M6 与旧主线计划
│   └── agent/        # 已完成的 Agent Phase/子计划
└── records/          # 历史实施、验证和项目记录
```

归档文件默认只读，不继续承载当前状态。需要恢复旧工作时，基于当前架构重新建立 plan，不直接把旧计划移回当前目录。

## 9. 必须暂停并询问的情况

- 会改变当前架构边界；
- 需要跳过 Phase 退出门禁；
- 会修改真实 HA、米家或家庭设备权限；
- 会删除或覆盖历史证据；
- 需要破坏性 git/flash 操作；
- 需要真正执行远端 push，但 review 状态不明确。
