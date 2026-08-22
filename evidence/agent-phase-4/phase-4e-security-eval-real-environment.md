# Phase 4E Security, Eval & Real Environment Gate Evidence

日期：2026-08-23

## 当前结论

4E 的本地 coding、自动化门禁、独立 bugs review、真实 P4 长稳 run、真实物理灯态观察与实际触摸
输入均已完成。最终硬件 run `32585132074` 绑定 commit
`dc46c7e66815d804fab31504ae6a1766ac379f02`，manifest-first 与原始 `VERIFY:` 标记均通过。4A–4E
技术和真实环境门禁现已全部关闭；Phase 4 仍保持 `in_progress`，等待用户最终 review，且不自动授权
启动 Phase 5。

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
`2928e219cc89564cfb2281696b42efe2492f84698dadffad51e833ba23d86b8e`；持久化原始分项报告见
[phase4e-eval-final.json](./artifacts/phase4e-eval-final.json)。

Router 让模型只返回逐字复制的原文子串，Runtime 再确定性计算 JavaScript UTF-16 offset，并要求所有
子串按序精确拼回完整输入；模型不能靠改写、漏字符、移动标点或错误计数制造执行 span。holdout 覆盖
“我好累，打开空调”、Robot→Human 顺序、emoji、单意图和 prompt injection。Robot 分项使用 Fake HA
验证允许的读写、未知 alias、高风险锁和未开放 climate 写；安全拒绝必须为零 dispatch。Human 分项把
文本执行声明作为失败，允许明确的澄清提问；Composer 分项验证 source order 和跨角色标签注入。

auth 失败、HA/P4 离线、timeout、取消、重连、断线后 reconciliation、进程恢复和 post-dispatch unknown
不依靠模型分数，而由确定性 Runtime/SQLite/transport 测试覆盖。最终 Agent 全量 241/241、Phase 4C
gate 定向 22/22、Python 合约 74/74、hardware helper 9/9、strict typecheck 与 `git diff --check` 均通过。
最终策略还重新校验了保存的真实模型 Human 输出，current-policy failure 为 0。

## 凭证与敏感数据审计

新增 fail-closed 审计器，先验证专用 token 文件是普通文件、权限 0600 且大小有界，然后只输出计数：

- 使用 Git object plumbing 扫描 3971 个本地对象（包括不可达对象）中的 exact token，不把 token 放入
  argv 或日志；
- 扫描真实模型评测 JSON、真实 SQLite 审计样本和已脱敏的 Phase 4C hardware artifact；
- 扫描当前进程命令行中的 exact token；
- 检查 Authorization header、token 字段、原始 HA entity id 和敏感 attribute key 模式。

最终结果：9 个 runtime 文件全部通过，所有 finding 均为 0；Git all-object 扫描覆盖 3971 个对象。
Git 的 all-object 检查只对本次真实专用 token
做 exact match；仓库中既有的 36 个 P4 panel whitelist entity ID 是明确的受跟踪例外，4E 未新增，且
不把“Git 中没有 entity ID”作为本门禁结论。Authorization/token 字段、原始 entity ID 与敏感 attribute
模式的零命中结论限定于运行产物、SQLite 与对话输出；Runtime 的属性投影 allowlist 另由确定性测试约束，
不会把原始 HA attributes 写入 Git 或上述输出。SQLite 样本 SHA-256：
`1531a1845b5cb19532f2f2c14b09998d4b6c8bd7a15fc8437b3a11167627b544`，其脱敏结构摘要见
[phase4e-audit-sqlite-summary.json](./artifacts/phase4e-audit-sqlite-summary.json)，摘要自身 SHA-256 为
`ad32bd7b144675fc9c4f0325a636add3ba57732c86edd8e23432a8207a6e8ae2`。最终审计报告 SHA-256：
`27f22bec4f4da0299011f6fbbb9a283f6b7e0a6462387a3849c9abb6fa720dd5`，持久化报告见
[phase4e-sensitive-audit-final.json](./artifacts/phase4e-sensitive-audit-final.json)。报告本身只含数量与
布尔值；4E 新增代码、对话和证据文档均不记录 token 或新增真实实体 ID。

## Bugs review

独立 subagent 进行了十一轮只读审查和动态反例复现。已关闭：Human 完成声明的多种中文/英文语序、
否定/疑问/意图与后续追问作用域、Router 标点跨角色边界假通过、token/scan/output symlink 与 TOCTOU、
FIFO 阻塞、目录特殊文件静默跳过、任意长空白跨 chunk 绕过，以及 Git/既有 whitelist 的证据范围矛盾。
最终历史正反矩阵无失败，结论为 no findings。

## 真实环境门禁

最终自托管硬件 run：

- workflow run `32585132074`，attempt 1，branch `feature/agent-harness`；
- commit `dc46c7e66815d804fab31504ae6a1766ac379f02`，profile `phase4c_ha`；
- 串口 `/dev/cu.usbserial-210`，芯片 `ESP32-P4 revision v1.0`；
- monitor 1800 秒，capture 1980 秒；4 段 flash 均 `Hash of data verified`；
- P4 离线时 Robot 门禁与 P4 在线时门禁均通过：专用非管理员账号、固定 alias 写入、HA accepted、
  因果 state observation、一次恢复写和最终 `off` 状态全部成立；
- P4 日志包含 `p4_ha_state` 的 `on/off` 回刷，64 个 `p4_standalone:PASS` 与持续
  `ui:8fps:PASS`；post-Robot standalone/UI 两项在 manifest 中均为 true；
- app 1,482,656 bytes，DIRAM free 275,204 bytes；无 `VERIFY:*:FAIL`、panic、Guru Meditation、
  watchdog、assert、brownout 或 stack overflow；
- 已脱敏 manifest 见
  [phase4c-hardware-validation-manifest.json](./artifacts/phase4c-hardware-validation-manifest.json)，
  SHA-256 `56e663344eeea6f9ba6c9b5ef695e9571e683e63b0fc2640fbd9a63bf0d40c0e`；原始 monitor 的持久化计数摘要见
  [phase4c-monitor-summary.json](./artifacts/phase4c-monitor-summary.json)，SHA-256
  `a2ef3124f8ff227f0ed75186f9dd3e0d8af7d864adb5e0b5ab15381f0d85f120`。摘要绑定原始 monitor SHA-256
  `7e66e638839605ebb4698b2ace125a2056e254e3dc854678bc351fcb99664944`，并记录 `p4_ha_state` on/off 各 2、
  Robot identity/write/restore 各 2、standalone 64、UI 8 FPS 232，所有矛盾计数为 0。完整脱敏串口
  artifact 保存在 GitHub run `32585132074` 的 `esp32-p4-monitor-log`。

物理与触摸证据与 workflow 自动 marker 分开记录：用户在设备旁独立确认一次真实灯态“关→恢复开”；
随后实际触摸 P4 后确认“书房顶灯关闭”，并明确说明该动作由触摸触发。因此物理变化/恢复和实际触摸
交互两项均已关闭，不把驱动初始化或渲染帧率冒充为触摸证据。

至此 4E 的技术与真实环境退出门禁已关闭；只剩用户最终 review 才能关闭并归档 Phase 4。
