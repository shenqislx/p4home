# M2 Display LVGL Bootstrap

## Summary

`M2` 已在 `ESP32-P4 EVB V1.4` 上完成首个显示功能闭环：

- `LCD` 成功点亮
- `LVGL` 成功初始化
- 屏幕上可稳定显示 `p4home` bootstrap 页面
- 实机 `build -> flash -> monitor` 链路已验证通过

关联 issue：

- GitHub Issue: `#3 M2: display bring-up and LVGL bootstrap`

实际验证环境：

- Board: `ESP32-P4 Function EV Board V1.4`
- Chip: `ESP32-P4 v1.0`
- IDF: `ESP-IDF v5.5.4`
- Serial port: `/dev/cu.usbserial-10`
- Display path: `MIPI DSI 1024x600`

## Final Implementation

本阶段新增最小 `display_service`，并将其接入现有启动编排：

- `display_service`
  - 负责初始化 `LVGL port`
  - 负责初始化 `LCD panel`
  - 负责将 `DSI display` 注册到 `LVGL`
  - 负责点亮背光并绘制最小 bootstrap 页面
- `board_support`
  - 从“纯占位”升级为真实编排显示 bring-up 的板级入口
- `app_main`
  - 在 `M1 diagnostics` 基线之上，增加显示状态确认日志

首屏内容保持极简：

- 标题 `p4home`
- `ESP32-P4 EVB V1.4`
- 分辨率 `1024x600`
- `IDF` 版本摘要
- 状态文本 `LVGL bootstrap ready`

## Directory And Module Impact

- [firmware/components/display_service/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/components/display_service/CMakeLists.txt)
- [firmware/components/display_service/idf_component.yml](/Users/andyhao/workspace/p4home/firmware/components/display_service/idf_component.yml)
- [firmware/components/display_service/include/display_service.h](/Users/andyhao/workspace/p4home/firmware/components/display_service/include/display_service.h)
- [firmware/components/display_service/display_service.c](/Users/andyhao/workspace/p4home/firmware/components/display_service/display_service.c)
- [firmware/components/board_support/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/components/board_support/CMakeLists.txt)
- [firmware/components/board_support/include/board_support.h](/Users/andyhao/workspace/p4home/firmware/components/board_support/include/board_support.h)
- [firmware/components/board_support/board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c)
- [firmware/main/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/main/CMakeLists.txt)
- [firmware/main/app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)
- [firmware/sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults)
- [/.gitignore](/Users/andyhao/workspace/p4home/.gitignore)

## Key Design Decisions

- `M2` 先只交付“显示可启动、首屏可见”，不把触摸、导航、业务页面一起塞进同一阶段。
- 使用官方 managed components：
  - `espressif/esp32_p4_function_ev_board`
  - `lvgl/lvgl`
- 不继续走 `bsp_display_start()` 默认路径，而是改为手动编排：
  - `lvgl_port_init`
  - `bsp_display_new_with_handles`
  - `lvgl_port_add_disp_dsi`
  - `bsp_display_backlight_on`
- 这样做的直接目的，是把 `LCD` 初始化与 `GT911` 触摸初始化解耦，避免触摸链路故障阻塞显示 bring-up。

## Hardware Findings

本阶段先后定位了两个真实硬件/配置问题。

### 1. Frame Buffer OOM Was Caused By `sdkconfig`

第一次实机 bring-up 时，`LCD` 在 `esp_lcd_new_panel_dpi()` 阶段报 `ESP_ERR_NO_MEM`，根因不是 `LVGL` 页面代码，而是本地已有的 `firmware/sdkconfig` 覆盖了 `sdkconfig.defaults`，导致 `CONFIG_SPIRAM` 实际没有生效。

修正方法：

- 删除本地 `sdkconfig`
- 重新执行 `idf.py set-target esp32p4 build`
- 让 `sdkconfig.defaults` 中的以下配置真正进入生效配置：
  - `CONFIG_SPIRAM=y`
  - `CONFIG_SPIRAM_MODE_HEX=y`
  - `CONFIG_SPIRAM_SPEED_200M=y`
  - `CONFIG_BSP_LCD_TYPE_1024_600=y`

验证结果：

- `PSRAM` 成功识别为 `32MB`
- `frame buffer` OOM 消失

### 2. `GT911` Touch Failure Should Not Block `LCD`

在 `PSRAM` 修正后，`LCD` 已可成功初始化，但 `GT911` 触摸控制器通过 `I2C` 初始化失败：

```text
E (...) GT911: touch_gt911_read_cfg(...): GT911 read error!
E (...) GT911: esp_lcd_touch_new_i2c_gt911(...): GT911 init failed
```

这时如果继续使用 BSP 的 `bsp_display_start()`，启动会因为 `bsp_touch_new()` 失败而直接 `abort`。

`M2` 的处理策略是：

- 不在本阶段强行修触摸
- 先把显示链路跑通
- 将触摸带入后续独立功能点处理

这让 `LCD` 成为稳定可复用的基础设施，而不是被触摸链路绑死。

## Build And Flash

本机执行：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py set-target esp32p4 build
idf.py -p /dev/cu.usbserial-10 flash
```

结果：

- 构建成功
- 烧录成功
- `p4home_firmware.bin` 成功写入
- 应用分区剩余空间约 `69%`

## Serial Validation

关键串口日志如下：

```text
I (...) esp_psram: Found 32MB PSRAM device
I (...) esp_psram: Adding pool of 32768K of PSRAM memory to heap allocator
I (...) diagnostics: reset_reason=poweron (1)
I (...) display_service: starting display bootstrap for ESP32-P4 EVB V1.4 without touch
I (...) ESP32_P4_EV: Display initialized
I (...) ESP32_P4_EV: Setting LCD backlight: 100%
I (...) display_service: display bootstrap ready: 1024x600 panel=...
I (...) display_service: display ready=yes resolution=1024x600 handle=... touch=no panel=... io=...
I (...) diagnostics: psram configured=yes initialized=yes size=33554432 bytes (32 MB)
I (...) p4home_main: display bootstrap ready=yes
I (...) diagnostics: heartbeat uptime_ms=...
```

这组日志确认了几件事：

- `PSRAM` 已真正启用
- `LCD` 初始化完成
- 背光已点亮
- `LVGL` 首屏已进入稳定运行状态
- 应用没有再因为显示初始化而重启

## Test Result Summary

- 构建验证：通过
- 烧录验证：通过
- 串口验证：通过
- LCD 点亮验证：通过
- 屏幕可见 `p4home` 页面：通过
- 30 秒级稳定运行：通过
- 触摸验证：未纳入本阶段完成定义

## Follow-Up

`M2` 已经达到“显示骨架成立”的关闭条件，后续建议拆为独立功能继续推进：

- `M2.x` 触摸链路验证与 `GT911` 诊断
- `M3` 页面结构与导航框架
- `M3` 数据卡片和状态布局

当前不建议回退到 BSP 默认“显示 + 触摸强绑定”的启动方式。对于这个项目，显示先稳定、触摸后补，是更可维护的顺序。
