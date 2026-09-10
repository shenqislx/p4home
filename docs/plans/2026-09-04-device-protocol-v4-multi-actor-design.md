# P4 Device Protocol v4 多角色设计

> Status: `implemented`（2026-09-10：双角色设备实测通过；产品语音与自治部署见三角色启用记录）
> Date: 2026-09-04
> Scope: 在同一台 ESP32-P4 上同时保留 Human Avatar 与 Cat，且不放宽既有角色安全边界
> Compatibility: Device Protocol v1/v2/v3 与 Tool Schema v1/v2/v3 保持冻结

## 1. 结论

v4 采用一个设备连接承载两个固定角色：

- `human_avatar`：Human 的屏幕身体，响应用户交互；
- `cat`：电子宠物，只接收经过 Cat Event Policy 的低频自治事件。

两者共享房间、对象、显示、动画时钟和设备音频等物理资源，但角色状态、动作记录、工具投影、
会话、审计与模型上下文相互隔离。Agent 与 P4 之间只建立一个 TLS WebSocket，由一个连接级状态机
负责认证、握手、序列号、重连和全量对账，再向上提供两个 actor-scoped adapter。

不采用两条并行 v2/v3 WebSocket。那种方案会重复认证、握手、心跳和重连状态，并让两个连接同时
争用一个固件动作队列与一个世界真值，无法可靠定义先后关系。

## 2. 目标与非目标

### 2.1 目标

- Human Avatar 和 Cat 在同一固件、同一产品服务中同时在线；
- 一个角色的快照、动作终态或重连记录不能被另一个角色接收；
- 用户交互始终高于 Cat 自治行为，Cat 不能抢占 Human；
- 共享对象占用关系有唯一真值，不再用单角色 `occupied: boolean` 猜测占用者；
- v4 断线、超时、取消、幂等和对账语义不弱于 v2/v3；
- 所有数组、队列、文本和 JSON frame 保持固定上限；
- 迁移可回退到当前 v3 Human-only 产品模式。

### 2.2 非目标

- 不让 Cat 接收原始用户 transcript；
- 不给 Human、Cat 增加 Home Assistant 写权限；
- 不支持运行时创建任意 actor；v4 固定为两个 actor；
- 不在 v4 中承载 PCM、TTS 或逐帧动画数据；
- 不用 v4 的实现或稳定性测试替代当前长语音蓝屏问题的独立闭环；
- 不在设计阶段启用 Cat、改私有配置或烧录固件。

## 3. 为什么必须新建 v4

设计时（2026-09-04）的既有边界不能原地放宽：

- v2 没有 `actor_id`，其 `character` 默认代表 Cat；
- v3 要求所有能力、快照和动作生命周期都携带固定的
  `actor_id="human_avatar"`，明确拒绝 `cat`；
- Agent 产品入口在 v3 Human Avatar 与 v2 Cat Runtime 之间二选一；
- 固件 `world_service` 只有一个 `world_service_snapshot_t.character`、一个 active action 和一条队列；
- UI 的 `s_actor` 读取权威 World snapshot，而 `s_pet` 仍按固件本地计时随机移动。

因此兼容并蓄不是增加一个枚举值，而是将“单角色世界”升级为“共享世界 + 两个角色状态”。

## 4. 冻结的协议决策

| 决策 | v4 约束 |
|---|---|
| 连接 | 每台 P4 一个 TLS WebSocket，路径继续使用 `/v1/device` |
| 版本 | v4 frame 的 `protocol_version` 必须恒为 `4`；不在同一连接内混发旧版本 |
| Actor | 固定且有序：`human_avatar`、`cat`；未知、缺失或重复 actor 一律拒绝 |
| 顺序 | `seq` 仍为连接级单调序列，不改为每 actor 一套序列 |
| 动作 ID | `action_id` 在一个设备会话内全局唯一，不能由两个 actor 复用 |
| 世界版本 | `world_version` 表示共享世界版本；每个 actor 另有 `state_version` |
| 快照 | `world.snapshot` 与 `world.changed` 都发送完整有界世界，不发送需要复杂合并的局部 patch |
| 上限 | JSON frame 继续不超过 16 KiB；actor 固定 2 个；对象继续固定 3 个；全局动作队列继续为 8 |
| 权威 | P4 是 actor 位置、姿态、动画和对象占用的唯一运行时真值 |
| 优先级 | 由固件根据 `actor_id + origin` 推导，协议不接收调用方自报的数值 priority |

## 5. Envelope 与消息集合

v4 保留现有 envelope 字段：

```json
{
  "protocol_version": 4,
  "message_id": "msg-42",
  "correlation_id": "action-human-7",
  "device_id": "p4-product-human",
  "session_id": "boot-20260904-a",
  "seq": 42,
  "sent_at_ms": 1788537600000,
  "type": "action.request",
  "payload": {}
}
```

消息类型继续使用已有 14 种，不为 actor 复制消息名：

```text
device.hello
device.capabilities
world.snapshot
world.changed
world.resync.request
user.text
action.request
action.accepted
action.started
action.completed
action.failed
action.cancel
heartbeat
error
```

其中 `action.*` 必须携带 `actor_id`；`world.*` 是连接级共享世界，不在 payload 顶层放单一
`actor_id`。`user.text` 仍只进入用户 Role Router，绝不直接路由到 Cat。

## 6. 握手与能力

设备首先发送：

```json
{
  "boot_id": "boot-20260904-a",
  "firmware_version": "v4-candidate",
  "protocol_versions": [4],
  "connection_reason": "boot"
}
```

v4 Agent 必须收到以下能力结构后才建立 actor adapter：

```json
{
  "selected_protocol_version": 4,
  "actors": [
    {
      "actor_id": "human_avatar",
      "actions": [
        "character.go_to_room",
        "character.go_to",
        "character.sit",
        "character.look_at",
        "character.interact"
      ]
    },
    {
      "actor_id": "cat",
      "actions": [
        "character.get_state",
        "character.go_to_room",
        "character.set_activity",
        "character.say",
        "world.get_snapshot",
        "character.go_to",
        "character.sit",
        "character.look_at",
        "character.interact"
      ]
    }
  ],
  "rooms": ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
  "objects": [
    {
      "object_id": "living_room.sofa",
      "room_id": "living_room",
      "supported_actions": ["go_to", "sit", "look_at", "interact"],
      "available": true
    },
    {
      "object_id": "study.desk",
      "room_id": "study",
      "supported_actions": ["go_to", "look_at", "interact"],
      "available": true
    },
    {
      "object_id": "living_room.window",
      "room_id": "living_room",
      "supported_actions": ["go_to", "look_at", "interact"],
      "available": true
    }
  ],
  "limits": {
    "max_json_frame_bytes": 16384,
    "actor_capacity": 2,
    "action_queue_capacity": 8,
    "cat_queue_capacity": 2,
    "say_text_max_chars": 256,
    "action_timeout_min_ms": 100,
    "action_timeout_max_ms": 120000,
    "idempotency_retention_ms": 600000
  }
}
```

`objects` 继续使用 World Object Registry v1 的固定顺序、房间和动作能力。Human 的能力表只暴露
现有 Avatar Runner 可调用的五个动作；Cat 保留既有最小 P4 World 能力。Agent 不能把一个 actor
的 capability 合并到另一个 actor。

连接 readiness 条件固定为：合法 `device.hello`、合法 `device.capabilities`、随后一份同时包含两个
actor 的合法 `world.snapshot`。任一 actor 缺失时整个 v4 连接保持未就绪。

`protocol_versions` 只声明本次固件运行模式真正支持的版本；首版 v4 固件声明 `[4]`，旧版本由
对应旧固件保留。角色是否运行自主任务是 Agent 装配开关，不能通过省略 Cat 的设备状态来表达。

## 7. 共享世界状态

完整世界快照形状如下：

```json
{
  "snapshot_id": "snapshot-18",
  "reason": "connect",
  "world_version": 18,
  "observed_at_ms": 1788537600100,
  "actors": [
    {
      "actor_id": "human_avatar",
      "state_version": 11,
      "room_id": "study",
      "activity": "idle",
      "speaking": false,
      "active_action_id": null,
      "target_object_id": "study.desk",
      "pose": "standing"
    },
    {
      "actor_id": "cat",
      "state_version": 7,
      "room_id": "living_room",
      "activity": "idle",
      "speaking": false,
      "active_action_id": null,
      "target_object_id": "living_room.sofa",
      "pose": "sitting"
    }
  ],
  "objects": [
    {
      "object_id": "living_room.sofa",
      "room_id": "living_room",
      "available": true,
      "occupied_by_actor_id": "cat"
    },
    {
      "object_id": "study.desk",
      "room_id": "study",
      "available": true,
      "occupied_by_actor_id": null
    },
    {
      "object_id": "living_room.window",
      "room_id": "living_room",
      "available": true,
      "occupied_by_actor_id": null
    }
  ]
}
```

契约必须校验以下不变量：

- `actors` 恰好两个，顺序固定，actor id 不可重复；
- 每个 actor 的 `state_version` 独立单调增长；
- 任何共享状态改变都令 `world_version` 增长；
- `pose="sitting"` 时 `target_object_id` 必须是支持 sit 的可用对象；
- 坐下 actor 必须与对象的 `occupied_by_actor_id` 一致；
- 同一个对象最多有一个 `occupied_by_actor_id`；
- 站立 actor 可以观察同一对象，但不能因此取得占用权；
- 同一时间最多一个 actor 的 `speaking=true`；
- 坐标、楼层路径、Sprite、动画帧和对象锚点继续禁止出现在协议中。

`world.changed` 的 required 字段固定为 `world_version`、`observed_at_ms`、`change_reason`、`actors`
和 `objects`，仍携带完整 `actors + objects`；它不含 `snapshot_id/reason`，也不是局部 patch。
`change_reason` 仅允许 `action`、`cancel`、`timeout`、`fallback`、`user_interaction`、`resync`。
这种完整有界状态避免 Agent 在丢帧或重连边界合并出不存在的跨角色状态。

连接级 Hub 可以看到完整世界，用于交叉校验对象占用；向 Human/Cat Runtime 暴露时必须生成单角色
projection。`character.get_state` 和 `world.get_snapshot` 的 action result 必须携带请求的 `actor_id`，
并且只返回该 actor 的 character state 加共享 objects，不返回另一个 actor 的 character state。

## 8. Actor-scoped 动作生命周期

动作请求示例：

```json
{
  "action_id": "action-human-7",
  "actor_id": "human_avatar",
  "tool": "character.go_to_room",
  "arguments": {"room_id": "living_room"},
  "timeout_ms": 5000,
  "origin": "user"
}
```

`action.accepted`、`action.started`、`action.completed`、`action.failed` 和 `action.cancel` 必须原样
回传同一 `actor_id`。`action.completed` 同时返回：

- `actor_state_version`：该 actor 的终态版本；
- `world_version`：共享对象/角色一致性终态版本；
- 有界、按 tool 校验的 result。

Actor 与 origin 的合法组合固定为：

| Actor | 允许 origin | 禁止 origin |
|---|---|---|
| `human_avatar` | `user`、`agent`、`test` | `autonomy` |
| `cat` | `autonomy`、`agent`、`test` | `user` |

未来用户若要影响 Cat，必须先转成经过 review 的 mediated event，再由 Cat Runtime 以 `agent`
或 `autonomy` 发起，不能把用户原文或 `origin="user"` 直接交给 Cat。

## 9. 资源仲裁与抢占

设备端保留一个 active action 和一条容量为 8 的全局队列，因为屏幕动画、对象占用和部分音频资源
无法真正并行。仲裁规则完全确定：

1. `human_avatar + user`；
2. `human_avatar + agent`；
3. `cat + agent`；
4. `cat + autonomy`。

`test` 只在测试 profile 中允许，并由场景显式指定等价等级。具体规则：

- Cat 最多占用两个 queued slot，不能填满全局队列；
- Human 请求到达时，所有未开始的 Cat autonomy 动作立即以 `CANCELLED` 结束；
- active Cat 在安全动画边界取消，Human 可以先 accepted，但必须等 Cat terminal 后才能 started；
- Cat 请求遇到 active/queued Human 时返回可重试 `DEVICE_BUSY`，不能排到 Human 前面；
- Cat 永不取消 Human；
- Voice capture、模型响应、TTS 和 playback 活跃时暂停 Cat 新动作准入；
- Cat `character.say` 与 Human TTS 共用单一音频/对话资源，冲突时 Cat 返回可重试 `DEVICE_BUSY`；
- 对象已被另一个 actor 占用时不做隐式搬移，返回 `OBJECT_OCCUPIED`，details 只包含
  `occupied_by_actor_id` 和 `object_id`；上层如需让位必须显式规划新动作。

Agent 现有 `LowPriorityCatRunRegistry` 继续在模型与动作发送前抢占 Cat；固件仲裁是第二道防线，
不能依赖 Agent 恰好及时取消。

## 10. 错误、幂等与重连

v4 沿用旧错误，并新增：

```text
UNKNOWN_ACTOR
ACTOR_DISABLED
ACTOR_ORIGIN_FORBIDDEN
ACTOR_BUSY
```

约束如下：

- 相同 `action_id + actor_id + tool + arguments` 重试返回缓存生命周期结果；
- 相同 `action_id` 携带不同 actor 或不同请求指纹时返回 `ACTION_ID_CONFLICT`；
- Agent 接收到 actor 不匹配的 lifecycle message 必须关闭连接，不能只丢弃该 frame；
- seq 缺口、乱序、非法 world version 或 actor state version 回退都会触发全量 resync；
- 断线中的动作保持 `unknown` 且禁止自动重放；
- 重连后先完成 v4 三段握手，再按 actor snapshot 对账；
- P4 boot id 改变时，旧 action 不能依赖设备幂等缓存，Agent 只能按可观察终态判断；
- 同一 boot id 重连时仍使用设备保留的 10 分钟幂等记录。

## 11. Agent 侧结构

`DeviceRuntimeHub` 演进为连接级 Hub，不再让一个 `DeviceWebSocketActionAdapter` 同时承担连接状态与
单 actor 状态：

```text
DeviceRuntimeHub
└── DeviceConnectionRuntime(device_id)
    ├── envelope seq / handshake / reconnect / full-world snapshot
    ├── global action-id registry
    ├── ActorActionAdapter(human_avatar)
    └── ActorActionAdapter(cat)
```

公开接口改为：

```ts
getActorAdapter(deviceId, "human_avatar")
getActorAdapter(deviceId, "cat")
onActorReady(deviceId, actorId, adapter)
```

每个 adapter 只看自己的 character projection 和共享 objects 的只读副本。Human Runner 不得取得
Cat adapter；Cat Runtime 不得取得 Human adapter。连接级 frame validator 先验证完整世界不变量，
再生成两个不可变 projection。

产品装配取消当前 v3/v2 `if/else`：

- 始终可以创建 v4 Hub 与 Human Avatar adapter；
- `P4HOME_CAT_AUTONOMY_ENABLED=1` 只决定是否挂载 Cat Runtime，不关闭 Human Avatar；
- `P4HOME_PRODUCT_ROLE_MODE` 只控制语音 Human/Robot，不再决定设备 actor 协议；
- Cat 启用时独立建立其所需的受限 HA 状态投影，即使语音仍为 `human-only` 也不能顺带启用 Robot
  工具；HA transport 是否连接与 Robot Role 是否对用户开放是两个独立决定；
- Cat 第一次部署仍强制 `initial_mode="paused"`；
- 私有配置、HA allowlist、控制 token 或 Cat Runtime 装配缺失时，Cat fail closed，Human 保持可用；
  设备握手缺少 Cat actor/state 则属于整个 v4 世界不完整，按连接级 readiness 规则拒绝，不能把
  不完整设备连接误报为 Human ready；
- Human 与 Cat 使用不同 Session、Run、Memory、Tool catalog 和审计 actor id。

建议新增独立开关 `P4HOME_HUMAN_AVATAR_ENABLED`，默认 `1`。它与 Cat 开关正交，不再用
`human-only` 推导设备角色。

## 12. 固件侧结构

`world_service` 需要改为固定容量的多角色状态，而不是复制两套完整服务：

```c
typedef enum {
    WORLD_ACTOR_HUMAN_AVATAR = 0,
    WORLD_ACTOR_CAT = 1,
    WORLD_ACTOR_COUNT = 2,
} world_actor_id_t;

typedef struct {
    world_actor_id_t actor_id;
    world_room_id_t room;
    world_activity_t activity;
    bool speaking;
    char active_action_id[WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
    uint32_t state_version;
    char target_object_id[WORLD_OBJECT_ID_MAX_BYTES + 1U];
    world_character_pose_t pose;
    /* 坐标、朝向和动画仍为固件内部渲染状态。 */
} world_actor_state_t;

typedef struct {
    uint32_t world_version;
    world_actor_state_t actors[WORLD_ACTOR_COUNT];
    world_object_state_v4_t objects[WORLD_SERVICE_OBJECT_CAPACITY];
} world_service_snapshot_v4_t;
```

动作记录增加 `actor_id`，但全局 record capacity、deadline、幂等保留时间和 action queue 上限不扩大。
`agent_transport` 增加 v4 编解码、完整 snapshot 序列化以及 actor/origin 校验。任何字符串仍先做长度、
UTF-8 与枚举校验，再写固定容量结构体。

## 13. UI 映射

v4 明确映射：

- `human_avatar` → 当前主角色 `s_actor`；
- `cat` → 当前宠物 `s_pet`。

在 v4 模式下移除 `s_pet` 的本地随机漫游计时，Cat 的位置和动作只由 Cat actor snapshot 驱动；
否则 UI 看见的 Cat 与 Agent 审计中的 Cat 会产生双重真值。v3 回退模式可以继续保留本地装饰宠物，
但它必须保持不可远控、不可写入 Human snapshot。

Cat 目前只有 idle Sprite。实现 v4 前必须补齐或明确降级其 walk/sit/look/interact 视觉资源；缺少资源
时不能把动作标记为完成后仅移动 Human Sprite。两个 actor 分别维护有界的渲染状态与 deferred
animation 队列，共享 8 FPS tick，但不共享位置、目标、pose 或 active action。

## 14. 安全与隐私边界

- TLS、设备 token、SPKI pinning 和一设备一连接规则保持不变；
- actor id 是强制路由边界，但不是新的认证凭据；认证仍属于 device；
- Role Runtime 必须在 Tool 层再次校验 actor，不能只依赖设备协议；
- Cat 不接收用户正文、Human/Robot prompt、完整聊天历史或 HA entity id；
- v4 日志只记录 device/session/action/actor/type/status/version 和有界错误码；
- world snapshot 可进入短期诊断与审计，但不能作为 Agent 恢复真值；
- Cat 控制面继续只监听 `127.0.0.1`，沿用独立 mode-0600 token；
- 未知 actor、actor 生命周期串线、origin 越权和 capability 提升均 fail closed。

## 15. 兼容矩阵

| Agent | 固件 | 结果 |
|---|---|---|
| v2 Cat | v2 | 保持现状，仅 Cat 主角色 |
| v3 Human | v3 | 保持现状，仅远控 Human Avatar |
| v4 Multi-actor | v4 | Human Avatar + Cat 同时存在 |
| v4 Agent | v2/v3 固件 | 拒绝 readiness，不自动降级 |
| v2/v3 Agent | v4 固件 | 拒绝 readiness，不混发旧 frame |

显式拒绝比静默降级安全。回退时同时恢复匹配的 Agent 版本、产品配置和 v3 固件，不能只改一个
环境变量。

## 16. 分阶段实现

### V4A — Contract only

- 新建 `contracts/device-protocol/v4` 与 `contracts/tools/v4`；
- 加入合法/非法 example、AJV validator 和冻结契约测试；
- 覆盖未知 actor、重复 actor、跨 actor action id、占用不一致、版本回退和 origin 越权；
- 不修改产品入口，不烧录。

退出条件：v1/v2/v3 fixture 字节级不变；v4 contract gate 可重复通过。

### V4B — Agent multiplex runtime

- 拆分连接级 runtime 与两个 actor adapter；
- fake device 支持 v4 全量快照、抢占、断线和 resync；
- 产品入口可以同时装配 Human Avatar 与 paused Cat；
- Cat 配置缺失或未 ready 不影响 Human。

退出条件：模拟器证明两个 actor 的 snapshot、action、cancel、audit 无串线；旧 v2/v3 测试全部通过。

### V4C — Firmware world and UI

- 引入两个固定 actor state 与共享 object occupancy；
- 动作队列增加确定性仲裁；
- `s_actor`/`s_pet` 分别绑定 actor；
- 补齐 Cat 动画或按明确的降级表拒绝未实现动作；
- host test 覆盖队列、对象互斥、抢占、重连、内存和非法 frame。

退出条件：host test 与固件干净构建通过，16 KiB frame 与固定容量不被放宽。

### V4D — Real device, Cat paused

- 通过自托管 workflow 构建、烧录、上传 manifest 与串口 artifact；
- v4 三段握手后 Human Avatar 行为与 v3 基线一致；
- Cat adapter ready，但产品 mode 保持 paused，零自治模型调用、零 Cat action；
- 验证声音、UI、HA、触摸和 Human 长短动作无回归。

退出条件：传输、artifact 完整性和自动功能门禁通过；人工视觉/听觉观察单独确认。

### V4E — Controlled Cat enable

- 经用户单独批准后把 Cat 从 paused 切到 enabled；
- 仅使用隔离 HA 投影和低频测试事件；
- 验证 Cat 移动只驱动 `s_pet`，Human 动作只驱动 `s_actor`；
- 验证 Human 在 Cat queued、active、say、object occupied 四种场景下的抢占；
- pause/disable 必须取消 Cat 且保留 Human。

退出条件：真实设备技术门禁通过，用户人工确认两个角色的视觉身份与优先级符合产品预期。

## 17. 验收场景

最低必须覆盖：

1. v4 hello/capabilities/snapshot 正常就绪；
2. 任一 actor 缺失、重复、顺序错误或 capability 越权时拒绝；
3. Human 和 Cat 交替各执行 100 次动作，终态与 actor id 全部一致；
4. Cat active 时用户 Human 请求到达，Cat terminal 先于 Human started；
5. Cat 不能抢占 active Human；
6. 两个 actor 同时 sit 同一 sofa，只有一个成功且 occupancy 指向成功者；
7. 第 50 次动作后断线重连，全量 snapshot 恢复两个 actor；
8. action terminal actor 串线时 Agent 关闭连接；
9. Voice capture/TTS/playback 期间 Cat 无新动作 started；
10. paused/disabled 模式零 Cat model call、零 Cat action，Human 保持可用；
11. 30 分钟混合动作压力与 2 小时稳态无重启、panic、watchdog、队列泄漏或持续资源下降；
12. 单独执行长 TTS/多段播放压力，记录并闭环当前蓝屏问题，不把“未复现”写成“已修复”。

## 18. 回退

每个真实设备阶段都必须保存：

- v3 已验证固件 hash；
- v3 Agent 提交；
- 当前 Human-only 私有配置备份；
- v4 Cat mode 初始值 `paused`；
- 一条经过验证的“停止服务 → 恢复 v3 固件 → 恢复 v3 Agent/配置 → 启动服务”流程。

任何跨 actor 串线、Human 无法抢占 Cat、对象占用不一致、UI 角色错位、蓝屏、panic、watchdog 或
持续资源下降都触发回退；不能只关闭 Cat 开关后继续把有问题的 v4 固件留在产品环境。

## 19. 当前状态

2026-09-10 已实现并部署 v4。最新固件完成 26 项双角色设备检查、三条真实声学产品语音回归，以及一次 Cat 自主模型调用与设备动作闭环。Human、Robot、Cat 已恢复常驻，Cat 使用每小时定时事件、安静时段和既有速率限制。

真人屏幕观感与听感、复杂长语句日常表现仍需用户验收；本轮未测试真实 HA 写操作。详细范围与历史失败见 [三角色启用记录](../../evidence/agent-phase-5/2026-09-10-three-role-enablement.md)。

## 20. 实现记录（2026-09-10）

- 新增 v4 JSON Schema 和完整世界校验器，旧 v1/v2/v3 Schema 未修改。
- 单连接管理认证后的身份、全局序号、重同步、动作 ID；向既有 Human v3 / Cat v2 runner
  提供进程内投影。线上报文始终为 v4；投影不经过旧版本的单角色对象占用校验，
  先由 v4 校验共享对象的真实占用者，再限定每个 runner 的工具集合。
- world_service 使用两个角色状态、同一动作记录池和全局队列；Cat 至多两个排队槽位。
  Human 优先级在固件内确定，Cat 取消终态先于 Human started。
- v4 完整收包进入容量 8 的有界队列，由工作线程处理；连接代次隔离旧报文。
  握手同样移出 WebSocket 回调，避免收发与动作锁互相等待。
- 工作线程主栈帧与大快照临时变量分开，编译器报告主栈帧 48 bytes，
  连接处理阶段栈帧 6528 bytes；保留 12288-byte 原线程栈配置，并将 Agent 工作栈迁至 PSRAM，
  通过配对的 WithCaps API 创建和回收，以保留三路连接同时启动所需的内部内存。
- s_actor 继续呈现 Human；s_pet 在 v4 中跟随 Cat 权威状态，并提供独立文字气泡。
  v3 仍保留原本的本地宠物行为。
- 实机测试中发现的并发锁等待和栈保护重启已分别留档，修复后的 26 项设备检查通过。
  不把串口与协议证明等同于用户的屏幕观感、听感验收。
