# SQLite quota 与分类 retention 策略

状态：实现与本地真实文件系统门禁已具备；生产字节限额和 retention 时长仍需 review 批准。

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
生产值应依据代表性家庭数据的写入速率、最长读事务和备份窗口另行批准。

## Retention 分类

`memory_retention` 是完整的 `kind × sensitivity` 矩阵，并使用独立的
`retention_policy_revision` 标识矩阵版本。它不复用 Memory 记录上的 `policy_revision`：后者只属于
ACL/投影访问策略，两类策略可以独立升级。缺 kind、缺敏感度、显式 expiry 超过上限，或重开时
发现旧记录无 expiry/超期，Store 都拒绝写入或拒绝打开。调用方传入 `expires_at_ms: null` 时，Store
用矩阵上限生成默认 expiry；更早到期仍允许。到期删除使用 bounded purge，既有外键和 FTS
trigger 继续传播到 ACL、tag、lineage 及搜索索引。

建议提交 review 的 revision 1 初始矩阵如下（天）：

| Memory kind | normal | personal | restricted | 依据 |
|---|---:|---:|---:|---|
| `conversation_summary` | 30 | 14 | 7 | 摘要变化快，且最可能含连续对话上下文 |
| `user_fact` | 365 | 180 | 30 | 明确用户事实需要长期价值，但敏感事实缩短保留 |
| `task_outcome` | 90 | 60 | 30 | 为纠错和审计保留中期结果，不永久保存执行细节 |

这些天数目前只用于合成门禁矩阵，尚未成为隐式生产默认值。正式启用前还需确认用户删除预期、
备份中的到期传播、适用法规以及是否允许对特定记录设置更短 expiry。

## 当前证据边界

- 单元测试覆盖 9 个分类组合、默认 expiry、超长拒绝、旧库违规拒绝、DB 满额回滚、WAL 长读者
  阻塞和索引 headroom 拒写；
- `gate:phase6-sqlite-live` 在真实 APFS 临时目录重复上述 quota/retention 探针，并输出
  `VERIFY:phase6i:storage_policy:*`；
- 这不关闭真实断电、静态加密、密钥轮换或 SSD 介质级 secure-delete。
