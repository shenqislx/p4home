# ha-client-reconnect-and-diagnostics Plan

所属 Milestone: M5 (contributing to M8)

## 1. 背景

根据 [project-milestones.md](../project-milestones.md) 的最新主线，`M4` 已经打通“Wi‑Fi → SNTP → HA WebSocket 鉴权 → 初始 state 加载 → panel_data_store”这条只读链路；`M5` 则在其上叠加仪表盘 UI。但连接层在 `plan 4` / `plan 5` 的 MVP 形态下仍有两个明显缺口：

- 重连策略只是占位：`HA_CLIENT_STATE_ERROR` 分支目前依赖上层“早点死早点重启”或简单的 while-sleep，没有分类错误、没有退避上限、没有抖动，也没有“连续稳定多久才能重置退避”的收敛语义。家用网络里 AP 重启 / HA 重启 / 路由 NAT flush 都会触发这个路径，风险很高。
- 观测性几乎为零：`diagnostics_service` 目前输出 `boot_banner / chip_summary / partition_summary / memory_summary / runtime_heartbeat`（见 `firmware/components/diagnostics_service/diagnostics_service.c`），对 HA 链路“连上多久了、重连了几次、最后一次错在哪、事件速率多少”这些量完全没有落地。`M8` 的“日志与诊断增强（HA 连接统计、实体数、事件速率、stale 比例）”也直接依赖这一层。

本 plan 是 plan wave 的第 10 号，定位在 `M5` 的 operational hardening 象限，同时是 `M8` 产品化阶段的先行交付：在不改动 `plan 4` 握手语义、不改动 `plan 5` 订阅语义的前提下，把 `ha_client` 的生命周期与指标暴露做到工业可用水平，并让 `diagnostics_service` 具备按心跳输出 HA 摘要的能力，供串口 / CI / 上层 UI（`plan 8` / `plan 9`）统一消费。

## 2. 目标

- 在 `firmware/components/ha_client/` 中补齐“分类错误 + 指数退避 + 抖动 + 稳定收敛”的重连主循环，区分 transient 与 fatal 两类故障，且 fatal（`auth_invalid`）必须进入长睡状态并要求显式重启。
- 新增显式的 `esp_err_t ha_client_restart(void);` API，用于凭证更新后或 fatal 错误后重新拉起链路，内部会重新从 `settings_service_ha_*` 读配置。
- 引入内部 `ha_client_reconnect_policy_t` 配置结构，Kconfig 驱动，MVP 期不暴露 public setter。
- 对外新增 metrics 结构 `ha_client_metrics_t` 与 `void ha_client_get_metrics(ha_client_metrics_t *out);`，覆盖连接时长、重连计数、最后错误、事件速率、初始快照年龄、最后一次状态变化时间戳。
- 在 `firmware/components/diagnostics_service/` 中新增 `diagnostics_service_log_ha_summary(void);`，随 `runtime_heartbeat` 每 10s 打印一行 key=value 的汇总行，便于 grep、串口巡检、CI 匹配。
- 扩展启动期 `VERIFY:` 基线：`VERIFY:ha:reconnect_ready` / `VERIFY:ha:metrics_exported`。
- 不回归 `plan 4` / `plan 5` 的握手与订阅语义。

## 3. 范围

包含：

- `firmware/components/ha_client/` 扩展：
  - 新增内部重连调度器 `ha_client_reconnect_scheduler`（与握手状态机共存，不替换）。
  - 错误分类：transient（TCP reset、DNS 失败、TLS handshake 错、WebSocket sub-protocol 错、服务端关闭、`get_states` 超时、握手阶段非 `auth_invalid`）/ fatal（收到 `auth_invalid`）。
  - 指数退避 `1s → 60s`，每次 ±20% 抖动；当 `READY` 持续 `≥ CONFIG_P4HOME_HA_SETTLE_MS`（默认 60s）之后把退避窗口重置回 `MIN_MS`。
  - Fatal：进入 `HA_CLIENT_STATE_ERROR`，`last_error_text = "auth_invalid"`，不再自动重试，等待 `ha_client_restart()`。
  - 新增 `esp_err_t ha_client_restart(void);`：先 `ha_client_stop()`、再清空 metrics 里的 `last_error_*`、再 `ha_client_start()`，内部重新走 `settings_service_ha_*`。
  - 新增只读 metrics：`ha_client_metrics_t`、`ha_client_get_metrics(out)`。
  - 启动期 `VERIFY:ha:reconnect_ready`（调度器已起）、`VERIFY:ha:metrics_exported`（`get_metrics` 返回合法）。
- `firmware/components/diagnostics_service/` 扩展：
  - 新增 `diagnostics_service_log_ha_summary(void);`，单行 `ESP_LOGI` key=value。
  - 由 `app_main` heartbeat 循环在调用 `diagnostics_service_log_runtime_heartbeat` 的同一节拍内调用（受 `CONFIG_P4HOME_HA_METRICS_HEARTBEAT` 控制）。
- 新增 Kconfig 键：`CONFIG_P4HOME_HA_RECONNECT_MIN_MS` / `_MAX_MS` / `_JITTER_PCT` / `_SETTLE_MS` / `CONFIG_P4HOME_HA_METRICS_HEARTBEAT`。
- 新增/更新 `ha_client` / `diagnostics_service` 的 `README.md` 段落与职责描述。
- `board_support` 透传一个只读 `board_support_ha_metrics_snapshot(...)`（可选，若 UI banner 直接用 `ha_client_get_metrics` 可以不做）。

不包含：

- WebSocket / TLS / JSON 握手本身（归 `plan 4`）。
- `subscribe_events` / `get_states` 语义与回调线程模型（归 `plan 5`）。
- UI 侧的连接状态条与离线展示（归 `plan 9` / `plan 8`）。
- NVS 凭证运行时编辑 UI（归 `M8` 配置页）。
- 公共 API 级别的重连策略热更新接口（MVP 期 Kconfig，只读；运行时调参留给 `M8`）。
- 事件速率的 EWMA 长时窗、分位统计；本 plan 只做 1 分钟滑窗的 `events_per_minute`。
- 历史曲线 / metrics 持久化（不写 NVS、不写分区）。

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ha_client/`
  - `ha_client.c`：新增重连调度器、metrics 采样点、`ha_client_restart` 入口。
  - `include/ha_client.h`：追加 `ha_client_metrics_t`、`ha_client_get_metrics`、`ha_client_restart`。
  - `private_include/ha_client_internal.h`（若 `plan 4` 未建，本 plan 顺手建）：放 `ha_client_reconnect_policy_t` 与内部钩子。
  - `Kconfig.projbuild`：追加 `P4HOME_HA_RECONNECT_MIN_MS` / `_MAX_MS` / `_JITTER_PCT` / `_SETTLE_MS` / `P4HOME_HA_METRICS_HEARTBEAT`，与 `plan 4` 已有的 `P4HOME_HA_*` 并列在同一 menu。
  - `CMakeLists.txt`：`REQUIRES` 视情况追加 `esp_timer`（已有）、`esp_random`（用于抖动）。
  - `README.md`：新增“重连策略 / 观测指标”段落。
- `firmware/components/diagnostics_service/`
  - `diagnostics_service.c`：新增 `diagnostics_service_log_ha_summary`。
  - `include/diagnostics_service.h`：追加声明。
  - `CMakeLists.txt`：`REQUIRES` 追加 `ha_client`（单向依赖：`diagnostics_service → ha_client`，避免环）。
- `firmware/components/board_support/`
  - （可选）`board_support.c` / `include/board_support.h`：若决定让 `app_main` 不直接 include `ha_client.h`，可透传一层。
- `firmware/main/app_main.c`
  - heartbeat 循环中新增 `diagnostics_service_log_ha_summary()` 调用，受 `CONFIG_P4HOME_HA_METRICS_HEARTBEAT` 控制。
  - 启动 `VERIFY:` 序列追加 `ha:reconnect_ready` / `ha:metrics_exported`。
- 不新建组件、不动分区、不改 `dependencies.lock`。

### 4.2 模块拆解

`ha_client` 内部在本 plan 引入三个协作单元（仍位于同一组件，避免拆库增加体积）：

1. **Reconnect Scheduler（新）**
   - 自己一根 `TaskHandle_t`（或复用 `plan 4` 的 `ha_client` 工作任务，用 FSM 化入口），循环读当前 `ha_client_state_t`。
   - 维护 `current_backoff_ms`、`last_ready_at_ms`、`last_fatal`。
   - 触发 `ha_client_start_internal()` / `ha_client_stop_internal()`，不直接触碰 WebSocket 细节。
2. **Error Classifier（新）**
   - 输入：`plan 4` 上报的 `last_error_code`（`esp_websocket_client` err）+ `last_error_text`（JSON 层面的 `message.type`）。
   - 输出：`HA_CLIENT_FAULT_TRANSIENT` / `HA_CLIENT_FAULT_FATAL`。
   - 判定规则（内部 enum，不公开）：
     - `auth_invalid`（JSON `{"type":"auth_invalid"}`）→ fatal。
     - 除此以外全部 transient（含 TLS 证书错、DNS 失败、`auth_required` 超时、`get_states` 超时、`close_frame` 非 1000 等）。
     - 预留 hook：未来可加入“TLS 证书永久无效”之类走 fatal。
3. **Metrics Collector（新）**
   - 字段：见 §4.4。
   - 写入点：
     - 进入 `READY`：`last_state_change_ms = now_ms`；若 `connected_since_ms == 0` 则设置为 now。
     - 离开 `READY`：累加 `connected_duration_ms += now - connected_since_ms`，`connected_since_ms = 0`。
     - `reconnect_count`：每次从非 `CONNECTING` 过渡到 `CONNECTING` 时 `+1`（首次启动不计入，`reconnect_count` 表示“重”连次数）。
     - `events_per_minute`：1 分钟滑窗，基于 `plan 5` 回调里调用的 `ha_client_metrics_note_event()` 内部 hook；窗口用两个 30s 桶近似滑动平均，MVP 期不做精确 EWMA。
     - `initial_state_age_ms`：`plan 5` 在 `initial_states_loaded` 时记一次 `initial_states_loaded_ms`；`get_metrics` 时用 `now - initial_states_loaded_ms`；未加载则 `UINT32_MAX`。
     - `last_error_code` / `last_error_text[48]`：错误分类器写入；`ha_client_restart` 清空为 0 / ""。
   - 访问：`portMUX_TYPE` 或 `SemaphoreHandle_t`（与 `plan 4` 现有锁复用），`ha_client_get_metrics` 做拷贝返回。

`diagnostics_service` 侧：

- `diagnostics_service_log_ha_summary` 只做一次 `ha_client_get_metrics(&m)` 然后一行 `ESP_LOGI(TAG, "ha_summary state=%s connected_ms=%u reconnect=%u errcode=%d errtext=\"%s\" epm=%u init_age_ms=%u last_change_ms=%lld", ...);`。
- 沿用 `diagnostics` 的 `TAG="diagnostics"`，与现有 `boot_banner` / `heartbeat` 保持同一 tag，便于串口 / CI 一起 grep。
- 依赖方向单向：`diagnostics_service → ha_client`，`ha_client` 不 include `diagnostics_service.h`。

Kconfig（对齐 `plan 1` 写法，统一放在 `Kconfig.projbuild`）：

- `P4HOME_HA_RECONNECT_MIN_MS`：int，默认 `1000`。
- `P4HOME_HA_RECONNECT_MAX_MS`：int，默认 `60000`。
- `P4HOME_HA_RECONNECT_JITTER_PCT`：int `0..50`，默认 `20`。
- `P4HOME_HA_SETTLE_MS`：int，默认 `60000`。
- `P4HOME_HA_METRICS_HEARTBEAT`：bool，默认 `y`。

### 4.3 数据流 / 控制流

**重连状态转移（文字版，替代 DOT 图）**：

- 基态是 `plan 4` 已定义的五态枚举：`IDLE → CONNECTING → AUTHENTICATING → READY → ERROR`。本 plan **不扩枚举**，而是在 `ERROR` 之外维护一个调度器内部的辅助状态 `BACKOFF_WAIT`（实现为任务里的 `vTaskDelay(current_backoff_ms)`）。
- **冷启动**：`app_main` 调 `ha_client_init` → `ha_client_start`。状态 `IDLE → CONNECTING → AUTHENTICATING → READY`；此时调度器记录 `connected_since_ms`，`current_backoff_ms` 保持为 `MIN_MS`（未启用）。
- **Transient 故障**：`plan 4` 握手失败或 `plan 5` WebSocket 掉线，状态机落到 `ERROR`。调度器：
  1. 错误分类器判定为 `TRANSIENT`；
  2. 若进入 `ERROR` 前 `READY` 已维持 `≥ SETTLE_MS`：把 `current_backoff_ms` 重置为 `MIN_MS`；
  3. 从 `current_backoff_ms` 出发加 ±`JITTER_PCT`% 抖动（`esp_random()` 取模，公式 `delay = current * (1 + rand_sign * rand_frac)`）；
  4. 切到 `BACKOFF_WAIT` 并 `vTaskDelay(delay)`；
  5. `reconnect_count += 1`；
  6. 驱动状态机重入 `CONNECTING`；
  7. 若再次失败：`current_backoff_ms = min(current * 2, MAX_MS)`，回到 (3)。
- **Fatal 故障**：分类器判定为 `FATAL`（即收到 `auth_invalid`）。调度器：
  1. 把 `last_error_text` 强制写成 `"auth_invalid"`（即便上层传了更长的错误文本），`last_error_code` 保留；
  2. 状态停留在 `ERROR`，**不**再调度重连；
  3. `connected_since_ms` 归零，`connected_duration_ms` 不再增长；
  4. 直到 `ha_client_restart()` 被显式调用：清 `last_error_*`、走完整 `ha_client_stop → ha_client_start`、`current_backoff_ms` 重置为 `MIN_MS`，`reconnect_count` **不清零**（这是累计量）。
- **稳定收敛**：`READY` 维持 `≥ SETTLE_MS` 后，下次进入 transient 故障时才会重置退避窗口；如果 `READY` 只维持了 30s 就掉线，退避窗口继续按 (7) 乘 2。这是本 plan 重点，防止“flappy 链路”退避被反复重置。
- **时间戳口径**：全用 `esp_timer_get_time() / 1000` 转成 `int64_t` ms；`reconnect_count` / `initial_state_age_ms` / `events_per_minute` / `connected_duration_ms` 全部 `uint32_t`（溢出风险见 §7）。

**heartbeat 数据流**：

- `app_main` 的 `while(1)` heartbeat 周期 10s 内：
  1. `diagnostics_service_log_runtime_heartbeat()`（现有）。
  2. 若 `CONFIG_P4HOME_HA_METRICS_HEARTBEAT=y`：`diagnostics_service_log_ha_summary()`。
- `diagnostics_service_log_ha_summary` 自己调 `ha_client_get_metrics(&m)`，不接收 metrics 参数，以避免 `app_main` 携带 `ha_client` 头。
- 输出格式（单行，便于 grep）：
  - `ha_summary state=<text> connected_ms=<u32> reconnect=<u32> errcode=<i32> errtext="<str48>" epm=<u32> init_age_ms=<u32> last_change_ms=<i64>`
  - `state` 使用 `ha_client_state_text`（`plan 4` 已有）。
  - `errtext` 走 `%.48s` 截断，已由结构体保证 NUL 终止。

### 4.4 Metrics 结构与 API

对外头文件追加：

```c
typedef struct {
    ha_client_state_t state;
    uint32_t connected_duration_ms;
    uint32_t reconnect_count;
    uint32_t last_error_code;
    char     last_error_text[48];
    uint32_t events_per_minute;
    uint32_t initial_state_age_ms;
    int64_t  last_state_change_ms;
} ha_client_metrics_t;

void      ha_client_get_metrics(ha_client_metrics_t *out);
esp_err_t ha_client_restart(void);
```

字段语义：

- `state`：`ha_client_get_state()` 的瞬时快照。
- `connected_duration_ms`：累计处于 `READY` 的毫秒数（不含 `CONNECTING` / `AUTHENTICATING`）。
- `reconnect_count`：从 `HA_CLIENT_STATE_ERROR` 或其它非 `CONNECTING` 状态重新进入 `CONNECTING` 的次数；首次启动不计入。
- `last_error_code`：最后一次故障时 `plan 4` 暴露的错误码（通常是 `esp_websocket_client` 的 `esp_err_t` 或自定义负值）。
- `last_error_text`：最后一次故障的可读文本，fatal 时强制为 `"auth_invalid"`，否则取 `ha_client_last_error_text()`。
- `events_per_minute`：最近 1 分钟内 `plan 5` 回调触发的 `state_changed` 条数（滑窗近似）。
- `initial_state_age_ms`：当前时刻距离 `initial_states_loaded` 事件的毫秒数，未加载前返回 `UINT32_MAX`。
- `last_state_change_ms`：最近一次状态机跳转的 `esp_timer_get_time()/1000`，供上层判断“有没有在抖”。

内部策略结构（不公开）：

```c
typedef struct {
    uint32_t min_ms;
    uint32_t max_ms;
    uint32_t jitter_pct;
    uint32_t settle_threshold_ms;
} ha_client_reconnect_policy_t;
```

初始化时从 Kconfig 填入；未来可演进为 `ha_client_set_reconnect_policy(...)`，当前 plan 不提供 setter。

### 4.5 VERIFY 与启动期

- `VERIFY:ha:reconnect_ready:PASS|FAIL`：调度器任务成功创建、初始 policy 合法（`min_ms <= max_ms && jitter_pct <= 50`）。
- `VERIFY:ha:metrics_exported:PASS|FAIL`：`ha_client_get_metrics(&m)` 返回且 `m.state` 在枚举合法区间内；`plan 4` 的 `ws_connected/authenticated` 仍由 `plan 4` 负责。
- `VERIFY` 应在 `ha_client_start` 之后、第一次等待之前打印，以便即使握手超时也能输出“重连调度与指标导出本身 OK”。

## 5. 实现任务

agent 侧（实现阶段由后续 agent 执行）：

1. 扩展 `firmware/components/ha_client/include/ha_client.h`：追加 `ha_client_metrics_t`、`ha_client_get_metrics`、`ha_client_restart`。
2. 新增 `firmware/components/ha_client/private_include/ha_client_internal.h`（若 `plan 4` 未建则新建），放 `ha_client_reconnect_policy_t` 与错误分类枚举。
3. 实现 `ha_client_reconnect_scheduler`：独立 task 或复用工作 task，按 §4.3 的状态转移逻辑推动；抖动采用 `esp_random()` 计算 ±jitter_pct% 偏移。
4. 实现错误分类：在 `plan 4` 的错误落点前插入 hook，fatal 时锁定 `last_error_text="auth_invalid"`。
5. 实现 `ha_client_restart`：`stop → clear last_error_* → reset current_backoff_ms → start`，`reconnect_count` 不清零，`connected_duration_ms` 不清零（累计量）。
6. 实现 metrics collector：在状态迁移钩子、`plan 5` 的 state_changed 回调入口、`initial_states_loaded` 事件处加采样；`events_per_minute` 用双 30s 桶。
7. 扩展 `firmware/components/ha_client/Kconfig.projbuild`，新增 5 个 Kconfig。
8. 在 `firmware/components/diagnostics_service/include/diagnostics_service.h` 追加 `diagnostics_service_log_ha_summary`。
9. 在 `firmware/components/diagnostics_service/diagnostics_service.c` 实现该函数，`TAG="diagnostics"`，一行 `ESP_LOGI` key=value；包含 `ha_client.h`，`CMakeLists.txt` 的 `REQUIRES` 追加 `ha_client`。
10. 在 `firmware/main/app_main.c` heartbeat 循环内加入 `#if CONFIG_P4HOME_HA_METRICS_HEARTBEAT` 包裹的 `diagnostics_service_log_ha_summary();`，并追加 `VERIFY:ha:reconnect_ready / metrics_exported` 两行。
11. 更新 `firmware/components/ha_client/README.md` 与 `firmware/components/diagnostics_service/README.md`。
12. （可选）在 `firmware/components/board_support/` 透传一层 `board_support_ha_metrics_snapshot`，为 `plan 9` banner 预留。

本地硬件侧（用户侧执行，agent 不登机）：

13. `idf.py reconfigure` 后 `idf.py menuconfig` 确认 5 个新 Kconfig 可见、默认值正确。
14. `idf.py build` 成功；对比前后 `factory` 分区占用增量（关注 §7 体积风险）。
15. 实机烧录后在串口观察至少 10 分钟，确认 `ha_summary` 日志每 10s 出现一次，且字段不串行。
16. 人为触发 transient：`iptables` 层断开 HA / 重启 HA 容器，验证退避按 `1, 2, 4, 8, 16, 32, 60, 60, ...` 秒级数列在 ±20% 抖动下进入 `CONNECTING → READY`，`reconnect_count` 正确自增；`READY` 维持 ≥60s 后再次断开，验证退避回到 `1s` 基线。
17. 人为触发 fatal：把 `settings_service_ha_set_token("invalid")` 塞错 token，确认进入 `ERROR` 且不再重试；调用 `ha_client_restart()`（通过 settings 页或临时命令）后恢复。
18. 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ha-reconnect-v1.log`，作为 review 附件。

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 不变；`idf.py build` 通过。
- `idf.py reconfigure` 后 5 个新 Kconfig 出现在 `sdkconfig` 与 `menuconfig`。
- `CONFIG_P4HOME_HA_METRICS_HEARTBEAT=n` 情况下也能 build，且 heartbeat 行为不变（回归基线）。
- `diagnostics_service` 的 `CMakeLists.txt` 追加 `ha_client` 后组件图仍无环（`idf.py build` 不报循环依赖）。
- 对比 `factory` 分区大小增量，应 `< 8KB`（纯 C、少量字符串、一个定时器 task）。

### 6.2 功能验证

- 正常路径：冷启动 30s 内进入 `READY`，`ha_summary state=ready reconnect=0 epm=<N>` 可见。
- Transient 路径：
  - 断 HA 服务端 5 次，每次间隔 5s；观察 `current_backoff_ms` 序列约为 `1000, 2000, 4000, 8000, 16000` (各 ±20%)；`reconnect_count` 从 0 递增到 5。
  - 恢复后维持 `READY` ≥ 60s，再次断 HA：观察退避重置为 ≈ `1000ms`。
  - 快速抖动（每 10s 断一次）：退避不应被重置，`current_backoff_ms` 应稳步上升到 `60000` 并在该上限附近带抖动。
- Fatal 路径：
  - 用错误 token 启动：`state=error errtext="auth_invalid"`，`reconnect_count` 不再增长，`connected_duration_ms` 不动。
  - 调用 `ha_client_restart()` 并换回正确 token：再次进入 `READY`，`reconnect_count` 保留历史值。
- Metrics：
  - `ha_client_get_metrics(&m)` 在任意状态都能返回，不阻塞。
  - `events_per_minute` 在 HA 侧连续推送后 1 分钟内收敛到一个合理值（例如 whitelist 8 个实体、整体 1Hz 更新时约为 480）。
  - `initial_state_age_ms` 在 `initial_states_loaded` 之前为 `UINT32_MAX`，之后单调递增。
- VERIFY：冷启动日志出现 `VERIFY:ha:reconnect_ready:PASS` 与 `VERIFY:ha:metrics_exported:PASS`。

### 6.3 回归验证

- `plan 1` 的 `VERIFY:network:*` 全部 `PASS`。
- `plan 4` 的 `VERIFY:ha:ws_connected|authenticated` 不回归。
- `plan 5` 的 `VERIFY:ha:subscribed|initial_states_loaded` 不回归；`panel_data_store` 的 entity_count 与历史基线一致。
- `diagnostics` 现有的 `heartbeat / chip_summary / partition_summary / memory_summary` 输出格式不变；只是新增一行 `ha_summary`。
- heartbeat 节拍抖动 `< 100ms`，不因 `ha_client_get_metrics` 的锁等待而拉长。

### 6.4 硬件/联调验证

- 使用两块 `ESP32-P4 EV Board` 面板同时接同一 HA：验证抖动是否让两面板的 reconnect 时刻错开（jitter fairness，详见 §7）。
- 在家用 AP 上人为 reboot 路由器：观察面板在 Wi‑Fi 回来后自动进入 HA 重连路径（依赖 `plan 1` 的 Wi‑Fi 重连），`reconnect_count` 正确递增且稳定收敛。
- 长跑 2 小时，`heartbeat` 节拍稳定，`ha_summary` 每 10s 一行、无丢行、无乱码；`heap` 无明显增长。
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ha-reconnect-v1.log` 供 review。

## 7. 风险

- **抖动公平性（多面板）**：家庭场景常见同批采购多面板，同一 AP/HA 一起断。若抖动系数过小或伪随机种子相同，多块面板会同步重连击打 HA，反而放大雪崩。`esp_random()` 在硬件 RNG 就绪前可能退化为伪随机；MVP 期接受 ±20% 抖动并依赖设备各自的 MAC 尾字节做种子兜底，后续若引入 MQTT/HA 网关聚合需重新评估。
- **日志风暴**：storm 场景下（AP flap / HA 频繁重启）状态机在 10s 内可能发生多次迁移，若每次迁移都 `ESP_LOGI`，串口会淹没。本 plan 把周期性输出集中在 10s heartbeat 的 `ha_summary` 单行里，状态机内部迁移仅用 `ESP_LOGD`，避免 storm 放大；review 时需验证这一边界是否被遵守。
- **32-bit 计数器溢出**：`reconnect_count`、`connected_duration_ms`、`events_per_minute`、`initial_state_age_ms` 均为 `uint32_t`。
  - `connected_duration_ms` 达 `UINT32_MAX ≈ 49.7` 天即环绕；家用面板长期在线时会遇到，消费方（`diagnostics` / UI / `plan 9`）需以“可环绕无符号量”对待，必要时在 `M8` 升到 `uint64_t`。
  - `reconnect_count` 在正常网络下一周也难超 1000；只有极端故障会接近阈值，本 plan 接受环绕而不做溢出告警。
  - `initial_state_age_ms` 超过 49.7 天时会环绕，UI 展示应显式封顶为 `>49d`。
- **策略改动需固件更新**：MVP 期 `ha_client_reconnect_policy_t` 只由 Kconfig 驱动，没有运行时 setter、不进 NVS。调参（如把 `MAX_MS` 改成 120s、或 `JITTER_PCT` 改成 10）必须走固件升级；如果现场发现参数不合适，短期内只能靠 OTA（`M8`）。本 plan 明确把公共 setter 挡在范围外，是刻意的取舍，避免过早暴露私有结构。
- **固件体积**：`factory` 分区仅剩约 2%。调度器 + metrics + 新增日志字符串估算 `< 8KB`，但需在 §6.1 的构建对比里盯住；若超 8KB 则先做字符串表压缩（错误文本枚举化）再评估。
- **错误分类漂移**：HA 未来版本可能在 `auth_invalid` 之外新增同族 fatal（如假想的 `auth_required_v2`）；错误分类器写成白名单 fatal、其余 transient，一旦 HA 引入新 fatal，面板会陷入快速无效重连循环。需在 `plan 4` / `plan 5` 的 review 跟进里关注 HA 协议文档。
- **回调线程混用**：`plan 5` 已约定回调跑在 `ha_client` 内部任务；本 plan 的 metrics 写入点也在同任务，不引入新锁。但若未来 `plan 5` 的回调被迁到 LVGL 线程，`events_per_minute` 的桶需要加锁，届时要重新评估。
- **`ha_client_restart` 被滥用**：如果上层（例如 `plan 9` banner 的“重试”按钮）看到 ERROR 就调 `ha_client_restart`，可能把 fatal 当 transient 用，掩盖真正的凭证错误。README 需明确 `restart` 只建议在“用户确认修改凭证后”或“长按诊断按钮”等显式触发点调用。

## 8. 完成定义

- `firmware/components/ha_client/include/ha_client.h` 暴露 `ha_client_metrics_t`、`ha_client_get_metrics`、`ha_client_restart`，且类型布局与本 plan §4.4 一致。
- `firmware/components/ha_client/` 内部具备基于 Kconfig 的 `ha_client_reconnect_policy_t`，transient 路径按 `1s → 60s ±20%` 执行，`SETTLE_MS` 生效，fatal 路径不自动重试。
- `firmware/components/diagnostics_service/` 暴露 `diagnostics_service_log_ha_summary`，`app_main` heartbeat 循环按 `CONFIG_P4HOME_HA_METRICS_HEARTBEAT` 调用。
- 启动日志出现 `VERIFY:ha:reconnect_ready:PASS`、`VERIFY:ha:metrics_exported:PASS`；`plan 1/4/5` 既有 VERIFY 不回归。
- 实测：transient 故障 5 次后稳定回到 `READY`；`SETTLE_MS` 后退避重置到 `MIN_MS`；fatal 故障不再自动重试，`ha_client_restart` 能恢复。
- 2 小时长跑：`ha_summary` 每 10s 一行、`heap` 无持续增长、串口无丢行。
- README（`ha_client` / `diagnostics_service`）记录新能力与边界（`restart` 使用建议、Kconfig 键位、metrics 字段语义）。

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
