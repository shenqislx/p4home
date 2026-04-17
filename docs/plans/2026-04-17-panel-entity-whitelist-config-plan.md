# panel-entity-whitelist-config Plan

所属 Milestone: M4 (contributing to M5)

## 1. 背景

根据 [project-milestones.md](../project-milestones.md) 的 `M4` 交付物清单与 `2026-04-17` 版本的主线决策，面板实体清单来源已锁定为**固件内置 JSON**：MVP 期不走 NVS、也不走 Panel Gateway 下发，而是把一份经过审核的 HA `entity_id` 白名单直接打包进固件，启动期解析并注入 `panel_data_store`。

此前 plan 串的结构：

- `plan 5 (ha-client-state-subscription)` 会在 HA `READY` 之后拉起 `subscribe_events` + `get_states`，把所有状态变更以 `ha_client_state_change_t` 回调给下游
- `plan 6 (panel-data-store)` 负责按 `entity_id` 缓存最新值并管理 `fresh/stale/unknown`，对外暴露 `panel_data_store_register` 作为“白名单注入口”
- `plan 7`（本 plan）负责把一份 JSON 白名单解析成 `panel_sensor_t` seed，并批量调用 `panel_data_store_register`，让 `panel_data_store` 启动后**立刻具备可显示的卡片集合**，而不是等 HA 首帧才开始“发现”实体

之所以要走“固件内置”而不是“按事件动态发现”：

- HA 侧实体数量可能远超面板需要（上百实体），必须由面板端白名单收敛
- UI 卡片的展示顺序、分组、图标、单位都需要人工语义标注，HA 原生 `state_changed` 携带不了
- MVP 期没有配置 UI，也没有稳定的 Panel Gateway 协议，把这份“偏业务语义的配置”落到 NVS 反而会放大调试难度
- 打包进固件意味着“代码与配置一致升级”，回滚与审核更直观

本 plan 是 `M4` 的第 7 号 plan，也是 `M5` dashboard 能够出卡片的前提。

## 2. 目标

- 引入一份固件内置、版本化的实体白名单 JSON，位于 `firmware/components/panel_data_store/panel_entities.json`
- 在 `panel_data_store` 组件内通过 ESP-IDF 的 `EMBED_TXTFILES` 把该 JSON 作为只读符号嵌入固件，不占运行期文件系统
- 启动期用 `cJSON` 解析一次，把结果转成内部静态 `panel_sensor_t[]` 数组，并逐条调用 `panel_data_store_register`
- 对外暴露一个最小的只读访问面：`panel_entity_whitelist_load / _count / _at`
- JSON schema 带 `version` 字段，版本不匹配时 **fail closed**（打错误日志 + 返回零条目），不让错误数据污染 `panel_data_store`
- 启动期 `VERIFY:panel_whitelist:parsed n=<N>` 作为可观测锚点，解析失败或 `n=0` 即 `FAIL`
- 为 `M5` dashboard 准备 6~9 条覆盖 numeric/binary/text/timestamp 四种 kind 的样例实体

## 3. 范围

包含：

- 新文件 `firmware/components/panel_data_store/panel_entities.json`，包含 `version` 与 `entities[]`
- 在 `panel_data_store` 组件 `CMakeLists.txt` 中通过 `EMBED_TXTFILES panel_entities.json` 嵌入，并以 `_binary_panel_entities_json_start` / `_binary_panel_entities_json_end` 两个标准符号访问
- 新增源文件 `firmware/components/panel_data_store/panel_entity_whitelist.c` 与头文件 `firmware/components/panel_data_store/include/panel_entity_whitelist.h`
- 在同一组件的 `Kconfig.projbuild` 中新增 `P4HOME_ENTITY_WHITELIST_EMBEDDED`（默认 `y`），为将来 NVS/Gateway 路径保留开关位
- JSON → `panel_sensor_t` seed 的字段映射与默认值填充（`label = entity_id`、`unit = ""`、`group = "default"` 等）
- kind 字符串到 `panel_sensor_kind_t` 的映射，严格校验枚举集合 `{numeric, binary, text, timestamp}`
- 启动期调用顺序：`panel_data_store_init` 成功后立即 `panel_entity_whitelist_load`
- `VERIFY:panel_whitelist:parsed n=<N>` 以及对应的 PASS/FAIL 判据
- 在 `board_support` 中暴露一个只读摘要接口（可选但建议），方便 `app_main` 打 startup summary

不包含：

- 运行时热加载 / 替换白名单（`panel_entity_whitelist_load` 只在启动期调用一次）
- 基于 NVS 或 Panel Gateway 的白名单来源（`P4HOME_ENTITY_WHITELIST_EMBEDDED=n` 的分支仅占位，不在本 plan 实现）
- UI 卡片布局、分组分页、图标资源映射（归 `plan 8 ui-dashboard-sensor-cards`）
- 从 HA side `registry` 或 `config/get` 自动探测实体清单
- JSON schema 的自动生成器 / IDE 校验工具链
- 对 HA 属性（attributes）字段的任何加工，仅携带字段原样交给 `panel_data_store`
- HA 凭证的读取（归 `plan 3 settings-service-ha-credentials`；本 plan 仅作为其下游“配置载入”的平行动作，通过 Kconfig 暴露未来 override 口子，不访问 `settings_service` 的 HA namespace）

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/panel_data_store/`
  - `panel_entities.json`：**新增**，固件内置白名单数据
  - `panel_entity_whitelist.c`：**新增**，解析 + register + 对外访问
  - `include/panel_entity_whitelist.h`：**新增**，对外 API 与宏
  - `CMakeLists.txt`：**修改**，`idf_component_register` 加 `EMBED_TXTFILES panel_entities.json`、`SRCS` 加 `panel_entity_whitelist.c`、`REQUIRES` 加 `json`（cJSON）、`PRIV_REQUIRES` 视情况加 `log`
  - `Kconfig.projbuild`：**修改**，新增 `P4HOME_ENTITY_WHITELIST_EMBEDDED`（bool，默认 y）、`P4HOME_ENTITY_WHITELIST_MAX_ENTITIES`（int，默认 32）
  - `README.md`：**更新**，说明白名单来源、JSON schema、字段默认值、维护流程
- `firmware/components/board_support/`
  - `board_support.c` / `include/board_support.h`：**可选**，透传一个 `board_support_panel_whitelist_count()` 与 `board_support_log_whitelist_summary()`，便于 `app_main` 打 summary
- `firmware/main/app_main.c`：**修改**，在 `panel_data_store_init` 成功后调用 `panel_entity_whitelist_load()`，随后打印 `VERIFY:panel_whitelist:parsed`
- `firmware/dependencies.lock`：不新增管理组件，cJSON 已经随 ESP-IDF 自带（plan 5 已经引入 `json` 依赖）
- `firmware/partitions.csv`：不改，JSON 以 `.rodata` 形态进入 `factory` 分区
- 不新建组件，不新建分区

### 4.2 模块拆解

本 plan 在 `panel_data_store/` 组件内部新增一个**内聚、对外只读**的子模块 `panel_entity_whitelist`，分成四个职责（全在 `panel_entity_whitelist.c` 内）：

- **嵌入数据访问**：通过链接器自动生成的 `extern const uint8_t _binary_panel_entities_json_start[] asm("_binary_panel_entities_json_start");` 与 `_binary_panel_entities_json_end[]` 访问 JSON 原始字节；`EMBED_TXTFILES` 会自动追加 `\0`，可直接以 C 字符串使用
- **版本校验与解析**：`cJSON_Parse` → 取 `version`（必须 `== 1`），取 `entities`（必须是数组），任一校验失败立即 fail closed，内部 `g_count = 0`，返回 `ESP_ERR_INVALID_VERSION` 或 `ESP_ERR_INVALID_ARG`
- **逐条字段映射**：对 `entities[]` 每一项填 `panel_sensor_t`：
  - `entity_id`：必填，`strlen` 合法性检查，超长按 `panel_sensor_t.entity_id` 长度截断并记 warn
  - `label`：可选，缺省 `= entity_id`
  - `unit`：可选，缺省 `""`
  - `icon`：可选，缺省 `""`（`plan 8` 侧再做默认图标兜底）
  - `group`：可选，缺省 `"default"`
  - `kind`：必填，字符串映射 `"numeric"→NUMERIC / "binary"→BINARY / "text"→TEXT / "timestamp"→TIMESTAMP`，未识别即跳过该条并记 warn
  - `value_numeric = 0` / `value_text = ""` / `updated_at_ms = 0` / `freshness = UNKNOWN`
  - 有效条目数累加到静态上限 `CONFIG_P4HOME_ENTITY_WHITELIST_MAX_ENTITIES`
- **注入与对外 API**：每解析成功一条即 `panel_data_store_register(&seed)`，并把这条 seed 复制进内部 `static panel_sensor_t g_entries[MAX]`；对外暴露：
  - `esp_err_t panel_entity_whitelist_load(void);`
  - `size_t panel_entity_whitelist_count(void);`
  - `const panel_sensor_t *panel_entity_whitelist_at(size_t i);`（越界返回 `NULL`）

线程模型：`panel_entity_whitelist_load` 只由 `app_main` 主线程在启动期调用一次；`_count` / `_at` 是无锁只读，调用方对返回指针不得修改、也不得在 reload 后再访问（本 plan 不支持 reload，故无需锁）。

### 4.3 数据流 / 控制流

启动链路中本 plan 的插入位置：

1. `board_support_init`：按既有顺序 `settings_service_init → network_service_init → time_service_init → ha_client_init`（`ha_client_start` 延后）
2. `panel_data_store_init`（由 `plan 6` 提供）创建内部表与锁
3. **本 plan：`panel_entity_whitelist_load()`**
   - 访问 `_binary_panel_entities_json_start/_end` 得到 JSON 文本指针与长度
   - `cJSON_ParseWithLength(ptr, len)`；解析失败 → log error → 释放 cJSON 上下文 → `g_count = 0` → 返回错误
   - 取 `version`；非 `1` → log error → 同上 fail closed
   - 遍历 `entities[]`，逐条映射；每条成功就 `panel_data_store_register`，失败的条目 skip 并计入 `skipped_count`
   - 遍历结束后 `cJSON_Delete`，把 `cJSON` 占用的堆内存一次性释放（启动期峰值见 §7）
4. `app_main` 打印 `VERIFY:panel_whitelist:parsed n=<g_count>`：`g_count > 0` 记 `PASS`，否则 `FAIL`
5. 继续后续 `ha_client_start` / UI 初始化；后续 `plan 5` 的状态回调进入 `panel_data_store_update`，按 seed 预先登记好的 `entity_id` 命中更新，未登记的 `entity_id` 被忽略（由 `plan 6` 的默认策略决定）

数据生命周期：

- JSON 原文：作为 `.rodata` 常驻固件，不进堆
- cJSON 解析树：只在 `panel_entity_whitelist_load` 函数作用域内存在，结束前 `cJSON_Delete` 释放
- `panel_sensor_t` seed：拷贝值进入 `panel_data_store` 的内部表（`plan 6` 定义），以及本模块 `g_entries[]`（用于对外只读迭代）
- 所有字符串字段在 `panel_sensor_t` 内部是**定长数组**，不持有堆指针，便于跨线程读

## 5. 实现任务

代码侧（agent 可完成）：

1. 新增 `firmware/components/panel_data_store/panel_entities.json`，内容如下样例（UTF-8，无 BOM；保持 ASCII 与常见中文，便于肉眼 diff）：

   ```json
   {
     "version": 1,
     "entities": [
       {
         "entity_id": "sensor.living_room_temperature",
         "label": "客厅温度",
         "unit": "°C",
         "icon": "thermometer",
         "group": "客厅",
         "kind": "numeric"
       },
       {
         "entity_id": "sensor.living_room_humidity",
         "label": "客厅湿度",
         "unit": "%",
         "icon": "water-percent",
         "group": "客厅",
         "kind": "numeric"
       },
       {
         "entity_id": "sensor.home_energy_today",
         "label": "今日能耗",
         "unit": "kWh",
         "icon": "flash",
         "group": "能耗",
         "kind": "numeric"
       },
       {
         "entity_id": "binary_sensor.door_front",
         "label": "大门",
         "icon": "door",
         "group": "门窗",
         "kind": "binary"
       },
       {
         "entity_id": "binary_sensor.motion_hallway",
         "label": "走廊人体",
         "icon": "motion-sensor",
         "group": "门窗",
         "kind": "binary"
       },
       {
         "entity_id": "weather.home",
         "label": "天气",
         "icon": "weather-partly-cloudy",
         "group": "默认",
         "kind": "text"
       },
       {
         "entity_id": "sensor.last_motion_time",
         "label": "最近活动",
         "icon": "clock-outline",
         "group": "门窗",
         "kind": "timestamp"
       }
     ]
   }
   ```

2. 修改 `firmware/components/panel_data_store/CMakeLists.txt`：在 `idf_component_register` 中追加 `EMBED_TXTFILES panel_entities.json`，`SRCS` 加入 `panel_entity_whitelist.c`，`REQUIRES` 加入 `json`
3. 在 `firmware/components/panel_data_store/Kconfig.projbuild` 中新增：
   - `P4HOME_ENTITY_WHITELIST_EMBEDDED`：`bool`，默认 `y`，help 文本注明“MVP 期固定走内置 JSON；`n` 分支预留给未来 NVS/Panel Gateway 下发”
   - `P4HOME_ENTITY_WHITELIST_MAX_ENTITIES`：`int`，默认 `32`，range `1..128`
4. 新增 `firmware/components/panel_data_store/include/panel_entity_whitelist.h`：声明 `panel_entity_whitelist_load` / `_count` / `_at`，并在 doxygen 注释里明确调用时机（仅启动期一次、`_at` 返回只读）
5. 新增 `firmware/components/panel_data_store/panel_entity_whitelist.c`：按 §4.2 / §4.3 实现
6. 修改 `firmware/main/app_main.c`：在 `panel_data_store_init` 的 PASS 记录之后插入
   - `esp_err_t err = panel_entity_whitelist_load();`
   - `log_verify_marker("panel_whitelist", "parsed", err == ESP_OK && panel_entity_whitelist_count() > 0);`
   - `ESP_LOGI(TAG, "panel whitelist: n=%u", (unsigned)panel_entity_whitelist_count());`
7. 在 `panel_data_store/README.md` 追加“实体白名单”一节：数据文件位置、schema、字段默认值、新增实体的流程、版本号推进约定
8. （可选）在 `board_support` 中透传 `board_support_panel_whitelist_count()`，并在 `board_support_log_summary` 中打印一行 `panel_whitelist: n=<N>`

本地硬件侧（用户本机执行；agent 给出命令串）：

9. `idf.py reconfigure` 观察 `Kconfig` 新项可见、`EMBED_TXTFILES` 被采集（构建输出中会出现 `panel_entities.json.S`）
10. `idf.py build` 并记录编译后 `factory` 分区的 `.bin` 体积变化，同旧版本基线对比（见 §7 风险）
11. `idf.py flash monitor`，观察串口出现 `VERIFY:panel_whitelist:parsed:PASS n=7`（以样例为准）
12. 如需回归 HA 真实连接路径（plan 5 已完成时），观察 `panel_data_store_entity_count` 与 whitelist count 一致

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 不变；`idf.py build` 通过，无新增编译警告
- 构建产物中存在 `panel_entities.json.S`（由 `EMBED_TXTFILES` 生成）
- `nm build/*.elf | grep panel_entities_json` 能看到 `_binary_panel_entities_json_start` / `_end` / `_size` 三个符号
- JSON 文件是 UTF-8 无 BOM；CI 脚本可用 `python -m json.tool` 做预检
- `menuconfig` 能看到 `P4HOME_ENTITY_WHITELIST_EMBEDDED` 与 `P4HOME_ENTITY_WHITELIST_MAX_ENTITIES`

### 6.2 功能验证

- 默认样例 JSON 冷启动：
  - `VERIFY:panel_whitelist:parsed:PASS`
  - 串口打印 `panel whitelist: n=7`（对应样例 7 条）
  - `panel_data_store_entity_count() == 7`
  - `panel_entity_whitelist_at(0)->kind == PANEL_SENSOR_KIND_NUMERIC`、`...at(3)->kind == PANEL_SENSOR_KIND_BINARY`、`...at(5)->kind == PANEL_SENSOR_KIND_TEXT`、`...at(6)->kind == PANEL_SENSOR_KIND_TIMESTAMP`
- 容错路径（本地临时修改 JSON 触发，不入库）：
  - 把 `version` 改成 `999` → 启动后 `VERIFY:panel_whitelist:parsed:FAIL`、`n=0`、`panel_data_store_entity_count() == 0`、面板不 panic
  - 删一条 `entities[i].entity_id` → 该条被跳过并记 warn，其余条目继续注册，`VERIFY` 记 `PASS`（只要 `n > 0`）
  - 将 `kind` 写成 `"unknown"` → 该条跳过并记 warn
  - 故意制造 JSON 语法错误（漏逗号）→ `cJSON_Parse` 失败 → `VERIFY:panel_whitelist:parsed:FAIL`、`n=0`

### 6.3 回归验证

- `VERIFY:network:*`、`VERIFY:time:*`、`VERIFY:settings:ha_credentials_present`、`VERIFY:ha:*`、`VERIFY:panel_store:ready` 均不回归
- `panel_data_store_register` 被调用的次数 == JSON 有效条目数，顺序与 JSON 一致
- `app_main` 心跳循环周期不退化（本 plan 增加的启动期开销来自一次 `cJSON_Parse`，典型 <10ms）
- `idf.py size-components --archives` 中 `panel_data_store` 体积增量小于 2KiB（不含 JSON 原文本身）

### 6.4 硬件/联调验证

- 在具备 HA 的真实 AP 环境下冷启动：
  - 白名单 7 条全部 `register` 成功
  - `plan 5` 的 `ha_client` `subscribe_events + get_states` 首帧后，`panel_data_store` 中白名单条目的 `freshness` 按命中情况切换到 `FRESH`，未命中的保持 `UNKNOWN`
  - 命中率（`fresh_count / whitelist_count`）通过串口可以人工观察
- 把 `panel_entities.json` 内某一条改成真实家庭里**不存在**的 `entity_id`，冷启动：该条 `register` 成功，但长时间停留在 `UNKNOWN`，不应被误判为 `STALE`（由 `plan 6` 的陈旧策略决定，本 plan 不负责）
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-whitelist-v1.log` 作为 review 附件

## 7. 风险

- **Flash 体积**：JSON 原文以 `.rodata` 入固件，样例 7 条约 `1~1.5KiB`，若未来膨胀到 30 条可能接近 `6KiB`。当前 `factory` 分区仅剩约 `2%`，需要在 review 时量化本 plan 带来的字节数增量；如越过阈值，优先精简字段（省略默认值的键）或在构建期做 minify（`cmake` 预处理把 JSON 去空白后再嵌入）
- **cJSON 堆峰值**：`cJSON_Parse` 会按 JSON 节点数展开解析树，样例 7 条估计堆峰值 `<8KiB`；但 30 条将可能推到 `30KiB` 级别，必须保证 `panel_entity_whitelist_load` 在 Wi‑Fi / LVGL buffer 已分配**之后**执行时，系统仍有足够 heap。缓解措施：`cJSON_Delete` 必须在函数返回前调用；或改用 `cJSON_ParseWithLength` 并在解析中途就地 register（本 plan 已如此设计），解析结束立刻释放整棵树
- **JSON 手工编辑风险**：该文件由人维护（添加实体、调整分组），手改容易写出非法 JSON 或错误 `kind`。缓解：
  - pre-commit 挂 `python -m json.tool firmware/components/panel_data_store/panel_entities.json`
  - `VERIFY:panel_whitelist:parsed:FAIL` 作为最后防线，fail closed 不污染 `panel_data_store`
  - README 中列出受支持的 `kind` 枚举与必填/可选字段
- **字段长度截断**：`panel_sensor_t` 的 `entity_id[48]`、`label[32]` 等定长字段，若 HA 侧真实 `entity_id` 超过 47 字节会被截断，导致 `panel_data_store_update` 匹配不上。缓解：解析期如检测到超长，立即 `ESP_LOGE` 并跳过该条，不做“静默截断注册”
- **version 语义**：`version` 只做相等校验，不做兼容矩阵。未来 schema 演进需要一次性 bump 全部在用设备的固件；MVP 期可接受
- **启动顺序耦合**：`panel_entity_whitelist_load` 依赖 `panel_data_store_init` 已返回；若 `app_main` 调用顺序写错，`panel_data_store_register` 会返回错误并级联放大到 `FAIL`
- **Kconfig 保留位误用**：`P4HOME_ENTITY_WHITELIST_EMBEDDED=n` 分支在本 plan 中等价于“0 条实体”；需要在 help 文本与 README 明确说明该分支暂未实现，避免用户关掉默认值后陷入 dashboard 为空而不自知

## 8. 完成定义

- `firmware/components/panel_data_store/panel_entities.json` 存在，包含至少 6 条、覆盖 `numeric / binary / text / timestamp` 四种 kind
- `idf.py build` 通过，产物中可见 `_binary_panel_entities_json_start` 符号
- 冷启动串口日志出现 `VERIFY:panel_whitelist:parsed:PASS n=<N>`，且 `N > 0`
- `panel_data_store_entity_count()` 与 `panel_entity_whitelist_count()` 相等
- 人为破坏 JSON（错版本 / 语法错 / 非法 kind）后启动，`VERIFY` 如实 `FAIL`，面板不崩、后续 heartbeat 仍走
- `panel_data_store/README.md` 已更新“实体白名单”一节，涵盖 schema、字段默认值、维护流程
- 所有现有 `VERIFY:` 标记不回归
- 新增的 `P4HOME_ENTITY_WHITELIST_EMBEDDED` / `_MAX_ENTITIES` 两项 Kconfig 可在 `menuconfig` 见到并有合理默认

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

（待实现后补充）
