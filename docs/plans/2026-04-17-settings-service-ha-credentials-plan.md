# settings-service-ha-credentials Plan

所属 Milestone: `M4`

## 1. 背景

按 [project-milestones.md](../project-milestones.md) 的最新定版，`p4home` 主线已切换为 “连接 `Home Assistant`，以图形化方式展示家庭传感器数据”。`M4` 的读侧链路依赖三类运行时配置：

- `HA WebSocket URL`（例如 `ws://homeassistant.local:8123/api/websocket` 或 `wss://...`)
- `HA Long-Lived Access Token`（下简称 `HA token`，属敏感信息）
- 是否对 TLS 证书做校验 `verify_tls`

当前 `firmware/components/settings_service/` 只实现了：

- 单一 NVS namespace `p4home`
- `boot_count`（自增计数）
- `startup_page`（UI 首页枚举）
- `settings_service_init` / `_is_ready` / `_boot_count` / `_startup_page*` / `_set_startup_page` / `_get_snapshot` / `_log_summary`

它**没有**任何 HA 凭证字段，也没有独立的 NVS namespace 来承载 HA 相关配置。`ha_client`（plan 4）启动时必须能同步拿到 `url` / `token` / `verify_tls`，否则拨号无从谈起；同时为避免把敏感 token 固化进源码或 `sdkconfig.defaults`，需要以 NVS 为运行时权威来源，`Kconfig` 只作为“首刷种子”。

本 plan 为 `M4` 的 plan 3，**无上游依赖**，可与 plan 1（`network_service` Wi‑Fi）、plan 2（`time_service`）并行推进，是 plan 4（`ha-client-websocket-bootstrap`）的硬前置。

## 2. 目标

- 在现有 `settings_service` 内增设 HA 凭证子域，使用独立 NVS namespace `p4home_ha` 承载 `url` / `token` / `verify_tls`，不污染既有 `p4home` namespace 语义
- 对外暴露一组稳定的 get/set API 与 `credentials_present` 判定，供 `ha_client` 在启动与重连时使用
- 提供 `Kconfig` 种子值与“首刷/缺省补齐”机制，使 MVP 期在未提供现场 provisioning UI 时也能以最少 `menuconfig` 步骤跑通
- 日志里 token 强制脱敏（`***<last4>`），禁止明文 token 出现在串口输出
- 新增 `VERIFY:settings:ha_credentials_present` 启动自检，供 CI/人工快速判断本板是否已具备 HA 连接前置条件
- 保持既有 `boot_count` / `startup_page` 行为与 `p4home` namespace 语义不回归

## 3. 范围

包含：

- 在 `firmware/components/settings_service/` 内扩展实现与头文件，新增 HA 凭证子域
- 新 NVS namespace `p4home_ha`，键：`url`、`token`、`verify_tls`
- 新 `Kconfig.projbuild` 中增加种子与行为开关：`CONFIG_P4HOME_HA_URL` / `CONFIG_P4HOME_HA_TOKEN` / `CONFIG_P4HOME_HA_VERIFY_TLS` / `CONFIG_P4HOME_HA_SEED_NVS_ON_BOOT`
- 对外 API：
  - `esp_err_t settings_service_ha_get_url(char *buf, size_t size);`
  - `esp_err_t settings_service_ha_get_token(char *buf, size_t size);`
  - `bool     settings_service_ha_verify_tls(void);`
  - `bool     settings_service_ha_credentials_present(void);`
  - `esp_err_t settings_service_ha_set_url(const char *url);`
  - `esp_err_t settings_service_ha_set_token(const char *token);`
  - `esp_err_t settings_service_ha_set_verify_tls(bool verify_tls);`
  - `void     settings_service_ha_log_summary(void);`
- Token 日志脱敏工具（内部函数），仅暴露最后 4 个字符，如 `***abcd`；长度不足 4 时全部以 `*` 输出
- 启动期种子策略：
  - 条件：`CONFIG_P4HOME_HA_SEED_NVS_ON_BOOT=y` 且 `Kconfig` 给出的种子非空
  - 动作：若 NVS 对应键缺失、或值与 Kconfig 不同，则写入 NVS；否则 **保持 NVS 为权威**
  - 空种子永远不会清空 NVS 现有值
- 新增启动 `VERIFY:settings:ha_credentials_present:PASS|FAIL`
- 扩展 `settings_service_snapshot_t`（或通过 `settings_service_ha_log_summary` 旁路）暴露 HA 子域状态；本 plan 选择 **不改动** `settings_service_snapshot_t` 结构以避免波及下游，所有 HA 字段通过独立 API 读取

不包含：

- 任何用于编辑 `url` / `token` / `verify_tls` 的 UI 页面或交互（归 `M8` 产品化打磨，或独立 provisioning plan）
- 任何 secure element / 加密存储 / NVS 加密分区改造（本 plan 明确用明文 NVS + 日志脱敏，足够覆盖 MVP；加固归 `M8`）
- HA WebSocket 协议握手与鉴权逻辑（归 plan 4 `ha-client-websocket-bootstrap`）
- `esp_websocket_client` 依赖引入或任何 WS/TLS 客户端行为（归 plan 4）
- `entity whitelist` JSON（归 plan 7 `panel-entity-whitelist-config`）
- Wi‑Fi 凭证的 NVS 化（归后续独立 plan，不在本 plan 内合并）

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/settings_service/`
  - `settings_service.c`：追加 HA 子域实现（同文件，不拆分 `.c`，避免组件粒度膨胀）
  - `include/settings_service.h`：追加 HA 相关 API 原型与常量（`P4HOME_HA_URL_MAX_LEN`、`P4HOME_HA_TOKEN_MAX_LEN`）
  - `Kconfig.projbuild`：**新增**（当前组件无该文件），声明 `P4HOME_HA_URL` / `_TOKEN` / `_VERIFY_TLS` / `_SEED_NVS_ON_BOOT`
  - `CMakeLists.txt`：保持现有 `REQUIRES`，仅确认 `nvs_flash` 在列
  - `README.md`：**新增或更新**，补充 HA 子域说明与脱敏约定
- `firmware/components/board_support/`
  - `board_support.c` / `include/board_support.h`：在启动摘要中新增一行 HA 凭证摘要（仅脱敏打印）；不强制新增 getter 透传（下游 `ha_client` 可直接调 `settings_service_ha_*`）
- `firmware/main/app_main.c`：在 `VERIFY:` 阶段追加 `settings:ha_credentials_present`
- 不新建分区、不修改 `firmware/partitions.csv`
- 不改动 `firmware/sdkconfig.defaults`（所有新增 Kconfig 的默认值写在 `Kconfig.projbuild` 内）

### 4.2 模块拆解

本 plan 在 `settings_service.c` 内划出四块职责，仍保持单文件：

- **NVS 访问封装**：新增内部 helper 处理 `p4home_ha` namespace 打开/关闭/读写字符串与布尔值，与既有 `SETTINGS_NAMESPACE = "p4home"` 路径并行但互不干扰
- **内存缓存层**：用一个内部结构 `settings_service_ha_cache_t` 在 RAM 中保存最近一次读出的 `url`、`token`、`verify_tls` 与 `present` 标志；`init` 阶段执行一次 NVS → cache 同步，`set_*` 时先写 NVS 后刷新 cache，`get_*` 直接从 cache 拷贝，避免频繁访问 flash
- **种子/差量合并**：`settings_service_init` 末尾调用新的静态函数 `settings_service_ha_seed_from_kconfig(void)`，根据 `CONFIG_P4HOME_HA_SEED_NVS_ON_BOOT` 决定是否把 Kconfig 值合入 NVS；具体策略见 §4.3
- **脱敏输出**：内部函数 `settings_service_ha_format_token_masked(char *buf, size_t size, const char *token)`，生成 `***<last4>` 或全 `*` 字符串；`log_summary` 与 `board_support` 摘要统一走这个入口

常量（头文件）：

- `#define P4HOME_HA_URL_MAX_LEN    256`
- `#define P4HOME_HA_TOKEN_MAX_LEN  384`（HA LLAT 基本稳定在 180~220 字节，留冗余）

所有 get_* API 采用“调用方提供 buffer”的风格，与既有 `settings_service_get_snapshot` 的值语义相容，避免返回内部指针被误持有。

线程安全：`settings_service` 当前无并发保护，调用点仅 `app_main` 与后续 `ha_client`（启动期单线程读，运行期 set 极少），本 plan 在 `settings_service.c` 内新增一个 `portMUX_TYPE s_ha_spinlock`，包裹 cache 读/写；NVS I/O 本身不放进临界区，以避免长持锁。

### 4.3 数据流 / 控制流

启动期：

1. `board_support_init` → `settings_service_init`
2. `settings_service_init` 执行原有 `nvs_flash_init` / `p4home` namespace 的 boot_count 更新逻辑（不变）
3. `settings_service_init` 末尾调用 `settings_service_ha_load_from_nvs()`：
   - 打开 `p4home_ha` namespace（只读）
   - 读 `url` / `token`（`nvs_get_str`）、`verify_tls`（`nvs_get_u8`）
   - 不存在的键按默认值填入 cache（`url` = "", `token` = "", `verify_tls` = true）
4. 若 `CONFIG_P4HOME_HA_SEED_NVS_ON_BOOT=y`，继续调用 `settings_service_ha_seed_from_kconfig()`：
   - 读 `CONFIG_P4HOME_HA_URL` / `_TOKEN` / `_VERIFY_TLS`
   - 针对每个字段独立判定：
     - **空种子**（例如 `CONFIG_P4HOME_HA_URL` 为空串）：跳过，不做任何写入，避免误清空已 provisioning 的 NVS
     - **非空种子**：与 cache 中当前值对比；不相等则 `nvs_set_str` / `nvs_set_u8` + `nvs_commit`，并刷新 cache
   - `verify_tls` 由于本身是 `bool` 无“空种子”概念，策略：只有当 NVS 中无此键时才写 Kconfig 默认，之后保持 NVS 权威；否则 Kconfig 的变化不会追刷 NVS（避免运行时被不小心覆盖）
5. `settings_service_init` 返回 `ESP_OK`；HA 子域失败不向上传播成 init 失败，仅记录 `ESP_LOGW`，以免阻塞面板进入 offline 可运行路径
6. `app_main` 在现有 `VERIFY:` 阶段追加一行：
   - `PASS` 条件：`settings_service_ha_credentials_present()==true`（即 `url` 非空 且 `token` 非空）
   - `FAIL` 条件：任一为空
   - 该 VERIFY 不应 panic，下游 `ha_client` 在 FAIL 时自行进入 `ERROR` 状态等待后续 provisioning

运行期：

- `ha_client_start()` 调用 `settings_service_ha_get_url` / `_get_token` / `_verify_tls`，直接从 cache 读取，单次 `memcpy`
- 任何 `settings_service_ha_set_*` 调用：
  1. 参数校验（非 NULL / 长度上限）
  2. 取 `s_ha_spinlock`，写 cache
  3. 释放 spinlock，执行 NVS 写 + commit
  4. 写失败时打一条 `ESP_LOGW`，并把 cache 回滚到写前值，保持 NVS 与 cache 一致
- `settings_service_ha_log_summary()`：
  - 格式示例：`settings ha url=<url|empty> token=<***abcd|empty> verify_tls=<yes|no> present=<yes|no>`
  - token 恒用 `settings_service_ha_format_token_masked` 输出
  - 不打印 `Kconfig` 原值，避免 `idf.py monitor` 暴露明文
- `board_support_log_summary()` 在既有行后追加一行调用 `settings_service_ha_log_summary()`（保持日志集中在启动摘要段）

### 4.4 Kconfig 与默认值

新增 `firmware/components/settings_service/Kconfig.projbuild`：

- `P4HOME_HA_URL`：`string`，默认空（`""`）；menu 注释明确“首次写入 NVS 用，之后 NVS 为准”
- `P4HOME_HA_TOKEN`：`string`，默认空；注释强调“敏感，不要 commit 进 `sdkconfig.defaults`”
- `P4HOME_HA_VERIFY_TLS`：`bool`，默认 `y`
- `P4HOME_HA_SEED_NVS_ON_BOOT`：`bool`，默认 `y`；置为 `n` 时完全忽略上三项种子，仅依赖 NVS

`firmware/sdkconfig.defaults` **不**被本 plan 修改，避免把敏感 token 推进版本库。

### 4.5 错误码与边界

- `settings_service_ha_get_url` / `_get_token`：
  - `buf == NULL` 或 `size == 0` → `ESP_ERR_INVALID_ARG`
  - `size` 不足 → `ESP_ERR_INVALID_SIZE`（标准 NVS 行为对齐）
  - 未初始化 → `ESP_ERR_INVALID_STATE`
  - 成功 → `ESP_OK`，`buf` 保证以 `\0` 结尾；NVS 中无此键时返回 `ESP_OK` 且 `buf[0] == '\0'`
- `settings_service_ha_set_url`：
  - `url == NULL` → `ESP_ERR_INVALID_ARG`
  - `strlen(url) >= P4HOME_HA_URL_MAX_LEN` → `ESP_ERR_INVALID_SIZE`
  - NVS 写/commit 失败 → 透传原 err
  - 空字符串合法（语义为“显式清空”）
- `settings_service_ha_set_token`：同上，最大长度使用 `P4HOME_HA_TOKEN_MAX_LEN`
- `settings_service_ha_credentials_present`：`url` 与 `token` 均非空视为 present；`verify_tls` 不参与此判定
- `settings_service_ha_verify_tls`：未初始化时返回 `true`（与 Kconfig 默认一致，属最保守行为）

## 5. 实现任务

代码侧（agent 可完成）：

1. 新建 `firmware/components/settings_service/Kconfig.projbuild`，声明 `P4HOME_HA_URL` / `_TOKEN` / `_VERIFY_TLS` / `_SEED_NVS_ON_BOOT`，默认值按 §4.4
2. 在 `include/settings_service.h` 追加 HA 相关 API 原型与长度常量（`P4HOME_HA_URL_MAX_LEN` / `P4HOME_HA_TOKEN_MAX_LEN`）
3. 在 `settings_service.c`：
   - 新增 `SETTINGS_HA_NAMESPACE = "p4home_ha"`，以及 `KEY_HA_URL="url"` / `KEY_HA_TOKEN="token"` / `KEY_HA_VERIFY_TLS="verify_tls"` 常量
   - 新增内部结构 `settings_service_ha_cache_t`、静态实例、`portMUX_TYPE` 锁
   - 新增 `settings_service_ha_format_token_masked` 脱敏函数
   - 新增 `settings_service_ha_load_from_nvs`、`settings_service_ha_seed_from_kconfig` 静态函数
   - 在 `settings_service_init` 末尾按顺序调用上述两个函数，失败仅 `ESP_LOGW` 不传播
   - 实现 `settings_service_ha_get_url` / `_get_token` / `_verify_tls` / `_credentials_present`
   - 实现 `settings_service_ha_set_url` / `_set_token` / `_set_verify_tls`（写 NVS + commit + 刷新 cache）
   - 实现 `settings_service_ha_log_summary`，保证 token 走脱敏
4. 在 `firmware/components/board_support/board_support.c` 的启动摘要末尾调用 `settings_service_ha_log_summary()`
5. 在 `firmware/main/app_main.c` 的 `VERIFY:` 阶段新增 `settings:ha_credentials_present` 标记项
6. 更新或新建 `firmware/components/settings_service/README.md`：
   - 描述 `p4home` 与 `p4home_ha` 两个 namespace 的分工
   - 描述种子策略与“NVS 为权威”的约定
   - 描述 token 脱敏规则与运维建议（不要把 token 放进 `sdkconfig.defaults`）

本地硬件侧（用户在已烧录过固件的开发机上执行）：

7. `idf.py menuconfig` 打开新的 HA credentials 分区，设置 `P4HOME_HA_URL` / `_TOKEN` / `_VERIFY_TLS` / `_SEED_NVS_ON_BOOT`；**不要** save 到 `sdkconfig.defaults`
8. `idf.py build && idf.py flash monitor`，确认串口中只出现脱敏 token（`***xxxx`），明文 token 不得出现
9. 重新 `menuconfig` 把 `P4HOME_HA_TOKEN` 清空，`SEED_NVS_ON_BOOT` 保持 `y`，再次烧录：验证 NVS 中既有 token **不被清空**（空种子不触发写入）
10. `menuconfig` 把 `P4HOME_HA_SEED_NVS_ON_BOOT` 置 `n`，改 `P4HOME_HA_URL` 为另一个值后烧录：验证 NVS 未更新（此时完全依赖 NVS 权威）
11. 需要清空 NVS 时：`idf.py erase-flash` 或 `idf.py erase_otadata` + 手工 `nvs_flash_erase`（后续独立 plan 可提供 UI 入口，本 plan 不覆盖）

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 已设定；`idf.py reconfigure` 通过，`Kconfig` 新项在 `menuconfig` 中可见
- `idf.py build` 通过，无新增警告/错误
- 打开 `menuconfig`：
  - `P4HOME_HA_URL` 默认空
  - `P4HOME_HA_TOKEN` 默认空
  - `P4HOME_HA_VERIFY_TLS` 默认 `y`
  - `P4HOME_HA_SEED_NVS_ON_BOOT` 默认 `y`
- 未配置任何 HA 值时构建仍成功，属 MVP 默认路径

### 6.2 功能验证

空凭证路径：

- 全部 Kconfig 保持默认，冷启动：
  - `settings_service_ha_log_summary` 输出 `url=empty token=empty verify_tls=yes present=no`
  - `VERIFY:settings:ha_credentials_present:FAIL`
  - 其他 `VERIFY:` 不回归

种子写入路径：

- `menuconfig` 设置 `URL` 与 `TOKEN`，`SEED_NVS_ON_BOOT=y`，冷启动：
  - `settings_service_ha_log_summary` 中 `url=<ws://...>`、`token=***<last4>`、`present=yes`
  - `VERIFY:settings:ha_credentials_present:PASS`
  - 再次冷启动，日志相同（NVS 已存，Kconfig 与 NVS 一致不会重复写）

空种子不覆盖 NVS：

- 在上一条基础上把 `P4HOME_HA_TOKEN` 改回空串，再烧录：
  - 启动后 `present=yes`，token 掩码 last4 仍与上次一致
  - 说明空种子被正确跳过

`SEED_NVS_ON_BOOT=n` 下 NVS 权威：

- 把 `P4HOME_HA_URL` 改为不同值，`SEED_NVS_ON_BOOT=n`，冷启动：
  - `url` 仍与上一次 NVS 值一致，Kconfig 变更不生效

运行时 set 路径：

- 在 `app_main` 或串口命令中手工调用 `settings_service_ha_set_url("wss://x")`（可临时硬编在一次性测试构建里，不合入主线）：
  - 下一次启动读到的 `url == "wss://x"`
  - `log_summary` 与 `credentials_present` 同步反映

脱敏边界：

- token 长度 `>=4` → `***<last4>`
- token 长度 `1~3` → 全 `*`，长度与原 token 相同
- token 空 → `empty`
- 任何情况都不得打印 token 明文

### 6.3 回归验证

- `settings_service_init` 对 `boot_count` 与 `startup_page` 的行为与旧基线一致（`boot_count` 自增、`startup_page` 持久化）
- `p4home` namespace 读写路径未被改动
- 现有 `VERIFY:settings:*` 项目结果不回归
- `board_support_log_summary` 原有字段顺序不变，HA 摘要只追加在末尾
- `app_main` 心跳循环不因新增 `VERIFY` 项出现可感知抖动

### 6.4 硬件/联调验证

- `idf.py monitor` 冷启动三次：验证日志不出现明文 token
- `idf.py erase-flash` 清空 NVS 后首次启动：
  - Kconfig 非空种子 + `SEED_NVS_ON_BOOT=y` → 一次性写入 NVS；第二次启动不再重复写（通过 `ESP_LOGD` 或计数器观察，或不做观察仅保证无异常）
- 与 plan 4 `ha-client-websocket-bootstrap` 联调前置：
  - 在 plan 4 启动时打印它读到的 `url`（脱敏）、`token` 的 last4 与 `verify_tls`，与本 plan `log_summary` 对齐
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ha-credentials-v1.log` 作为 review 附件

## 7. 风险

- **明文 NVS 存 token 的安全面**：本 plan 显式接受 MVP 风险，依赖日志脱敏 + 不入库 `sdkconfig.defaults` 控制暴露面；secure storage 改造归 `M8`，本 plan 不引入，但需在 README 里点名
- **token 被误 commit**：`CONFIG_P4HOME_HA_TOKEN` 若被开发者随手保存进 `sdkconfig.defaults` 会永久进 git 历史；`README` 与 `Kconfig` 帮助文字都需强调不要保存
- **NVS 断电半写**：`nvs_commit` 未返回前断电可能让 `url` 与 `token` 状态不一致；下游 `credentials_present` 用 AND 判定可缓解，但运行时 `set_*` 建议按 `url → token → verify_tls` 顺序提交，并记录最后 commit 的 err
- **长度上限**：LLAT 长度若超过 `P4HOME_HA_TOKEN_MAX_LEN`（384），`set_token` 会返回 `ESP_ERR_INVALID_SIZE`；需要在 README 里给出“出现 `ERR_INVALID_SIZE` 时该调大常量”的指引
- **种子策略误解**：开发者可能期望“清空 `CONFIG_P4HOME_HA_URL` 就能清空 NVS”，与本 plan 定义相反；需要在 Kconfig 帮助文字与 README 中显式说明，并提供 `idf.py erase-flash` 作为清空手段
- **固件体积**：`factory` 分区仅剩约 `2%`；本 plan 仅新增若干百字节级代码 + 常量，体积风险极低，但仍需在 review 时复核 `idf.py size-components settings_service` 前后对比
- **线程安全误区**：`ha_client` 启动任务与主线 `app_main` 都可能调用 `settings_service_ha_get_*`；必须确保 cache 读取在 spinlock 内完成，禁止把用户 buffer 的 `memcpy` 放在锁外

## 8. 完成定义

- `idf.py build` 成功；`menuconfig` 中出现 `P4HOME_HA_URL` / `_TOKEN` / `_VERIFY_TLS` / `_SEED_NVS_ON_BOOT` 四项
- `firmware/components/settings_service/` 对外暴露以下符号且签名完全一致：
  - `settings_service_ha_get_url`
  - `settings_service_ha_get_token`
  - `settings_service_ha_verify_tls`
  - `settings_service_ha_credentials_present`
  - `settings_service_ha_set_url`
  - `settings_service_ha_set_token`
  - `settings_service_ha_set_verify_tls`
  - `settings_service_ha_log_summary`
- NVS namespace `p4home_ha` 在运行设备上可被 `nvs_get_str("url"/"token")` / `nvs_get_u8("verify_tls")` 正确读出
- 冷启动串口日志出现 `VERIFY:settings:ha_credentials_present:PASS`（当 Kconfig 或既有 NVS 已提供有效 `url`+`token`）或 `FAIL`（未提供时），结果与当前 cache 一致
- 任意启动日志检索不到明文 token（`grep -v "***" token` 无残留）；token 日志形如 `***abcd`
- `boot_count` / `startup_page` 既有语义与日志不回归
- 种子策略四条路径（空种子、Kconfig==NVS、Kconfig!=NVS、`SEED_NVS_ON_BOOT=n`）的行为与 §6.2 描述一致
- `README.md` 描述已同步更新

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

- `firmware/components/settings_service/settings_service.c`
- `firmware/components/settings_service/include/settings_service.h`
- `firmware/components/settings_service/Kconfig.projbuild`
- `firmware/components/settings_service/README.md`
- `firmware/components/board_support/board_support.c`
- `firmware/main/app_main.c`
