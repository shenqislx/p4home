# M1 Boot Diagnostics Baseline

## 1. 背景

`M1` 的第一个主要功能点不是显示、触摸或音频，而是先把 `ESP32-P4 EVB` 的启动与诊断基线做扎实。

目标很明确：

- 让固件稳定进入 `app_main`
- 让启动日志具备足够的问题定位能力
- 为后续 `LVGL`、触摸、音频、`ESP-SR` bring-up 提供统一的板级入口

关联 issue：

- GitHub Issue: `#1 M1: boot diagnostics baseline`

## 2. 最终实现

- 新增最小 `board_support` 组件，作为板级 bring-up 的统一入口
- 将 `app_main` 收敛为启动编排器，只保留启动顺序控制
- 扩展 `diagnostics_service`，集中输出：
  - 固件 banner
  - `ESP-IDF` 版本与编译时间
  - reset reason
  - chip / flash / partition / heap 摘要
  - 周期性 heartbeat
- 将默认 flash size 固定为 `16MB`，使当前自定义分区表可通过构建
- 为 `diagnostics_service` 补齐 `spi_flash` 依赖声明
- 对 `PSRAM` 诊断改为条件编译，避免在未启用 `CONFIG_SPIRAM` 时触发链接失败

## 3. 目录与模块影响

- [firmware/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/CMakeLists.txt)
- [firmware/main/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/main/CMakeLists.txt)
- [firmware/main/app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)
- [firmware/components/board_support/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/components/board_support/CMakeLists.txt)
- [firmware/components/board_support/include/board_support.h](/Users/andyhao/workspace/p4home/firmware/components/board_support/include/board_support.h)
- [firmware/components/board_support/board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c)
- [firmware/components/board_support/README.md](/Users/andyhao/workspace/p4home/firmware/components/board_support/README.md)
- [firmware/components/diagnostics_service/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/components/diagnostics_service/CMakeLists.txt)
- [firmware/components/diagnostics_service/include/diagnostics_service.h](/Users/andyhao/workspace/p4home/firmware/components/diagnostics_service/include/diagnostics_service.h)
- [firmware/components/diagnostics_service/diagnostics_service.c](/Users/andyhao/workspace/p4home/firmware/components/diagnostics_service/diagnostics_service.c)
- [firmware/components/README.md](/Users/andyhao/workspace/p4home/firmware/components/README.md)
- [firmware/sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults)

## 4. 关键设计决策

- `app_main` 不直接承载诊断细节，只做启动顺序编排，避免后续功能堆回入口文件。
- `board_support` 在 `M1` 保持最小实现，不提前引入 LCD、触摸、音频等真实外设初始化，避免问题面扩大。
- `diagnostics_service` 负责统一输出可观测信息，便于后续定位 reset、分区、heap 与运行稳定性问题。
- `firmware/CMakeLists.txt` 开启 `MINIMAL_BUILD`，将当前构建范围压缩到实际使用的组件，降低 bring-up 噪音。
- 不强行启用 `CONFIG_SPIRAM`。当前阶段只在已配置 `SPIRAM` 的前提下输出 PSRAM 初始化与容量信息，否则明确输出 `psram configured=no`。

## 5. 测试与验证结果

- 本机环境：
  - `ESP-IDF v5.5.4`
  - target: `esp32p4`
- 构建命令：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py set-target esp32p4
idf.py build
```

- 验证结果：
  - `idf.py build` 真实通过
  - 生成产物：
    - `build/p4home_firmware.elf`
    - `build/p4home_firmware.bin`
    - `build/bootloader/bootloader.bin`
  - 最终输出显示应用镜像落在 `0x10000`，flash size 为 `16MB`

- 构建过程中定位并修复的问题：
  - 默认 `2MB` flash 配置与当前 `partitions.csv` 不匹配，导致 partition table 校验失败
  - `diagnostics_service` 使用 `esp_flash.h`，但初始未声明 `spi_flash` 依赖
  - `esp32p4` 当前配置下未启用 `CONFIG_SPIRAM`，直接调用 PSRAM 运行时 API 会在链接阶段失败

## 6. 后续维护注意事项

- 当前构建仍依赖 `IDF_SKIP_CHECK_SUBMODULES=1`，因为本机 `~/.espressif/v5.5.4/esp-idf` 不是完整 submodule 工作树。
- 保留组件目录如 `audio_service`、`display_service` 等还没有 `CMakeLists.txt`，构建时会打印提示，但不影响 `M1` 最小构建。
- 本阶段还没有完成 `ESP32-P4 EVB` 实机烧录和串口日志验证；下一步应优先做板上验证，而不是继续堆更多功能。
- 如果后续要真正启用 PSRAM，需要单独确认：
  - 板卡实际 flash / PSRAM 规格
  - 对应 `sdkconfig` 选项
  - 串口日志是否正确反映初始化状态
