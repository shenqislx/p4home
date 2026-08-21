# Phase 4E Security, Eval & Real Environment Gate Evidence

日期：2026-08-21

## 当前结论

4E 的本地 coding、自动化门禁与独立 bugs review 已完成，最终复核为 no findings；当前 commit 对应的
真实 P4 长稳 run 尚未完成。当前证据不能替代真实物理灯态观察或实际触摸输入；在这两项有人可独立
观察的门禁关闭前，不宣称 Phase 4 完成。

## 分项评测

使用产品默认本地模型 `qwen3.8:27b-mlx`、固定 seed 42 和 Node 24.19.0 执行：

```text
pnpm eval:phase4 -- --model qwen3.8:27b-mlx --timeout-ms 120000
```

报告不生成 aggregate score，各分项和失败样本保持独立：

| 分项 | 结果 |
|---|---:|
| Router span | 6/6 |
| Robot ToolCall / policy | 5/5 |
| Human text | 4/4 |
| Composer | 2/2 |

评测 artifact SHA-256：
`2928e219cc89564cfb2281696b42efe2492f84698dadffad51e833ba23d86b8e`。

Router 让模型只返回逐字复制的原文子串，Runtime 再确定性计算 JavaScript UTF-16 offset，并要求所有
子串按序精确拼回完整输入；模型不能靠改写、漏字符、移动标点或错误计数制造执行 span。holdout 覆盖
“我好累，打开空调”、Robot→Human 顺序、emoji、单意图和 prompt injection。Robot 分项使用 Fake HA
验证允许的读写、未知 alias、高风险锁和未开放 climate 写；安全拒绝必须为零 dispatch。Human 分项把
文本执行声明作为失败，允许明确的澄清提问；Composer 分项验证 source order 和跨角色标签注入。

auth 失败、HA/P4 离线、timeout、取消、重连、断线后 reconciliation、进程恢复和 post-dispatch unknown
不依靠模型分数，而由确定性 Runtime/SQLite/transport 测试覆盖。最近一次 Agent 全量 231/231；最终
Phase 4E + Human 定向 16/16、Python 合约 74/74、strict typecheck 与 `git diff --check` 均通过。
最终策略还重新校验了保存的真实模型 Human 输出，current-policy failure 为 0。因 Codex 本机回环授权的
用量上限，review 修复后未伪称再次执行 Agent 全量；最终增量由定向测试、typecheck 和独立复核覆盖。

## 凭证与敏感数据审计

新增 fail-closed 审计器，先验证专用 token 文件是普通文件、权限 0600 且大小有界，然后只输出计数：

- 使用 Git object plumbing 扫描 3911 个本地对象（包括不可达对象）中的 exact token，不把 token 放入
  argv 或日志；
- 扫描真实模型评测 JSON、真实 SQLite 审计样本和已脱敏的 Phase 4C hardware artifact；
- 扫描当前进程命令行中的 exact token；
- 检查 Authorization header、token 字段、原始 HA entity id 和敏感 attribute key 模式。

结果：四类 runtime 输入全部通过，所有 finding 均为 0。Git 的 all-object 检查只对本次真实专用 token
做 exact match；仓库中既有的 36 个 P4 panel whitelist entity ID 是明确的受跟踪例外，4E 未新增，且
不把“Git 中没有 entity ID”作为本门禁结论。Authorization/token 字段、原始 entity ID 与敏感 attribute
模式的零命中结论限定于运行产物、SQLite 与对话输出；Runtime 的属性投影 allowlist 另由确定性测试约束，
不会把原始 HA attributes 写入 Git 或上述输出。SQLite 样本 SHA-256：
`1531a1845b5cb19532f2f2c14b09998d4b6c8bd7a15fc8437b3a11167627b544`；审计报告 SHA-256：
`21434ff128cf8e51c9fac49d329784a4501c8f8431bf5e7cc8b2d3c01e3faefe`。报告本身只含数量与布尔值，
权限为 0600；4E 新增代码、对话和证据文档均不记录 token 或新增真实实体 ID。

## Bugs review

独立 subagent 进行了十一轮只读审查和动态反例复现。已关闭：Human 完成声明的多种中文/英文语序、
否定/疑问/意图与后续追问作用域、Router 标点跨角色边界假通过、token/scan/output symlink 与 TOCTOU、
FIFO 阻塞、目录特殊文件静默跳过、任意长空白跨 chunk 绕过，以及 Git/既有 whitelist 的证据范围矛盾。
最终历史正反矩阵无失败，结论为 no findings。

## 尚待关闭的真实环境门禁

- 当前 4E commit 对应的 `phase4c_ha` 长稳 run：manifest-first 身份、flash、离线 Robot、在线 HA/P4
  收敛、post-Robot standalone、UI 8 FPS、资源基线、无 watchdog/矛盾证据；
- 在人可独立观察设备时确认一次物理灯态变化与恢复，并完成一次真实触摸输入。

最后两项不能用 workflow green、驱动初始化 marker 或模型评测替代。
