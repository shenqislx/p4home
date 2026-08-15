# M2 LVGL Touch Indev Validation

## Summary

`M2` 的 `LVGL touch indev` 接入已经在 `ESP32-P4 EVB V1.4` 上完成实机验证。

本次验证确认：

- `GT911` 已正式接回当前 `LVGL` 显示链路
- `LVGL indev` 注册成功
- bootstrap 页面上的按钮可被真实点击
- 串口能够稳定输出触摸按下与点击坐标
- 当前坐标方向与屏幕中央按钮区域一致，暂未发现镜像或翻转异常

关联 issue：

- GitHub Issue: `#5 M2: LVGL touch indev validation`

实际验证环境：

- Board: `ESP32-P4 Function EV Board V1.4`
- Chip: `ESP32-P4 v1.0`
- IDF: `ESP-IDF v5.5.4`
- Serial port: `/dev/cu.usbserial-10`

## Final Implementation

本阶段在保持当前“显示与触摸可分层初始化”的前提下，将 `GT911` 正式挂接到 `LVGL indev`。

实现方式：

- `display_service` 保持手动显示初始化路径，不回退到 `bsp_display_start()`
- `touch_service` 在完成 `GT911 / I2C` 诊断后，复用 `bsp_touch_new()` 得到的触摸句柄
- 使用 `lvgl_port_add_touch()` 将触摸设备绑定到当前 `lv_display_t`
- 在 bootstrap 页面新增最小交互按钮和状态文本，用于实机点击验证
- 点击事件直接输出坐标日志，并在页面底部更新触摸状态

当前约束仍然保留：

- 触摸初始化失败不会阻塞整机启动
- `LCD + LVGL` 显示链路仍然是主稳定路径

## Directory And Module Impact

- [firmware/components/display_service/include/display_service.h](/Users/andyhao/workspace/p4home/firmware/components/display_service/include/display_service.h)
- [firmware/components/display_service/display_service.c](/Users/andyhao/workspace/p4home/firmware/components/display_service/display_service.c)
- [firmware/components/touch_service/include/touch_service.h](/Users/andyhao/workspace/p4home/firmware/components/touch_service/include/touch_service.h)
- [firmware/components/touch_service/touch_service.c](/Users/andyhao/workspace/p4home/firmware/components/touch_service/touch_service.c)
- [firmware/components/board_support/include/board_support.h](/Users/andyhao/workspace/p4home/firmware/components/board_support/include/board_support.h)
- [firmware/components/board_support/board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c)
- [firmware/main/app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)

## Key Design Decisions

- 不把触摸重新耦合回 BSP 的黑盒显示启动路径，避免再次出现“触摸失败拖垮显示”的问题。
- `touch_service` 继续负责触摸相关状态机：
  - 诊断
  - BSP 触摸初始化
  - `LVGL indev` 接入
- `board_support` 只做启动顺序编排：
  - 先起显示
  - 再做触摸诊断
  - 最后按条件把触摸挂到 `LVGL`
- 页面层只提供最小验证控件，不在这个阶段引入页面路由和业务 UI。

## Runtime Behavior

### 1. `LVGL indev` 已成功挂接

实机串口日志确认：

```text
I (...) touch_service: BSP touch init succeeded
I (...) touch_service: touch diagnostics ran=yes ... bsp_touch_ready=yes lvgl_indev_ready=no
I (...) touch_service: LVGL touch indev attached: indev=0x... display=0x...
I (...) touch_service: touch diagnostics ran=yes ... bsp_touch_ready=yes lvgl_indev_ready=yes
I (...) p4home_main: touch diagnostics gt911_detected=yes bsp_touch_ready=yes lvgl_indev_ready=yes
```

这说明当前链路已经从“触摸芯片可探测”推进到“触摸输入已经真正进入 `LVGL`”。

### 2. bootstrap 页面已具备最小点击验证能力

页面中心新增了最小按钮：

- `Tap To Validate Touch`

按钮具备两个验证作用：

- 按下时输出 `touch press`
- 点击时输出 `touch click`

同时页面底部状态文本会从：

- `Touch pending: indev not attached`

切换到：

- `Touch ready: tap button to validate input`

后续点击时继续显示点击次数和最后一次坐标。

### 3. 坐标方向当前正常

用户已经在屏幕中央按钮区域进行了实际点击，串口捕获到的坐标集中在按钮附近，例如：

```text
I (...) display_service: touch click #17 at x=529 y=338
I (...) display_service: touch click #18 at x=530 y=330
I (...) display_service: touch click #19 at x=529 y=311
I (...) display_service: touch click #20 at x=538 y=319
I (...) display_service: touch click #21 at x=540 y=357
```

这些坐标与页面中央按钮位置一致，说明：

- 当前触摸坐标映射有效
- 暂未发现明显的 `mirror_x / mirror_y / swap_xy` 方向错误

本阶段不再额外扩展四角校准逻辑，坐标精细校准放到后续交互阶段处理。

## Build And Flash

本机执行：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py build
idf.py -p /dev/cu.usbserial-10 flash
idf.py -p /dev/cu.usbserial-10 monitor
```

结果：

- 构建成功
- 烧录成功
- 串口监视成功
- 点击事件被稳定捕捉

## Test Result Summary

- 构建验证：通过
- 烧录验证：通过
- `LVGL indev` 接入验证：通过
- 最小点击验证：通过
- 坐标日志验证：通过
- 当前方向判断：通过
- 显示链路回归验证：通过

## Outcome

`GT911` 已经不只是“可探测”，而是已经成为当前 `p4home` bootstrap 页面的真实输入设备。

这意味着 `M2` 阶段的输入基线已经建立完成，后续可以进入更高一层的交互工作：

- 页面导航骨架
- 基础控件系统
- 触摸反馈与状态同步
- 数据卡片和业务页面布局
