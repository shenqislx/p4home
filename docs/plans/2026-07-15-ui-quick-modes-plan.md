# 快捷模式控制页面计划

- 所属 Milestone: `M6`
- 状态: 已实现并烧录，待 P4 页面目视确认与模式动作验收
- 日期: `2026-07-15`

## 1. 目标

在 P4 上增加独立的快捷模式页面，通过 Home Assistant 脚本一次触发一组灯具和空调动作。批量编排由 HA 负责，P4 只调用单个 `script.turn_on`，避免面板断线时出现只完成一部分设备操作的状态。

## 2. 模式定义

- 回家模式：打开吧台灯、客厅大灯、餐厅柜灯、书房吸顶灯、阳台卧壁灯，关闭其余灯具；打开客厅风管机并切换为制冷模式。
- 离家模式：关闭全部灯具和全部空调。
- 睡眠模式：关闭全部灯具；打开主卧空调并切换为制冷模式，其他空调保持原状态。
- 舒适模式：打开客厅展示灯、客厅大灯、餐厅柜灯、书房射灯、阳台大灯、阳台卧壁灯、吧台灯，关闭其余灯具；全部空调保持原状态。

## 3. 实现范围

- 新增 4 个 HA 脚本实体：`script.p4home_home_mode`、`script.p4home_away_mode`、`script.p4home_sleep_mode`、`script.p4home_comfort_mode`。
- P4 白名单增加 `action` 类型实体，并通过 `script.turn_on` 触发脚本。
- 新增独立 `Modes` 页面，以 `2x2` 大按钮显示四种模式和简短动作摘要。
- 执行期间禁用全部模式按钮，显示等待连接、正在执行、已发送和执行失败状态，避免重复触发。
- 灯具页过滤 `action` 类型，保持原有 27 张灯具卡片不变。
- 面板实体、白名单和 HA 初始实体列表容量均由 32 扩至 48，以容纳 27 个灯具、4 个空调和 4 个模式实体。
- 中文字体生成脚本纳入模式名称、摘要及状态文本。

## 4. 验证结果

- `home_assistant/scripts.yaml` 已通过 YAML 解析。
- Home Assistant `ha core check` 通过，脚本域已在线重载，无需重启 Core。
- HA 已确认四个 `script.p4home_*` 实体均存在且处于 `off` 待命状态。
- 固件完整构建通过，应用镜像大小为 `0x153450`，最小 app 分区剩余 56%。
- `firmware/components/panel_data_store/panel_entities.json` JSON 解析通过。
- `git diff --check` 通过。
- 修正版固件已通过 `/dev/cu.usbserial-210` 烧录，写入后 hash 校验通过。
- 启动日志确认模式页 `buttons=4`、空调页 `devices=4`、面板存储 `entities=35 whitelist=35`。
- 修复异步状态刷新将 4 个脚本实体误加入灯具页的问题；日志持续确认灯具页为 `cards=27 children=8`。
- HA 已进入 `READY`，27 个灯具实体均完成状态回填；118 秒串口观察期间无看门狗、崩溃、重启或蓝屏。
- 首版仅回家模式可用：根因是 HA 客户端初始实体列表仍硬编码为 32，正好只容纳 27 个灯具、4 个空调和第一个模式实体。
- HA 初始实体容量改为可配置的 48 后重新烧录；串口确认 `initial=70`、`unknown=0`、`offline=0`，35 个实体两轮状态全部回填。

## 5. 尚未完成

- 用户目视确认 `Modes` 页面、四个按钮和中文显示正常。
- 串口确认容量修正版的四个模式实体均已回填；待用户目视确认四个按钮均显示可用。
- 由用户选择一个模式进行真实设备动作验收；未选择前不主动改变灯具和空调状态。

## 6. 关键文件

- `home_assistant/scripts.yaml`
- `firmware/components/ui_pages/ui_page_quick_modes.c`
- `firmware/components/ui_pages/include/ui_page_quick_modes.h`
- `firmware/components/panel_data_store/panel_entities.json`
- `scripts/generate-ui-cjk-font.py`
