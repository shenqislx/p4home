# Agent SQLite Production TODO

> Status: `deferred`
> Created: 2026-08-16
> Current scope: 不阻塞 Phase 1 单用户、单进程、Mock Tool Demo
> Review before: Phase 2 真实设备写入及任何长期运行部署

## 已在 Demo 阶段解决

- Session 对应 AgentProfile allowlist 在 Run 启动时生效；
- Run 启动、模型响应、Tool 请求/结果和 Run 终态使用 SQLite batch transaction；
- Tool 事件持久化 `tool_call_id`，失败、取消和超时使用不同终态事件；
- Run 不得在 ToolCall 或 Action 未终止时结束；
- 审计 wall clock 回拨时使用单调钳制时间；
- `getRunTrace()` 使用按 `run_id` 查询的一致性读快照。

## 延后到生产化阶段

| TODO | 触发门禁 | 验收要点 |
|---|---|---|
| 将 `DatabaseSync` 移入 Worker 或单写队列 | 接入并发 HTTP/Voice、Phase 2 真实设备写入前 | 锁竞争不阻塞主事件循环；cancel/health timer 可按时执行 |
| 增加 `application_id`、schema metadata 和完整 migration 框架 | 发布可复用安装包或支持已有数据库升级前 | 拒绝错误数据库；并发启动、升级失败和回滚可重复验证 |
| 数据库目录及 DB/WAL/SHM 权限收紧到仅当前用户 | 写入真实家庭对话或 HA 状态前 | 新建与重开均验证权限；备份不遗漏 WAL |
| 明确加密、密钥管理和防篡改策略 | 多用户主机或正式家庭部署前 | 敏感字段分类、静态加密、密钥轮换和审计完整性方案通过 review |
| AgentProfile 使用不可变 revision，并在 Run 保存授权快照 | 支持 Profile 在线修改或多个 Profile 前 | 历史 Run 可还原当时授权，不受后续配置修改影响 |
| 增加启动恢复和 reconciliation | Phase 2 真实 Action 前 | 重启后识别 running/pending；不会把未知结果当失败并盲目重放 |
| 决定 `synchronous=FULL`、checkpoint 和断电耐久策略 | 正式长期运行前 | kill/power-loss 测试证明约定的最近提交保留范围 |
| 增加字段长度、JSON shape、数据库配额、保留期和分页 | 连续运行或 Memory Phase 前 | 大输入不会造成无界磁盘/内存增长；查询有稳定上限 |
| Action 主键扩展为设备作用域 | 支持多个 P4 设备前 | 使用 `(device_id, action_id)` 保持协议幂等语义 |
| 增加 `integrity_check`、损坏隔离和可恢复备份 | 正式运维前 | 数据库损坏时 fail closed，并能恢复到已声明的恢复点 |

## 非目标

- Phase 1 不引入远程数据库、Vector DB 或分布式事务；
- 当前 TODO 不改变 Device Protocol v1 和 Tool Schema v1；
- 未完成对应门禁前，不把单机 Demo 的通过结果解释为生产耐久性证明。
