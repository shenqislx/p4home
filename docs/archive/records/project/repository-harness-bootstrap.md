# repository-harness-bootstrap

## 1. 背景

为了让后续新的上下文可以稳定接手本项目，需要先补齐一套最小可维护 harness，包括：

- 工程目录与模块总览
- 功能 plan 与技术文档的落地规则
- review 后再 push 的约束
- 本地自动化 `git commit` / `git push` 辅助脚本
- 本地 hook 机制

## 2. 最终实现

本次已完成以下内容：

- 新增根目录 [AGENT.md](/Users/andyhao/workspace/p4home/AGENT.md)
- 新增 [Harness Workflow](/Users/andyhao/workspace/p4home/docs/harness-workflow.md)
- 新增 plan 模板 [feature-plan-template.md](/Users/andyhao/workspace/p4home/docs/templates/feature-plan-template.md)
- 新增技术文档模板 [technical-note-template.md](/Users/andyhao/workspace/p4home/docs/templates/technical-note-template.md)
- 新增 `docs/plans/` 持久化目录
- 新增 `new-plan.sh`、`finalize-plan.sh`、`git-commit.sh`、`git-push.sh`、`install-hooks.sh`
- 新增 `pre-push` hook，默认要求先完成 review
- 初始化本地 git 仓库并安装 hooks
- 创建并绑定 GitHub 远端仓库 `shenqislx/p4home`

## 3. 目录与模块影响

- `AGENT.md`：仅描述目录结构和功能模块
- `docs/harness-workflow.md`：定义长期维护流程
- `docs/templates/`：统一 future context 的文档入口
- `docs/plans/`：所有新功能 plan 的持久化位置
- `scripts/`：本地自动化辅助脚本
- `.githooks/`：本地 git hook 模板

## 4. 关键设计决策

- `AGENT.md` 只做目录与模块说明，不承载流程规则
- 流程规则统一放在 `docs/harness-workflow.md`
- push 不允许默认绕过 review，`git-push.sh` 必须显式带 `--reviewed`
- plan 到文档的转换默认在 push 前完成，避免多一次无意义提交
- 当前先做本地 harness，不引入复杂自动化平台或云端 workflow

## 5. 测试与验证结果

### 5.1 功能验证

- 已确认 [AGENT.md](/Users/andyhao/workspace/p4home/AGENT.md) 内容完整
- 已确认 `docs/plans/`、`docs/templates/`、`scripts/`、`.githooks/` 结构存在
- 已确认脚本具有执行权限
- 已确认 `git-push.sh` 与 `pre-push` hook 逻辑一致

### 5.2 git 验证

- 本地 `git init -b main` 已成功
- `core.hooksPath` 已指向 [/.githooks](/Users/andyhao/workspace/p4home/.githooks)
- GitHub 仓库已创建为 `public`
- `origin` 已绑定到 `https://github.com/shenqislx/p4home.git`

### 5.3 人工 review

- 用户已明确确认 harness review 通过

## 6. 后续维护注意事项

- 后续每个新功能必须先建 `docs/plans/*.md`
- 功能完成后先邀请用户 review，再允许 push
- push 前要把 plan 沉淀为 `docs/*.md` 技术文档，并删除原 plan
- 若未来要增强自动化，可在 `.githooks/` 或 GitHub Actions 中继续扩展

