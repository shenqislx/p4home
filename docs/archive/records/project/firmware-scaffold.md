# firmware-scaffold

## 1. 背景

这是项目进入 `M1` 后的第一个真实功能，用于为后续 `ESP32-P4 EVB` bring-up、`LVGL`、`ESP-SR` 和网关接入提供稳定的固件工程落点。

所属 Milestone: `M1`

## 2. 最终实现

本次完成了最小 `ESP-IDF` 固件工程骨架：

- 新增 [firmware](/Users/andyhao/workspace/p4home/firmware) 目录
- 新增顶层构建文件 [CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/CMakeLists.txt)
- 新增默认配置 [sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults)
- 新增分区表 [partitions.csv](/Users/andyhao/workspace/p4home/firmware/partitions.csv)
- 新增入口 [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)
- 新增最小组件 [diagnostics_service.c](/Users/andyhao/workspace/p4home/firmware/components/diagnostics_service/diagnostics_service.c)
- 建立后续组件目录边界：
  - `board_support`
  - `display_service`
  - `touch_service`
  - `ui_core`
  - `ui_pages`
  - `audio_service`
  - `sr_service`
  - `settings_service`
  - `network_service`

同时更新了：

- [AGENT.md](/Users/andyhao/workspace/p4home/AGENT.md)
- [README.md](/Users/andyhao/workspace/p4home/README.md)
- [.gitignore](/Users/andyhao/workspace/p4home/.gitignore)

## 3. 目录与模块影响

新增目录：

- [firmware](/Users/andyhao/workspace/p4home/firmware)
- [firmware/main](/Users/andyhao/workspace/p4home/firmware/main)
- [firmware/components](/Users/andyhao/workspace/p4home/firmware/components)

模块边界：

- `main/` 负责启动入口与启动顺序
- `diagnostics_service` 负责最小运行信息输出
- 其余模块先保留占位目录，不在本阶段提前实现

## 4. 关键设计决策

- 先建立骨架，不在本阶段接入 `LVGL`、音频、触摸或 `ESP-SR`
- `app_main` 只保留最小启动日志与常驻任务，减少 bring-up 变量
- 分区表和默认配置保持保守，避免在硬件参数未完全确认前写死过多假设
- 组件目录先于功能实现落地，保证后续扩展时目录边界稳定

## 5. 测试与验证结果

### 5.1 功能验证

- 已确认 `firmware/` 工程结构存在且符合 plan
- 已确认 [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c) 含明确启动日志
- 已确认后续功能模块目录已就位

### 5.2 构建验证

- 当前机器上未发现 `idf.py`
- 当前环境未配置 `IDF_PATH`
- 因此本次未能执行真实 `ESP-IDF` 构建，仅完成静态结构检查

### 5.3 回归验证

- 已确认不破坏现有 harness 结构
- 已确认 `AGENT.md` 和 `README.md` 已同步更新

### 5.4 人工 review

- 用户已明确确认本次实现 review 通过

## 6. 后续维护注意事项

- 下一步应优先补齐本机 `ESP-IDF` 工具链环境
- 真正进入 `M1` bring-up 前，建议先完成一次 `idf.py set-target esp32p4` 和 `idf.py build`
- 在 `board_support` 未落地前，不要提前耦合具体外设驱动
- `LVGL`、`ESP-SR`、音频、触摸应按 milestone 顺序逐步接入

