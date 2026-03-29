# Harness Workflow

## 目标

本文件定义本项目后续开发的最小流程约束，供未来上下文直接复用。

## 规则 1：新增功能必须先建 plan

每个新增功能开始前，必须先在 `docs/plans/` 下创建 plan 文件。

命名建议：

- `docs/plans/YYYY-MM-DD-feature-name-plan.md`

plan 至少必须包含：

- 背景与目标
- 范围与非范围
- 技术方案
- 任务拆解
- 测试方案
- 风险与回滚点
- 完成定义

## 规则 2：plan 必须包含测试方案

测试方案不能只写“手工验证”，至少要区分：

- 编译/构建验证
- 功能验证
- 回归验证
- 如适用，硬件联调验证

## 规则 3：功能完成后先邀请 review，再提交/推送

每个功能完成后，必须主动邀请用户 review code。

默认流程：

1. 功能实现完成
2. 本地验证完成
3. 邀请用户 review
4. 用户确认通过
5. 归档 plan 为正式技术文档
6. 删除原 plan 文件
7. 再进行 commit/push

## 规则 4：push 前必须确认已 review

本项目允许自动化 `git commit` 和 `git push`，但默认不允许跳过 review。

推荐做法：

- commit 可以自动化
- push 需要明确带上“已 review”确认

## 规则 5：推送时要同时完成文档沉淀

当某个功能准备推送时，应将 plan 归档为正式技术文档，放在 `docs/` 下。

推荐结果：

- `docs/plans/2026-03-29-xxx-plan.md` 删除
- `docs/xxx.md` 新增或更新

为避免多一次无意义推送，默认采用以下解释：

- 在 push 前完成 plan 更新、技术文档持久化、原 plan 删除
- 这些变更与功能代码一同进入本次 commit/push

## 规则 6：不确定时直接提问

如出现以下情况，必须先问用户：

- 范围不清
- 方案存在明显二选一
- 会影响目录结构或长期维护
- 需要破坏性变更
- 需要真正执行云端推送但仓库/远端状态不明确

## 推荐命令

创建新 plan：

```bash
./scripts/new-plan.sh feature-name
```

归档 plan：

```bash
./scripts/finalize-plan.sh docs/plans/YYYY-MM-DD-feature-name-plan.md feature-name --delete-plan
```

自动化 commit：

```bash
./scripts/git-commit.sh "feat: add feature-name"
```

自动化 push：

```bash
./scripts/git-push.sh --reviewed
```
