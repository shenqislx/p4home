# 空调控制页面计划

- 所属 Milestone: `M6`
- 状态: 已实现，状态读取与书房温度控制已完成实机联调，待其余控制项验收
- 日期: `2026-07-15`

## 1. 目标

在灯具页面之外提供独立的空调控制页面，为 4 台 HA `climate.*` 设备分页显示一张可复用的大控制卡片。卡片包含开关、当前温度、设定温度、温度加减和模式切换。

## 2. 实现范围

- 白名单增加客厅风管机以及阳台卧、书房、主卧 3 台小米空调。
- `panel_data_store` 增加 climate 数据模型，解析当前温度、设定温度、温度边界、步长和可用模式。
- 数据存储支持多个 UI observer，使灯具页和空调页能同时接收状态更新。
- 新增独立 `Climate` 页，以单卡分页方式控制 4 台空调，避免同时创建大量 LVGL 对象耗尽内部堆。
- 单卡扩展为 `760×402`，占据空调页主要区域；分页键独立置于卡片两侧，减少与设备控制区混淆。
- 电源键扩大为 `88×58`，温度加减键扩大为 `84×64`，模式键扩大为 `350×62` 并保持间隔，降低误触概率。
- 支持 `turn_on`、`turn_off`、`set_temperature`、`set_hvac_mode`。
- HA 原始华氏温度在 UI 中换算为摄氏温度，控制时换回设备原始单位。
- 模式覆盖制冷、制热、除湿、送风；不受设备支持的模式按钮自动禁用。
- 中文字体生成脚本纳入新增页面全部中文字符。

## 3. 验证结果

- `cmake --build firmware/build -j4` 通过。
- `git diff --check` 通过。
- 固件已通过 `/dev/cu.usbserial-210` 烧录，写入后 hash 校验通过。
- 大卡片布局版应用镜像大小为 `0x150be0`，最小 app 分区剩余 56%。
- 启动日志确认 `panel store entities=31 whitelist=31`。
- 启动日志确认灯具页仍为 `cards=27 children=8`，空调页为 `devices=4 visible_cards=1`。
- HA 进入 `READY`，初始状态计数为 60，两轮各拉取 30 个白名单实体。
- 已验证的 3 台壁挂机均在线，模式均为 `off`，当前/设定温度字段均存在：
  - 阳台卧: `94°F / 79°F`
  - 书房: `90°F / 79°F`
  - 主卧: `88°F / 81°F`
- 首版同时创建 3 张空调卡片时，切页绘制中文触发 LVGL 字形缓冲申请失败和 `taskLVGL` 看门狗。
- 已改为单卡分页复用并重烧录；实机完成 `Climate` 切页、设备翻页和返回 `Lights`，连续串口观察超过 100 秒，无看门狗、崩溃或重启。
- 已修复温度文本只显示 `f`：`CONFIG_LV_USE_FLOAT=n` 时改用标准 `snprintf()` 预格式化数值。
- 已复现书房温度加减失败；HA 返回 `Property值错误`，根因是 UI 按 `0.5°C` 调整后又在华氏域取整，生成了米家设备不支持的非整数摄氏温度。
- 温度按钮现以整数摄氏度为基准按 `1°C` 调整，再精确换算到 HA 的华氏单位下发。修复版已烧录，HA 收到新的状态事件，串口未再出现 `set_temperature` 失败或属性值错误。
- 大卡片布局版已通过 `app-flash` 写入并完成 hash 校验；启动后 HA 进入 `READY`，连续触控产生状态回刷，未出现服务失败、看门狗或重启。

## 4. 尚未完成

- 书房空调温度加减已完成真实服务调用验证；开关与四种模式仍需逐项确认设备动作和 HA 状态回刷。
- 用户已目视确认实体屏上的单卡分页布局、中文字符和触控切页正常。
- 客厅风管机已补入白名单并重烧录；HA 初始状态计数增至 62，仍需用户目视确认第 `1 / 4` 页标题、温度和模式显示。

## 5. 关键文件

- `firmware/components/ui_pages/ui_page_climate.c`
- `firmware/components/ui_pages/cards/ui_card_climate.c`
- `firmware/components/panel_data_store/panel_data_store.c`
- `firmware/components/panel_data_store/panel_entities.json`
- `scripts/generate-ui-cjk-font.py`
