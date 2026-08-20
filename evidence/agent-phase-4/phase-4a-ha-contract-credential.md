# Phase 4A HA Contract & Credential Boundary Evidence

日期：2026-08-20

## 当前结论

4A 的实现与本地退出门禁已完成，当前等待用户 review。Robot RoleProfile 仍无 HA Tool；本轮未读取
真实 token、未连接真实 Home Assistant、未调用 service，也未产生真实家居副作用。4B Read-only
Robot HA Tool 尚未启动。

## 契约边界

- 新增 `contracts/home-assistant/v1`，冻结 policy schema、Tool catalog、有效脱敏示例与 7 类无效样例；
- 模型侧只使用稳定 alias，不接收真实 `entity_id`、任意 domain/service/data 或全量 HA 状态；
- domain 固定为 `light/switch/scene/climate/sensor/binary_sensor`，写动作语义按 domain 本地复验；
- 状态只投影契约列出的标量 attribute，HA 名称、未知 attribute 和指令样式状态文本不会进入投影；
- 4A 虽冻结后续工具形状，但没有把任何 `home.*` Tool 加入 Robot、Human、Cat 或 Router RoleProfile。

## 凭证与传输边界

- 配置入口只接受 HA URL、绝对 token file 和绝对 policy file；token file 使用 `O_NOFOLLOW` 打开，
  必须为当前用户拥有的普通文件且权限为 `0600` 或更严格；
- URL 禁止内嵌账号、密码、query、fragment 和自定义路径；默认只接受 TLS，明文 LAN 连接需要显式
  `allow_insecure_ws`；client constructor 会再次复验配置，不能靠绕过文件加载器扩大边界；
- access token 只在 WebSocket `auth` frame 和逐实体 REST Authorization header 的内部传输路径使用，
  不写入 URL、socket header、审计事件或异常信息；
- WebSocket 使用官方 in-band auth、单调整数 request id、有界 pending table、请求/握手 timeout、
  `state_changed` 订阅与固定 frame 上限；重连只重载 allowlist 快照，不重放请求；
- 初始状态使用逐个 allowlisted entity 的有界 REST 响应，不调用 WebSocket `get_states`；状态快照
  先整批验证再原子写入，额外、缺失、超大或非法实体都会在 ready 前 fail closed；
- HA 断线原因和远端原文不进入审计，事件洪水只影响固定 policy 大小的缓存与有界 metrics。

协议实现依据 Home Assistant 官方
[WebSocket API](https://developers.home-assistant.io/docs/api/websocket/) 与
[Authentication API](https://developers.home-assistant.io/docs/auth_api/)；4A 只验证协议适配器，不验证
任何真实 HA 账号、实体或权限。

## 本地验证

| 门禁 | 结果 |
|---|---:|
| Node 24.19 strict typecheck | 通过 |
| Agent tests | 156/156 |
| Phase 4A contract/transport targeted tests | 15/15 |
| Device/Tool Contract v1 validator | 通过 |
| Object Runtime v2 validator | 通过 |
| HA Runtime v1 validator | 1 有效、7 无效 policy；4 tools；6 domains |
| Python cross-stage contract tests | 58/58 |
| `git diff --check` | 提交前执行 |

定向测试覆盖：凭证文件权限与 symlink、URL/安全模式复验、auth invalid、鉴权阶段异常消息、重复与
乱序 response id、pending 上限、request/handshake timeout、二进制帧、事件洪水、非 allowlist 实体、
过宽或缺失 snapshot、断线/重连不重放、审计脱敏、角色工具集合不变，以及真实本地回环 WebSocket
adapter 的 in-band auth 与整数 request id。回环测试仅监听 `127.0.0.1` 随机端口。

## Review 后才可进入 4B 的事项

- 创建并读取 Robot 专用、非管理员、可独立撤销的真实 HA token；
- 连接真实 HA 并验证逐实体 allowlist 读侧；
- 向 Robot RoleProfile 开放 `home.get_entity(alias)`；
- 把 HA observation 与 Interaction/Run/ToolCall 持久化关联。

以上事项均不属于本次 4A 授权范围。
