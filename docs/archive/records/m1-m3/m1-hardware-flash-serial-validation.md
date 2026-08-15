# M1 Hardware Flash And Serial Validation

## Summary

`M1 boot diagnostics baseline` 已在 `ESP32-P4 EVB` 上完成首次实机烧录和串口验证。

实际验证环境：

- Board: `ESP32-P4 Function EV Board`
- Chip: `ESP32-P4 v1.0`
- IDF: `ESP-IDF v5.5.4`
- Host serial port: `/dev/cu.usbserial-10`

本次验证确认：

- `build -> flash -> monitor` 链路在真实硬件上可用
- 当前 `M1` 诊断日志能够在板上稳定输出
- 工程必须显式切到 `ESP32-P4 rev < 3.0 / v1.0` 分支配置，否则 `v1.0` 板卡无法烧录

## Configuration Fix

实机烧录前，工程默认按 `ESP32-P4 >= v3.1` 构建，导致 `esptool` 在刷写 bootloader 时拒绝烧录：

```text
bootloader/bootloader.bin requires chip revision in range [v3.1 - v3.99]
```

原因不是串口或烧录流程错误，而是 `ESP-IDF v5.5.4` 的 `ESP32-P4` 默认最小芯片版本为 `v3.1`。

为适配当前开发板 `v1.0`，将项目切换到 `rev < 3.0` 分支：

- `CONFIG_ESP32P4_SELECTS_REV_LESS_V3=y`
- `CONFIG_ESP32P4_REV_MIN_100=y`

对应维护入口：

- [sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults)

## Build And Flash

实际执行路径：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py fullclean build
idf.py -p /dev/cu.usbserial-10 flash
```

结果：

- `idf.py fullclean build` 通过
- `idf.py flash` 成功
- bootloader、partition table、app 均写入并完成 hash 校验

关键烧录信息：

- Flash size: `16MB`
- Flash mode: `DIO`
- Flash freq: `80MHz`

## Serial Validation

实际执行：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py -p /dev/cu.usbserial-10 monitor
```

关键启动日志摘录：

```text
I (25) boot: ESP-IDF v5.5.4 2nd stage bootloader
I (27) boot: chip revision: v1.0
I (40) boot.esp32p4: SPI Flash Size : 16MB
I (186) app_init: Project name:     p4home_firmware
I (204) app_init: ESP-IDF:          v5.5.4
I (208) efuse_init: Min chip rev:     v1.0
I (216) efuse_init: Chip rev:         v1.0
I (282) diagnostics: p4home firmware starting
I (292) diagnostics: reset_reason=poweron (1)
I (312) board_support: board=ESP32-P4 Function EV Board target=esp32p4 initialized=yes
I (322) diagnostics: flash size=16777216 bytes (16 MB)
I (352) diagnostics: heap free=603344 bytes min_free=603264 bytes
I (362) diagnostics: heartbeat uptime_ms=105 delta_ms=0
I (10362) diagnostics: heartbeat uptime_ms=10104 delta_ms=9998
```

结论：

- bootloader 正常启动
- app 成功进入 `app_main`
- `board_support` 初始化路径正常
- flash、heap、heartbeat 均符合 `M1` 预期

## Partition Notes

串口日志中出现以下三行：

```text
E (332) esp_ota_ops: not found otadata
I (332) diagnostics: running partition label=factory subtype=0x00 address=0x10000 size=2097152
W (342) diagnostics: boot partition unavailable
```

这不是启动失败，而是当前分区表没有 `otadata`，因此系统以 `factory` 分区直接启动：

- `running partition` 可正常识别
- `boot partition` 语义不完整
- OTA 状态管理尚未启用

这对 `M1 bring-up` 可接受，但后续如果启用 OTA，需要补充 `otadata` 分区并重新验证。

## Reset Validation Status

本次验证已完成：

- 冷启动/上电启动日志采集

本次尚未完全闭环：

- 明确的软件复位场景验证
- 明确的 `EN` 键硬件复位场景验证

尝试通过 monitor 触发附加复位时，日志仍表现为 `poweron (1)`，因此当前不能把 reset reason 的多场景验证视为完成。

## Outcome

`M1` 的硬件验证结论如下：

- 成功识别开发板串口
- 成功完成实机烧录
- 成功采集首次启动日志
- 成功验证核心诊断输出
- 已修正 `ESP32-P4 v1.0` 的芯片 revision 兼容性配置

当前建议：

- 保持 `sdkconfig.defaults` 中的 `rev v1.0` 选择
- 后续单独补一个小功能，专门闭环 reset reason 的多场景验证
