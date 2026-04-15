# ESP32-P4 本地验证计划

## 1. 验证目标

本阶段只验证以下本地能力，不引入复杂外部依赖：

- `ESP-IDF` 工程可稳定编译、烧录、启动
- 屏幕点亮并跑通 `LVGL`
- 触摸输入稳定
- 音频输入输出链路打通
- `ESP-SR` 跑通唤醒词/固定命令
- 基础系统能力齐备：日志、NVS、配置、网络、OTA 占位

本阶段不作为阻塞项的内容：

- Home Assistant 联调
- 米家实体映射
- LLM 对话
- Panel Gateway Service

## 2. 阶段划分

## 阶段 A：板级 bring-up

目标：

- 确认 `ESP32-P4 EVB` 在当前开发机可稳定烧录
- 获取串口日志
- 确认 Flash / PSRAM / 显示接口初始化正常

验收标准：

- 能稳定进入 `app_main`
- 启动日志中能确认芯片、内存、分区信息
- 无随机重启或早期 panic

建议输出：

- `hello_p4` 最小工程
- 启动日志留档

## 阶段 B：显示与 LVGL

目标：

- 点亮 LCD
- 集成 `LVGL`
- 跑通定时刷新与双缓冲/局部刷新策略

验收标准：

- 可以稳定显示首页 demo
- 页面切换无明显撕裂或严重闪烁
- 内存占用可控

建议先做：

- 单页静态 dashboard
- 状态栏
- 两到三个卡片组件

不要先做：

- 复杂动画
- 图表
- 大量图片资源

## 阶段 C：触摸与输入模型

目标：

- 集成触摸驱动
- 统一点击、长按、滑动、页面切换事件

验收标准：

- 点击命中稳定
- 页面切换延迟可接受
- 无明显误触与坐标漂移

建议输出：

- `home` 页
- `room` 页
- `settings` 页

## 阶段 D：音频链路

目标：

- 打通麦克风采集
- 打通扬声器播放
- 建立统一 audio service

验收标准：

- 能录音并导出/回放短音频
- 能播放测试音频
- 采集与播放互不干扰

建议优先验证：

- `I2S mic`
- `I2S speaker/amp`
- 音量控制
- 静音与回放测试

## 阶段 E：ESP-SR

目标：

- 跑通 `AFE`
- 跑通 `WakeNet`
- 视资源情况验证 `MultiNet`

验收标准：

- 在典型室内环境下能稳定唤醒
- 能触发至少一组固定命令
- 误唤醒频率可接受

建议策略：

- 第一阶段先做固定唤醒词
- 第二阶段再做固定命令词
- 不要在这一阶段引入通用语音理解

## 阶段 F：系统基础设施

目标：

- 建立配置系统
- 建立 NVS 参数存储
- 建立日志等级与错误上报接口
- 预留 OTA 机制

验收标准：

- 设备可记住基本设置
- 日志可区分模块
- 能预留版本号、设备 ID、构建信息

## 3. 推荐工程结构

建议在真正建工程时采用如下结构：

```text
p4home/
  README.md
  docs/
  firmware/
    CMakeLists.txt
    sdkconfig.defaults
    partitions.csv
    main/
      app_main.c
      CMakeLists.txt
    components/
      board_support/
      display_service/
      touch_service/
      ui_core/
      ui_pages/
      audio_service/
      sr_service/
      settings_service/
      network_service/
      diagnostics_service/
```

模块职责建议：

- `board_support`：板级初始化、GPIO、背光、电源控制
- `display_service`：LCD、LVGL、缓冲区、刷新
- `touch_service`：触摸驱动与输入事件
- `ui_core`：主题、组件、导航
- `ui_pages`：页面实现
- `audio_service`：I2S、录音、播放
- `sr_service`：ESP-SR 封装
- `settings_service`：NVS 配置
- `network_service`：Wi‑Fi、时间同步、后续网关连接
- `diagnostics_service`：日志、watchdog、性能统计

## 4. 最小可行验证清单

建议先完成这个最小集合：

1. `hello world + serial log`
2. `LCD 点亮 + LVGL label`
3. `触摸按钮切页`
4. `I2S mic 录音`
5. `I2S speaker 播放提示音`
6. `ESP-SR 唤醒词`
7. `本地设置页`

只有这 7 项稳定后，才建议进入 HA 联调。

### 当前状态（2026-04-15）

- 上述 7 项已经全部在本地 `ESP32-P4 EVB` 上打通
- `settings_service` 已接入 `NVS`，可持久化 `boot_count` 与 `startup_page`
- `display_service` 已具备 `Home / Settings` 双页导航，触摸可切换页面
- 冷启动串口日志已验证 `VERIFY:settings:nvs:PASS`、`VERIFY:display:bootstrap:PASS`、`VERIFY:touch:*`、`VERIFY:audio:*`、`VERIFY:sr:*`
- 当前残余问题是 `esp_codec_dev` / `I2S_IF` 初始化路径仍会打印少量 `i2s_channel_disable(...): the channel has not been enabled yet`，但未阻塞音频自检、`ESP-SR` runtime 或 UI 启动

因此当前建议是：在进入 `M4` 之前，只继续处理“底座稳定性噪音”和少量本地系统能力补齐，不要再回退到单页或占位式设置实现。

## 5. 技术实现建议

## 显示

- 优先复用 Espressif 官方/半官方板级支持
- 优先使用 `esp_lcd`
- `LVGL` 版本固定，不要在验证期频繁升级

## 内存

- 显示缓冲优先放 `PSRAM`
- 高频控制结构尽量留在内部 RAM
- 先做低风险布局，再做性能优化

## UI

- 先统一主题与组件规范
- 先做页面模板，不要先做业务细节
- 每页只保留最关键的状态与操作

## 音频

- 先做“可用”，后做“好听”
- 优先验证采集稳定性与唤醒准确率
- AEC/降噪等增强能力逐步打开

## ESP-SR

- 先跑官方支持路径
- 尽量不在第一阶段做大量自定义模型
- 保持音频参数固定，降低调试变量

## 6. 风险与规避

## 风险 1：显示链路复杂

规避：

- 先跑最小官方例程
- 不要一上来就叠加复杂 UI

## 风险 2：音频链路和 SR 同时调试变量太多

规避：

- 先录放音
- 再上 AFE
- 最后上唤醒词

## 风险 3：工程一开始就耦合业务

规避：

- 本地验证阶段只做底座
- 不引入 HA 业务模型

## 风险 4：过早优化

规避：

- 第一轮只关心稳定性和功能完整性
- 第二轮再做帧率、内存和动效优化

## 7. 本阶段完成定义

当以下条件全部满足时，可认为本地验证完成：

- 设备可稳定启动与运行
- `LVGL` 页面可交互
- 触摸输入可靠
- 音频采集与播放可靠
- `ESP-SR` 唤醒词可用
- 系统配置、日志、版本信息齐备

完成后再进入下一阶段：

- `Home Assistant` 接入
- 设备实体同步
- 语音流上传
- 本地 AI 节点联调

## 8. 下一步建议

按优先级建议直接开始：

1. 创建 `firmware/` 最小 `ESP-IDF` 工程
2. 跑通板级显示 demo
3. 引入 `LVGL`
4. 建立推荐工程结构

如果下一步要我继续，我建议直接做：

- `firmware/` 初始工程骨架
- `components/` 目录与空模块
- `sdkconfig.defaults`
- `partitions.csv`
- 一个最小 `LVGL` 首页 demo
