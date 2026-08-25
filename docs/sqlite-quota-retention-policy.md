# SQLite quota 与分类 retention 策略

状态：revision 1 生产参数已于 2026-08-25 获用户批准并以显式 opt-in 策略冻结；真实断电、加密与
介质级 secure-delete 独立延期，未被本门禁替代。

## Quota 语义

`SqliteAuditStoreOptions.storage_quota` 必须同时给出：

- `max_database_bytes`：换算成 `PRAGMA max_page_count`，SQLite 在增长越界时以
  `SQLITE_FULL` 回滚，属于主库硬上限；
- `max_wal_bytes`：每次写前先尝试 `wal_checkpoint(TRUNCATE)`，随后取得
  `BEGIN IMMEDIATE` 写锁，并为一个“最多改写全库”的 WAL 事务保留完整帧预算；长读者钉住
  旧 WAL、剩余空间不足时拒绝开始写入；
- `max_index_bytes`：`dbstat` 统计普通索引、自动索引和 `memories_fts*`，写前必须保留一个
  最坏全库大小的索引增长预算，事务内再次检查实际使用量；不足时 fail closed。

WAL 预算按 `32 + max_database_pages * (page_size + 24)` 计算，并关闭
`cache_spill`，避免单个事务在提交前重复外溢 WAL frame。`journal_size_limit` 仅作为回收配置，
不被当作硬限额证据。所有公开写路径（Audit、Memory、删除、purge、recovery）均进入同一事务
准入逻辑；schema 创建和升级也在设置 `max_page_count` 后进入同一准入事务，失败时 DDL 与
`user_version` 一起回滚。`:memory:` 明确拒绝文件 quota 配置。

Phase 6I 门禁使用 512 KiB 合成主库阈值验证拒写行为。这只是小型边界探针，不是生产容量建议。
获批 revision 1 基线为：

| 配额 | 上限 | 说明 |
|---|---:|---|
| Database | 128 MiB | Memory 主库硬上限 |
| WAL | 256 MiB | 覆盖最坏情况下整库事务的 WAL frame 预算 |
| Index | 256 MiB | 为现有索引及一次全库规模写入保留 headroom |

策略由 `PRODUCTION_MEMORY_STORAGE_POLICY_V1` 与 `productionMemoryStoreOptions()` 导出，调用方必须
显式启用；临时 eval/audit Store 不会被悄然切换到生产 retention 或 quota。代表性家庭数据延期后，
revision 1 将作为保守起点，后续只能通过新的 policy revision 调整。

## Retention 分类

`memory_retention` 是完整的 `kind × sensitivity` 矩阵，并使用独立的
`retention_policy_revision` 标识矩阵版本。它不复用 Memory 记录上的 `policy_revision`：后者只属于
ACL/投影访问策略，两类策略可以独立升级。缺 kind、缺敏感度、显式 expiry 超过上限，或重开时
发现旧记录无 expiry/超期，Store 都拒绝写入或拒绝打开。调用方传入 `expires_at_ms: null` 时，Store
用矩阵上限生成默认 expiry；更早到期仍允许。到期删除使用 bounded purge，既有外键和 FTS
trigger 继续传播到 ACL、tag、lineage 及搜索索引。

获批的 revision 1 初始矩阵如下（天）：

| Memory kind | normal | personal | restricted | 依据 |
|---|---:|---:|---:|---|
| `conversation_summary` | 30 | 14 | 7 | 摘要变化快，且最可能含连续对话上下文 |
| `user_fact` | 365 | 180 | 30 | 明确用户事实需要长期价值，但敏感事实缩短保留 |
| `task_outcome` | 90 | 60 | 30 | 为纠错和审计保留中期结果，不永久保存执行细节 |

这些天数不是隐式 Store 默认值；产品持久 Memory Store 必须显式传入 revision 1 策略。更短 expiry
仍允许，到期 purge 会传播到关联表和 FTS。代表性家庭数据、用户删除体验及法规适配在后续 revision
评审时继续校准，但不阻止本次基线冻结。

## 当前证据边界

- 单元测试覆盖 9 个分类组合、默认 expiry、超长拒绝、旧库违规拒绝、DB 满额回滚、WAL 长读者
  阻塞和索引 headroom 拒写；
- `gate:phase6-sqlite-live` 在真实 APFS 临时目录重复上述 quota/retention 探针，并输出
  `VERIFY:phase6i:storage_policy:*`；
- 同一门禁另用获批的 128/256/256 MiB 策略实际打开 Store，验证 9 个分类默认 expiry 和当前
  使用量均落在生产上限内；
- 这不关闭真实断电、静态加密、密钥轮换或 SSD 介质级 secure-delete。
