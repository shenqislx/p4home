# M2 GT911 I2C Touch Diagnostics

## Summary

`M2` 的 `GT911 / I2C` 触摸链路诊断已经在 `ESP32-P4 EVB V1.4` 上完成实机验证。

本次验证确认：

- `I2C` 总线工作正常
- `GT911` 可在 `0x5D` 地址被探测到
- `GT911` 产品 ID 可被正常读取
- `bsp_touch_new()` 在当前硬件连接状态下已经成功
- 触摸诊断逻辑没有破坏已完成的 `LCD + LVGL` 显示基线

关联 issue：

- GitHub Issue: `#4 M2: GT911 I2C touch diagnostics`

实际验证环境：

- Board: `ESP32-P4 Function EV Board V1.4`
- Chip: `ESP32-P4 v1.0`
- IDF: `ESP-IDF v5.5.4`
- Serial port: `/dev/cu.usbserial-10`

## Final Implementation

本阶段新增最小 `touch_service`，仅负责“诊断”，不把触摸重新强耦合回显示启动路径：

- 初始化 BSP `I2C` 总线
- 扫描总线响应地址
- 探测 `GT911` 主地址 `0x5D` 与备用地址 `0x14`
- 读取 `GT911` 产品 ID 寄存器
- 试探性执行 `bsp_touch_new()`
- 将所有结果输出到串口日志

同时保持已有约束：

- 触摸诊断失败不会导致整机 panic/reboot
- `display_service` 仍走“只启显示、不依赖触摸”的稳定路径

## Directory And Module Impact

- [firmware/components/touch_service/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/components/touch_service/CMakeLists.txt)
- [firmware/components/touch_service/include/touch_service.h](/Users/andyhao/workspace/p4home/firmware/components/touch_service/include/touch_service.h)
- [firmware/components/touch_service/touch_service.c](/Users/andyhao/workspace/p4home/firmware/components/touch_service/touch_service.c)
- [firmware/components/touch_service/README.md](/Users/andyhao/workspace/p4home/firmware/components/touch_service/README.md)
- [firmware/components/board_support/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/components/board_support/CMakeLists.txt)
- [firmware/components/board_support/include/board_support.h](/Users/andyhao/workspace/p4home/firmware/components/board_support/include/board_support.h)
- [firmware/components/board_support/board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c)
- [firmware/main/CMakeLists.txt](/Users/andyhao/workspace/p4home/firmware/main/CMakeLists.txt)
- [firmware/main/app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)

## Key Design Decisions

- 不把触摸问题重新带回 BSP 默认 `bsp_display_start()` 路径，避免再次出现“触摸失败拖死显示启动”。
- 使用最小 `touch_service` 将问题分层：
  - 总线层
  - 地址探测层
  - 产品 ID 读取层
  - BSP 触摸初始化层
- 将 `touch_service` 接入 `board_support`，但只做日志诊断，不把触摸状态作为启动成败条件。

## Hardware Findings

### 1. `GT911` 现在已经真实连通

实机日志显示总线上至少有两个设备响应：

- `0x18`
- `0x5D`

其中 `0x5D` 可进一步读出 `GT911` 产品 ID：

```text
I (...) touch_service: i2c device responded at 0x5d
I (...) touch_service: GT911 responded at 0x5d with product_id=911
I (...) GT911: TouchPad_ID:0x39,0x31,0x31
```

这说明当前硬件连接状态下：

- 触摸排线已连通
- `GT911` 已在默认地址工作
- 之前的 `I2C transaction failed` 不再出现

### 2. 备用地址 `0x14` 当前没有响应

诊断结果显示：

- `0x5D`: 响应
- `0x14`: 未响应

这与 `GT911` 当前地址锁定在默认地址的状态一致。

### 3. BSP 的 `1024x600` 路径没有主动驱动触摸 reset/address select

当前 BSP 宏定义显示：

- `BSP_LCD_TOUCH_RST = GPIO_NUM_NC`
- `BSP_LCD_TOUCH_INT = GPIO_NUM_NC`

也就是说，在这条 BSP 配置下：

- 驱动不会主动通过 `RST/INT` 管脚选择 `GT911` 地址
- 只能依赖当前硬件上电后的默认状态

但在你当前连线完成后的状态下，这已经不是阻塞问题，因为 `0x5D` 可直接工作。

## Build And Flash

本机执行：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py build
idf.py -p /dev/cu.usbserial-10 flash
```

结果：

- 构建成功
- 烧录成功
- 触摸诊断固件成功写入开发板

## Serial Validation

关键串口日志如下：

```text
I (...) touch_service: touch gpio assumptions: rst=-1 int=-1; BSP 1024x600 path leaves both as NC, so GT911 address selection/reset is not actively driven
I (...) touch_service: scanning BSP I2C bus on SDA=7 SCL=8
I (...) touch_service: i2c device responded at 0x18
I (...) touch_service: i2c device responded at 0x5d
I (...) touch_service: GT911 responded at 0x5d with product_id=911
I (...) GT911: I2C address initialization procedure skipped - using default GT9xx setup
I (...) GT911: TouchPad_ID:0x39,0x31,0x31
I (...) GT911: TouchPad_Config_Version:89
I (...) touch_service: BSP touch init succeeded
I (...) touch_service: ... gt911_detected=yes ... gt911_addr=0x5d ... bsp_touch_ready=yes
I (...) p4home_main: touch diagnostics gt911_detected=yes bsp_touch_ready=yes
```

这组日志确认：

- `I2C` 总线正常
- `GT911` 已连通
- `bsp_touch_new()` 已通过
- 应用未因触摸诊断而重启

## Test Result Summary

- 构建验证：通过
- 烧录验证：通过
- `I2C` 扫描验证：通过
- `GT911` 地址探测验证：通过
- `GT911` 产品 ID 读取验证：通过
- BSP 触摸初始化验证：通过
- 显示链路回归验证：通过

## Outcome

`GT911 / I2C` 触摸链路已经不再是未知状态，当前结论是：

- 硬件已连通
- 默认地址 `0x5D` 可用
- BSP 默认触摸初始化现在可成功运行

这意味着后续可以进入下一阶段：

- 将触摸接回 `LVGL indev`
- 进行基础点击/坐标验证
- 再进入页面导航与交互框架
