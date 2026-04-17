# ha-client-state-subscription Plan

所属 Milestone: `M4`

## 1. 背景

`M4` 的第 4 号 plan `ha-client-websocket-bootstrap` 已经在 `firmware/components/ha_client/` 中建立了到 `Home Assistant` WebSocket 的连接与鉴权状态机：连接完成且 `auth_ok` 后，`ha_client` 进入 `HA_CLIENT_STATE_READY`，对外只暴露 `ha_client_get_state()` / `ha_client_wait_ready()` 等生命周期相关 API。

但 `READY` 本身只代表“已鉴权的空闲 WebSocket”——面板还没有任何实体数据，也没有订阅任何事件。`M4` 的交付物要求（见 [project-milestones.md](../project-milestones.md) `M4`）：

- `VERIFY:ha:subscribed:PASS`
- `VERIFY:ha:initial_states_loaded:PASS n=<count>`
- 面板冷启动 30s 内完成 `Wi-Fi → SNTP → HA 鉴权 → 初始 state 加载`
- 白名单内任一实体在 HA 侧变化后，`<2s` 内更新到 `panel_data_store`

这一块正是本 plan 的职责：**在 `ha_client` 已 READY 的基础上，扩展出“订阅 state_changed 事件 + 拉取初始快照 + 向下游以回调方式吐出变更”的最小闭环**，使下一号 plan `panel-data-store`（plan 6）有稳定的单一数据入口。

本 plan **不是新组件**，是对 plan 4 同一个 `firmware/components/ha_client/` 组件的原地扩展。对外新增的符号严格按照本轮 plan wave 共享 ICD 的 “plan 5 — ha_client state subscription” 小节，不改名、不扩散。

## 2. 目标

- 在 `ha_client` 达到 `HA_CLIENT_STATE_READY` 后，自动按序执行：
  1. `subscribe_events`（`event_type = state_changed`）
  2. `get_states`（一次性拉取全量初始快照）
  3. 把初始快照里每条实体合成一条 `state_changed` 风格的回调，再进入稳态 `event` 转发
- 对外提供**唯一**、线程安全的回调注册点 `ha_client_set_state_change_callback`，由下游 `panel_data_store`（plan 6）消费
- 暴露订阅就绪与初始状态计数两个只读查询：`ha_client_subscription_ready` / `ha_client_initial_state_count`
- 在启动期 `VERIFY:` 体系里追加：
  - `VERIFY:ha:subscribed`
  - `VERIFY:ha:initial_states_loaded`（以 `initial_state_count > 0` 作为 PASS 条件）
- 明确“回调执行线程”这一跨模块契约：回调跑在 `ha_client` 内部任务上，**禁止**在回调里直接操作 `LVGL`/`esp_lvgl_port`；下游必须自己切线程。本 plan 通过 header 注释与 README 做文档层约束，**不**在 plan 5 内做线程强制隔离
- 对 cJSON 解析失败、`id` 不匹配、超大 payload 等异常具备“记日志 → 丢弃 → 继续运行”的退化路径，不让 `ha_client` 回到 `ERROR` 或崩溃

## 3. 范围

包含：

- 在 `ha_client` 内新增子模块（逻辑上，仍在同一组件）：
  - `message_id` 自增分配器
  - 出站消息构造：`subscribe_events` / `get_states`
  - 入站消息 router：按 `type` 分流 `result` / `event`，按 `id` 关联我们自己发起的请求
  - `state_changed` 事件解构，产出对外结构体 `ha_client_state_change_t`
  - 初始快照回放器：`get_states` 的 `result` 到齐后，遍历数组，为每个 entity 合成一次 `ha_client_state_change_t` 回调
  - 订阅就绪 / 初始状态计数统计与 `VERIFY:` 标记发出
- 使用 `cJSON`（IDF 自带，无需新依赖）做入站 JSON 解析；出站 JSON 手写拼接，避免额外堆分配
- 新 Kconfig：
  - `CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS`（默认 `10000`）
  - `CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES`（默认 `8192`）
- 对外 API（与 ICD 严格一致，不允许重命名）：
  - `typedef struct { const char *entity_id; const char *state_value; const char *attributes_json; int64_t updated_at_ms; } ha_client_state_change_t;`
  - `typedef void (*ha_client_state_change_cb_t)(const ha_client_state_change_t *change, void *user);`
  - `esp_err_t ha_client_set_state_change_callback(ha_client_state_change_cb_t cb, void *user);`
  - `uint32_t ha_client_initial_state_count(void);`
  - `bool ha_client_subscription_ready(void);`
- `app_main` 启动期 `VERIFY:` 基线追加：
  - `VERIFY:ha:subscribed:PASS|FAIL`
  - `VERIFY:ha:initial_states_loaded:PASS|FAIL n=<N>`

不包含：

- WebSocket 连接建立与鉴权（归 plan 4 `ha-client-websocket-bootstrap`）
- 指数退避重连策略、可恢复/不可恢复错误分类、metrics（归 plan 10 `ha-client-reconnect-and-diagnostics`）
- 按 `entity_id` 做缓存、去抖、`freshness` 三态（归 plan 6 `panel-data-store`）
- 实体白名单过滤（归 plan 7 `panel-entity-whitelist-config`）
- UI 侧任何渲染、状态栏、卡片（归 plan 8 / plan 9）
- `call_service` 等控制回写（归 `M6`）
- 历史数据查询（归可选 plan 11 `ha-history-mini-chart`）

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ha_client/`（plan 4 已建立，本 plan 原地扩展）
  - `include/ha_client.h`：追加 `ha_client_state_change_t`、`ha_client_state_change_cb_t`、`ha_client_set_state_change_callback`、`ha_client_initial_state_count`、`ha_client_subscription_ready`；在 header 注释里写明回调线程契约
  - `ha_client.c`：新增内部子模块（message id 分配、出站构造、入站 router、cJSON 解析、初始快照回放）
  - `ha_client_internal.h`（若 plan 4 没建，本 plan 新增）：内部共享类型（请求匹配表、订阅状态枚举），不对外
  - `Kconfig.projbuild`（plan 4 已建）：追加 `P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS`、`P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES`
  - `CMakeLists.txt`：`REQUIRES` 追加 `json`（即 IDF 自带的 `cJSON` 组件）；不新增 managed component
  - `README.md`：在“订阅链路”小节追加：回调线程 / 退化路径 / `VERIFY` 标记
- `firmware/components/board_support/`
  - `board_support.c` / `include/board_support.h`：透传 `board_support_ha_subscription_ready()` / `board_support_ha_initial_state_count()`
- `firmware/main/app_main.c`：启动摘要与 `log_verify_marker` 追加两条 `VERIFY:ha:...`
- `firmware/sdkconfig.defaults`：无需改动（`cJSON` 默认启用，WebSocket 已在 plan 4 配置）
- `firmware/dependencies.lock`：无新增
- 不新建组件，不新建分区

### 4.2 模块拆解

`ha_client` 在 `READY` 状态后新增一条“订阅子状态机”（与 plan 4 的连接/鉴权状态机**正交**，不覆盖也不替换 `ha_client_state_t`）：

```text
SUB_IDLE
  └─(ha_client 进入 READY)→ SUB_SUBSCRIBING
SUB_SUBSCRIBING
  ├─(收到匹配 id 的 result: success=true)→ SUB_FETCHING_INITIAL
  └─(result: success=false 或超时)→ SUB_FAILED（记日志，留给 plan 10 处理重置）
SUB_FETCHING_INITIAL
  ├─(收到匹配 id 的 result: success=true, result 数组)→ SUB_REPLAYING → SUB_STEADY
  └─(超时 CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS)→ SUB_FAILED
SUB_STEADY
  └─(收到 event: event_type=state_changed)→ 调回调，继续 SUB_STEADY
```

内部子职责：

- **message_id 分配**：单调自增 `uint32_t`，每次 `send_json` 前 `++`，跳过 0。分配与记账在同一把互斥锁下。
- **pending 请求表**：仅需记录本 plan 发起的两条请求 id（`subscribe_id`、`get_states_id`）。不做通用 RPC 表，保持最小面。
- **出站 JSON 构造**：手写 `snprintf`，不引入 cJSON 的 print 路径，避免在连接初期分配大堆块。样例：
  - `{"id":%u,"type":"subscribe_events","event_type":"state_changed"}`
  - `{"id":%u,"type":"get_states"}`
- **入站 router**：`esp_websocket_client` 的 `WEBSOCKET_EVENT_DATA` 回调里把 payload 拷贝到 `ha_client` 内部任务的队列（plan 4 已有），本 plan 在该任务里解析：
  - 先按 `CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES` 做长度硬截断：超过则日志 `drop oversized` 并丢弃，不 cJSON
  - `cJSON_ParseWithLength` 解析；失败 → 日志 `cJSON parse fail` → 丢弃
  - 读 `type`：
    - `result`：读 `id`、`success`；匹配 `subscribe_id` 或 `get_states_id` 推动子状态机；不匹配则丢弃（仍记 `DEBUG` 级日志）
    - `event`：读 `event.event_type`；不是 `state_changed` 丢弃；是则进入结构体提取
    - 其它：丢弃
  - 每条入站消息解析完成后 **立即** `cJSON_Delete`，不保留长生命周期的 cJSON 节点；对外回调传出的 `entity_id` / `state_value` / `attributes_json` 指向**一块本地临时缓冲区**，回调返回后立即失效（语义写入 header 注释）
- **初始快照回放器**：`get_states` 的 `result` 是一个数组，每个元素是一个实体状态。回放器按数组迭代，为每个元素合成一条 `ha_client_state_change_t`：
  - `entity_id`：来自元素 `entity_id`
  - `state_value`：来自元素 `state`
  - `attributes_json`：把 `attributes` 子对象用 `cJSON_PrintUnformatted` 序列化到本地临时缓冲；每回调完一条后 `free`
  - `updated_at_ms`：优先使用 `last_changed` / `last_updated` 解析为 epoch ms；缺失则用 `time_service_last_sync_epoch_ms()` 兜底（若仍为 0，传 0，由 plan 6 做兜底）
  - 每合成一条就调用用户回调，**串行**调用，保证下游不需要处理并发
- **订阅就绪 / 初始计数统计**：
  - `ha_client_subscription_ready()`：在进入 `SUB_STEADY` 前置 `true`；断线回到 plan 4 的 `CONNECTING` 时由 plan 10 的回调复位为 `false`（本 plan 只保证自己进 `SUB_STEADY` 时置位）
  - `ha_client_initial_state_count()`：回放完成即落定；本 plan 期间不再改动

### 4.3 数据流 / 控制流

启动链路（plan 4 已保证 `HA_CLIENT_STATE_READY` 可达）：

1. `ha_client` 内部任务发现 `state == HA_CLIENT_STATE_READY` 且 `sub_state == SUB_IDLE` → 立即发 `subscribe_events`，`sub_state = SUB_SUBSCRIBING`
2. 收到匹配的 `result { success: true }` → 发 `get_states`，`sub_state = SUB_FETCHING_INITIAL`；同时记录 `subscribe_sent_at_ms`
3. 收到匹配的 `result { success: true, result: [...] }` → 进入回放循环：
   - 遍历数组，按顺序合成 `ha_client_state_change_t` 并调用回调
   - 全部回放完成：`initial_state_count = N`，`subscription_ready = true`，`sub_state = SUB_STEADY`
   - 打印 `VERIFY:ha:subscribed:PASS` 与 `VERIFY:ha:initial_states_loaded:PASS n=N`
4. `SUB_STEADY` 下的每条 `event { event_type: state_changed }`：
   - 解析 `event.data.entity_id` / `new_state.state` / `new_state.attributes` / `new_state.last_updated`
   - 调回调
   - 无需记账 `initial_state_count`
5. 若 `SUB_SUBSCRIBING` 或 `SUB_FETCHING_INITIAL` 在 `CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS` 内未完成：
   - `sub_state = SUB_FAILED`
   - 打印 `VERIFY:ha:subscribed` 或 `VERIFY:ha:initial_states_loaded` 为 `FAIL`
   - 不主动断连，由 plan 10 的重连策略在断线/重置后触发新一轮订阅
6. 回调执行线程：`ha_client` 内部任务。**硬约束**（写入 header 注释与 README）：
   - 回调体内禁止直接调用 `lv_*` / `esp_lvgl_port_*`
   - 回调体内禁止再调用 `ha_client_*`（防重入）
   - 回调应尽快返回；下游若需阻塞工作，应自己 post 到 own queue
   - `const char *` 指针只在回调内有效，下游要用的字段必须立刻复制

控制流图（简化）：

```text
[WS recv task] --payload--> [ha_client task queue]
                                     │
                                     ▼
                          [parse + route (cJSON)]
                                     │
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
     match subscribe_id       match get_states_id       event: state_changed
        advance FSM            replay initial snapshot       direct fan-out
             │                       │                       │
             └─────────────┬─────────┘                       │
                           ▼                                 ▼
                 ha_client_state_change_cb_t  <──────────────┘
                           │
                           ▼
                 panel_data_store_update(...)  (plan 6)
```

## 5. 实现任务

代码侧（agent 可完成）：

1. 在 `firmware/components/ha_client/include/ha_client.h` 追加 ICD 指定的 5 个符号（结构体 / 回调 typedef / 3 个函数），并在 header 注释里写明：
   - 回调执行线程：`ha_client` 内部任务
   - 回调内禁止直接 LVGL 调用（必须跨线程 post）
   - 回调内禁止再调 `ha_client_*`（防重入）
   - `ha_client_state_change_t` 的 `const char *` 字段只在回调内有效，返回后失效
2. 在 `firmware/components/ha_client/ha_client_internal.h`（若无则新增）声明子状态枚举与 pending id 表
3. 扩展 `ha_client.c`：
   - `message_id` 分配器（锁保护）
   - 出站 JSON 构造（`snprintf`）
   - 入站 router：整合 plan 4 已有的 `WEBSOCKET_EVENT_DATA` 处理路径，按 `type` 分流
   - cJSON 解析 + 长度截断 + 失败降级
   - 初始快照回放器
   - `sub_state` 机与超时检测（基于 `CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS`）
   - `ha_client_set_state_change_callback` / `ha_client_subscription_ready` / `ha_client_initial_state_count` 实现
4. 在 `firmware/components/ha_client/Kconfig.projbuild` 追加：
   - `P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS`（`int`，默认 `10000`，范围 `1000 ~ 60000`）
   - `P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES`（`int`，默认 `8192`，范围 `2048 ~ 65536`）
5. 在 `firmware/components/ha_client/CMakeLists.txt` `REQUIRES` 追加 `json`
6. 在 `board_support` 追加透传 getter：`board_support_ha_subscription_ready` / `board_support_ha_initial_state_count`
7. 在 `firmware/main/app_main.c`：
   - 等 `ha_client_wait_ready(...)` 成功后，再等 `subscription_ready` 或订阅超时（复用 `CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS`，不再额外引入等待 Kconfig）
   - 追加 `VERIFY:ha:subscribed` 与 `VERIFY:ha:initial_states_loaded`（后者 PASS 条件：`initial_state_count > 0`）
   - `VERIFY` 打印前不做阻塞订阅路径的强制动作，超时后允许 `FAIL` 不 panic
8. 更新 `firmware/components/ha_client/README.md`：
   - 订阅子状态机
   - cJSON 使用范围与回调字段生命周期
   - 回调线程契约（文字明确“不要在回调里直接动 LVGL”）
   - 新增两条 `VERIFY` 标记

本地硬件侧（用户在开发机上完成，agent 给出命令）：

9. `idf.py build` 通过；检查 `idf_size` 对固件体积的影响（受 `factory` 仅剩约 2% 约束，必要时在 review 里记录）
10. 真机联调：冷启动后串口应当依次出现 `ha:ws_connected → authenticated → subscribed → initial_states_loaded n=<N>`
11. 人为在 HA 侧触发某实体状态变化，观察日志中回调次数与 `entity_id` 匹配
12. 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ha-subscription-v1.log` 作为 review 附件

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 与 `idf.py build` 全绿，无新增编译/链接错误
- `idf.py reconfigure` 后 `dependencies.lock` 无新增项（本 plan 不引入 managed component）
- `idf.py menuconfig` 可见两个新 Kconfig 项，默认值符合本 plan（`10000` / `8192`）
- `firmware/components/ha_client/include/ha_client.h` 对外符号与 ICD 文本严格匹配（agent 自检 grep）

### 6.2 功能验证

- 无网络或无凭证路径（plan 4 的 ERROR 分支）：
  - `subscription_ready=false`、`initial_state_count=0`
  - `VERIFY:ha:subscribed:FAIL`、`VERIFY:ha:initial_states_loaded:FAIL n=0`
  - 其它 `VERIFY:` 不回归；固件不崩、心跳照常
- 有凭证且 HA 可达：
  - `subscribe_events` 请求 id 能与 `result` 匹配；匹配日志可见
  - `get_states` 返回后，回调按 `initial_state_count` 被调用相应次数（本地测试 hook 一个计数回调即可确认）
  - 回放过程中回调串行，无交错
- 异常消息退化：
  - 向队列注入超过 `CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES` 的 payload：只打印 `drop oversized`，不 panic
  - 注入非法 JSON：只打印 `cJSON parse fail`，不 panic
  - 注入 `result` 中 `id` 与我们发起的不匹配：打印 `debug: unknown id`，不影响既有子状态机

### 6.3 回归验证

- plan 4 既有 `VERIFY:` (`ha:ws_connected` / `ha:authenticated`) 仍为 `PASS`，时序不变
- plan 1 ~ 3 的 `VERIFY:` 全部不回归
- `ha_client_get_state()` 语义与 plan 4 保持一致：订阅失败不会把主状态从 `READY` 打回 `ERROR`（订阅失败只体现在 `subscription_ready=false` 与 `VERIFY` FAIL）
- `app_main` 心跳节奏不受订阅等待影响（订阅等待有独立超时，不叠加在 `wait_connected` 等既有等待之上）

### 6.4 硬件/联调验证

- 真实 HA 实例（含至少 10 个以上实体，便于观察初始快照）
- 冷启动 30s 内串口出现：
  - `VERIFY:ha:subscribed:PASS`
  - `VERIFY:ha:initial_states_loaded:PASS n=<N>` 且 `N >= 1`
- 在 HA 中手动触发某实体状态变化（例如切换一个 `input_boolean`），面板侧 ~2s 内日志出现对应 `entity_id` 的回调命中
- 长跑 30 min：
  - cJSON 相关堆分配无持续增长（借助 `heap_caps_get_free_size(MALLOC_CAP_8BIT)` 打点对比）
  - 回调次数与 HA 侧触发次数一致，无丢事件（`state_changed` 级别）
- 人为在中途 `kill` 掉 HA 服务再恢复：plan 10 不在本 plan 范围，本 plan 只要保证：断连期间 `subscription_ready=false`；**不要求**自动重新订阅（那是 plan 10 的交付物）

## 7. 风险

- **cJSON 内存占用**：HA 的 `get_states` 结果在多实体场景下可能几十 KB。cJSON 一次性构树会在堆上产生大量小对象（每字段 ~40 B），配合 IDF 的堆分配成本，可能短时占用几十到上百 KB。应对：
  - 严格遵守 `CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES` 长度截断，超限直接丢弃
  - 解析完**立即** `cJSON_Delete`，不保留子树
  - 初始快照回放时按数组元素流式处理，每个元素独立 `cJSON_Delete`（若拿到的是顶层一次 Parse，则在整条数组回放完成后再 Delete；取决于实现，两种都可接受，关键是不要把原始 cJSON 树长期挂在 `ha_client` 上下文里）
  - 回调字段用本地临时缓冲转存 `attributes_json`，不复用 cJSON 的 `char *`
- **回调重入**：下游如果在回调中又调了会触发 `ha_client` 内部动作的 API（例如重启连接），会造成任务重入或死锁。应对：header 注释明确禁止回调内调 `ha_client_*`；实现上 `ha_client_set_state_change_callback` 的读/写可用 read-mostly 锁，但**不在回调外层持长锁**，以免回调里任何二次调用都卡住
- **超大事件 payload**：个别实体（如 `weather.*`、`sensor.*_history` 类）单条 `state_changed` 可能接近甚至超过 8 KB。应对：
  - `CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES` 默认 `8192` 是“保守 + 可调”的折中，联调时若发现正常实体被误丢，应提高该值；若内存吃紧则加严
  - 截断日志里打印 `entity_id`（若能快速扫到）便于定位
- **`id` 匹配竞态**：如果 `subscribe` / `get_states` 发得过快，理论上两次 `result` 可能乱序到达。应对：`pending id` 表按 id 精确匹配，不依赖顺序
- **回调线程与 LVGL 的隐性耦合**：文档层强制下游做线程跳转；但下游若违反，会在 `lv_*` 内触发 assert。这是跨 plan 边界的问题，plan 5 只做文档层约束，不做运行时拦截——这是与 ICD 对齐的主动选择，不是遗漏
- **固件体积**：`cJSON` 在其它组件若已启用则本 plan 近乎零体积成本，但若此前未链接则会新增约 10 ~ 20 KB。`factory` 分区当前仅剩约 `2%`，实现阶段必须跑一次 `idf_size.py` 并在 review 中记录增量；若增量接近临界，优先不开启 `CONFIG_CJSON_*` 的可选特性
- **订阅失败但 `READY` 保持**：本 plan 故意不让订阅失败回写主状态，避免 plan 4 的 `HA_CLIENT_STATE_ERROR` 含义被污染；代价是 `ha_client_get_state()==READY` 时订阅仍可能未就绪，下游必须用 `ha_client_subscription_ready()` 作为“数据可用”判据，不能只看主状态
- **初始快照时间戳缺失**：若 HA 返回的实体 `last_changed` / `last_updated` 格式异常（罕见），`updated_at_ms` 会退化为 `0`，影响 plan 6 的 `freshness` 判定。属可接受降级，但需在 README 标注

## 8. 完成定义

- `firmware/components/ha_client/include/ha_client.h` 对外符号与本 plan 范围内 ICD 条目一字不差：`ha_client_state_change_t`、`ha_client_state_change_cb_t`、`ha_client_set_state_change_callback`、`ha_client_initial_state_count`、`ha_client_subscription_ready`
- `CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS` 与 `CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES` 可在 `menuconfig` 里见到且默认值为 `10000` / `8192`
- 真机冷启动 30s 内可观察到：
  - `VERIFY:ha:subscribed:PASS`
  - `VERIFY:ha:initial_states_loaded:PASS n=<N>` 且 `N >= 1`
- HA 侧触发白名单外实体状态变化时，面板日志依然能看到回调命中（白名单过滤是 plan 7 的事，本 plan 不做）
- 异常 payload / 非法 JSON / id 不匹配场景均以“日志 + 丢弃”收敛，不 panic、不改变 `ha_client_state_t`
- 既有 `VERIFY:` 标记全部不回归；`app_main` 心跳节奏在订阅等待下仍稳定
- `firmware/components/ha_client/README.md` 已更新，明确：订阅子状态机、cJSON 内存边界、回调线程契约、新 `VERIFY` 标记含义
- plan 6 `panel-data-store` 可以**只依赖**本 plan 的 5 个导出符号完成数据接入，不需要触碰 `ha_client` 内部

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待用户重点查看的文件

### 已完成的实现项

（待实现后补充）

### 已完成的验证项

（待实现后补充）

### 待重点查看的文件

- `firmware/components/ha_client/include/ha_client.h`
- `firmware/components/ha_client/ha_client.c`
- `firmware/components/ha_client/ha_client_internal.h`
- `firmware/components/ha_client/Kconfig.projbuild`
- `firmware/components/ha_client/CMakeLists.txt`
- `firmware/components/ha_client/README.md`
- `firmware/components/board_support/board_support.c`
- `firmware/components/board_support/include/board_support.h`
- `firmware/main/app_main.c`
