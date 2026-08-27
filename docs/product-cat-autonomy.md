# P4Home Cat Autonomy 产品接线

## 安全边界

Cat Autonomy 默认不随 `pnpm start:voice` 启用。只有显式设置
`P4HOME_CAT_AUTONOMY_ENABLED=1` 后，产品进程才会读取独立配置和控制 token、启动 Device
Protocol v2 监听，并在目标 P4 完成 hello/capabilities/snapshot 握手后挂载事件源。

启用时必须同时满足：

- `P4HOME_PRODUCT_ROLE_MODE` 允许 Robot，真实 HA allowlist client 已完成连接；
- 配置中的每个 HA alias/domain 都与 HA policy 的投影一致；配置不能引入新 entity；
- P4 使用独立 Device Protocol v2 连接，Cat action 仍只有最小 World Tool；
- Timer 使用完成后再排下一次的一次性定时器，不补跑停机期间的 tick；
- World 事件同时检查当前和上一 action id，autonomy 动作的开始/完成变化都不会反馈触发；
- 控制面只监听 `127.0.0.1`，必须使用独立 bearer token，token 文件权限不宽于 `0600`；
- Cat 继续不接收原始用户文本、不持有 `home.*` Tool；所有用户交互优先取消 Cat。

## 配置

以 [示例配置](../agent/config/cat-autonomy.example.json) 为模板，复制到仓库外的私有运行配置目录。
`ha_room_targets` 的 key 必须是既有 HA policy alias，不能填写真实 `entity_id`。建议首次部署保持
`initial_mode=paused`，完成状态查询和 P4 握手检查后再启用。

除既有 Voice/HA/模型/审计环境变量外，还需要：

- `P4HOME_CAT_AUTONOMY_ENABLED=1`；
- `P4HOME_CAT_AUTONOMY_CONFIG_FILE`：绝对路径，最大 64 KiB；
- `P4HOME_CAT_AUTONOMY_CONTROL_TOKEN_FILE`：独立随机 token 的绝对路径，32–255 bytes，权限 `0600`；
- 可选 `P4HOME_DEVICE_HOST`、`P4HOME_DEVICE_PORT`（默认 `8444`）；
- 可选 `P4HOME_CAT_AUTONOMY_CONTROL_PORT`（默认 `9477`，host 固定为 `127.0.0.1`）。

产品 ready 日志只给出开关、ready 状态和端口，不输出 token、用户正文、HA entity id 或模型正文。

## 本地控制与审计

以下请求中的 `<CONTROL_TOKEN>` 由操作者从仓库外的 token 文件读取，不要粘贴到 issue、日志或证据：

```sh
curl -H 'Authorization: Bearer <CONTROL_TOKEN>' \
  http://127.0.0.1:9477/v1/autonomy/status

curl -H 'Authorization: Bearer <CONTROL_TOKEN>' \
  'http://127.0.0.1:9477/v1/autonomy/audit?limit=50'

curl -X PUT -H 'Authorization: Bearer <CONTROL_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"mode":"paused"}' \
  http://127.0.0.1:9477/v1/autonomy/mode
```

允许的 mode 为 `enabled`、`paused`、`disabled`。暂停和关闭都会取消 active/queued Cat lease；
控制和审计响应固定 `Cache-Control: no-store`。
审计响应将 admission policy 的 `decisions` 与真实运行终态 `executions` 分开返回；后者只包含
event/run/action identity、状态和有界错误码，不包含用户正文、HA entity id 或模型内容。

## 当前验收边界

本地测试已覆盖配置 fail-closed、等待 P4 ready、四来源装配、动作到 SQLite、autonomy World 尾部
反馈阻断、控制鉴权与 pause/disable。专用 `phase7_autonomy` 实机 profile 和上传前隐私审计已完成
编码并完成逐轮独立 bugs review。旧 run `33056257943` 的 artifact 因复核发现 entity 残留已删除，
不得作为通过证据；修复提交 `e8de907` 对应的新 run `33061620203` 已通过真实 P4、真实 HA 只读
连接、真实模型、终态后 P4 心跳和 120 秒、1 秒粒度资源采样稳定的 manifest-first 技术门禁
（非瞬时硬上限）。Agent
`RobotHaClient` 与 P4 内置 HA client 分别记录到零 `call_service` dispatch；该结论不覆盖其他 HA
客户端或 HA 服务端全局写入。profile 的 HA action 使用真实 allowlist 快照的隔离投影，不等同于
家庭现场实体真的发生了状态变化。2026-08-27 用户最终 review 通过，Phase 7 已关闭并归档；上述
产品与验证边界保持不变。
