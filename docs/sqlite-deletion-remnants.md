# SQLite 删除与残留边界

本文冻结 Phase 6I 对 Memory 删除的可验证保证和不可外推范围。它适用于当前
SQLite/WAL 存储，不把 SQL 层删除等同于介质级安全擦除。

## 已验证保证

- `deleteMemoryCascade` 在一个事务内删除目标及其后代，并同步清除 FTS、标签和角色 ACL；
- 删除后，`get`、`list`、`search`、`recall` 和新生成的在线备份都不会再返回该 Memory；
- 删除审计只保留请求、Memory ID、幂等键、原因和时间，不保留 Memory 正文；
- 删除前已经生成的备份是独立历史副本，仍可读取删除前的 Memory；
- WAL 在 checkpoint、截断或覆盖前可能保留删除前页面。回归测试使用临时合成 canary
  明确证明逻辑删除后旧 WAL 帧与删除前备份仍可能含正文。

## 不可宣称的保证

- SQLite 行数为零、FTS 为空、`VACUUM` 成功或 WAL checkpoint 成功，不证明旧备份、
  APFS snapshot、Time Machine/云备份或复制到其他介质的数据已删除；
- 当前 Node 24.19 SQLite 默认 `secure_delete=OFF`。即使将来启用该 PRAGMA，也只能改善
  SQLite 可管理页面的覆盖行为，不能擦除旧备份、文件系统快照或 SSD 控制器保留的物理页；
- SSD 的 wear leveling、TRIM、控制器缓存和坏块重映射不受应用层 SQLite API 控制，
  因而不能用应用测试证明单条 Memory 的物理不可恢复；
- 当前没有数据库加密、密钥轮换或通过密钥销毁实现的 crypto-erasure，因此
  `secure_delete_gate_validated` 必须保持 `false`。

## 生产关闭条件

介质级删除门禁只能在以下设计经过独立审批并有真实环境证据后关闭：

1. 数据库、WAL、SHM、临时文件和所有备份的加密与密钥归属；
2. 在线/离线备份、APFS snapshot、远端副本和日志的保留与删除策略；
3. 删除后的 checkpoint/compaction 维护窗口、失败语义和并发写入影响；
4. 设备退役或隐私请求场景中的密钥销毁、整卷擦除及可审计回执；
5. 明确区分“产品查询不可见”“SQLite 页面已覆盖”“备份已过期/销毁”和
   “物理介质不可恢复”四个不同结论。

在上述条件完成前，产品只能报告逻辑删除完成，不能报告介质级安全擦除完成。
