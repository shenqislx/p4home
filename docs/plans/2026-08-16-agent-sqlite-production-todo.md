# Agent SQLite Production TODO

> Status: `deferred`
> Created: 2026-08-16
> Updated: 2026-08-24
> Current scope: Phase 6 本地正确性已覆盖；生产耐久、容量、安全与运维仍 deferred
> Review before: 任何真实家庭长期 Memory 部署

## 已在 Demo 阶段解决

- Session 对应 AgentProfile allowlist 在 Run 启动时生效；
- Run 启动、模型响应、Tool 请求/结果和 Run 终态使用 SQLite batch transaction；
- Tool 事件持久化 `tool_call_id`，失败、取消和超时使用不同终态事件；
- Run 不得在 ToolCall 或 Action 未终止时结束；
- 审计 wall clock 回拨时使用单调钳制时间；
- `getRunTrace()` 使用按 `run_id` 查询的一致性读快照。
- `DatabaseSync` 已移入专用 Worker，单个 Store 的请求串行执行；锁等待不阻塞主线程 timer；
- 默认启动恢复会原子关闭遗留 `pending/running` Run，并记录 outcome unknown、禁止盲目重放；
  Phase 2 真实设备结果仍由 snapshot reconciliation 决定。
- SQLite 数据库 `user_version=4`（Memory record 独立为 `schema_version=1`）对 ID、正文、subject、
  tags、ACL、时间、confidence、policy revision 等字段执行长度、类型、枚举、数量和 canonical
  shape 校验，restricted/lineage/idempotency 另有 schema 约束；
- Memory 的 list/search/recall/purge 均有稳定上限和确定性分页/排序；FTS 查询按字面量转义，
  owner/ACL/restricted/policy revision/expiry 过滤位于 SQL 内；
- expiry 边界、bounded purge、正文 revision、ACL 撤销、跨 Worker 重开/迁移和并发 revision 已有测试；
- 普通硬删除、lineage 级联删除会同步清理 tags、ACL 和 FTS，并保持无正文删除审计；这不等于
  WAL、备份或存储介质上的 secure delete。

## 延后到生产化阶段

| TODO | 触发门禁 | 验收要点 |
|---|---|---|
| 增加 `application_id`、schema metadata 和完整 migration 框架 | 发布可复用安装包或支持已有数据库升级前 | 拒绝错误数据库；并发启动、升级失败和回滚可重复验证 |
| 数据库目录及 DB/WAL/SHM 权限收紧到仅当前用户 | 写入真实家庭对话或 HA 状态前 | 新建与重开均验证权限；备份不遗漏 WAL |
| 明确加密、密钥管理和防篡改策略 | 多用户主机或正式家庭部署前 | 敏感字段分类、静态加密、密钥轮换和审计完整性方案通过 review |
| AgentProfile 使用不可变 revision，并在 Run 保存授权快照 | 支持 Profile 在线修改或多个 Profile 前 | 历史 Run 可还原当时授权，不受后续配置修改影响 |
| 决定 `synchronous=FULL`、checkpoint 和断电耐久策略 | 正式长期运行前 | kill/power-loss 测试证明约定的最近提交保留范围 |
| 增加总数据库/各数据类磁盘 quota | 连续运行或真实家庭 Memory 前 | 写入、WAL 和索引增长有硬上限；达到限额时 fail closed |
| 批准按数据类/敏感度的保留期策略 | 写入真实家庭 Memory 前 | expiry 默认值、审计保留、删除传播和法律/用户预期经 review |
| Action 主键扩展为设备作用域 | 支持多个 P4 设备前 | 使用 `(device_id, action_id)` 保持协议幂等语义 |
| 增加 `integrity_check`、损坏隔离和可恢复备份 | 正式运维前 | 数据库损坏时 fail closed，并能恢复到已声明的恢复点 |
| 定义 WAL/checkpoint、备份一致性与恢复演练 | 正式长期运行前 | 备份包含所需 sidecar/checkpoint 状态；恢复点与数据损失窗口可重复验证 |
| 定义介质级 secure-delete 能力与限制 | 用户要求不可恢复删除或处理高敏感数据前 | 明确 SQLite hard delete、WAL、备份、SSD wear leveling 的边界并验证方案 |

2026-08-25 更新：DB/WAL/index quota 的 fail-closed 实现和真实 APFS 合成门禁已完成；完整
kind/sensitivity retention 矩阵、默认 expiry、旧记录重开拒绝和 bounded purge 传播也已完成。
当前待 review 的是生产字节限额与 retention 天数，而不是执行机制。具体语义和候选矩阵见
[SQLite quota 与分类 retention 策略](../sqlite-quota-retention-policy.md)。

## 非目标

- Phase 1 不引入远程数据库、Vector DB 或分布式事务；
- 当前 TODO 不改变 Device Protocol v1 和 Tool Schema v1；
- 未完成对应门禁前，不把单机 Demo 的通过结果解释为生产耐久性证明。
