# M3 ESP-SR Fixed Command Baseline

## 1. 背景

在 [m3-esp-sr-runtime-loop.md](/Users/andyhao/workspace/p4home/docs/m3-esp-sr-runtime-loop.md) 完成后，工程已经具备：

- 持续运行的 `AFE runtime loop`
- 最小 `wake state machine`
- `WakeNet` / `VAD` 运行时计数

但当时系统还缺一个真正可执行的语音动作闭环：

- `WakeNet` 只能把系统推进到 `awake`
- `ESP-SR` 命令词模型还没有接入
- 设备上没有一个低风险、易观察、可实机验证的动作

这会让 M3 停留在“前端跑起来了”，但还没进入“用户说一句话能触发一个真实动作”的阶段。

## 2. 本次交付

- 在 [sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults) 中启用 `CONFIG_SR_MN_EN_MULTINET7_QUANT=y`
- 在 [sr_service.c](/Users/andyhao/workspace/p4home/firmware/components/sr_service/sr_service.c) 中接入 `MultiNet7` 固定命令识别
- 在 `awake` 命令窗口期间显式关闭 `WakeNet`，命令完成或超时后再恢复
- 在 [display_service.c](/Users/andyhao/workspace/p4home/firmware/components/display_service/display_service.c) 中加入语音状态 UI 和 LCD backlight 控制
- 在 [board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c) / [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c) 中暴露启动裁决与状态 getter
- 完成一次本地真实 `flash + serial capture` 启动验证，以及一次顺序正确的 `wake -> command -> backlight` 动作验证

## 3. 设计说明

### 3.1 命令模型

本轮选择的命令识别模型是 `mn7_en`，其作用是提供最小英文固定命令入口。

命令表当前包含两层短语：

- 官方 baseline：
  - `turn on the light`
  - `turn off the light`
  - `turn of the light`
- 用户自然别名：
  - `screen on` / `screen off`
  - `display on` / `display off`

原因是：

- 这类动作不影响音频 runtime 持续运行
- 在板子上可直接观察结果
- 不会引入额外业务耦合

这里没有继续依赖英文字符串自动转 phoneme，而是改成显式 `esp_mn_commands_phoneme_add()`。

原因是：

- `mn7_en` 官方接口明确建议英文命令使用显式 phoneme
- 官方 baseline `turn on/off the light` 已被示例验证
- `screen/display on/off` 不在官方默认词表里，需要用官方 `multinet_g2p.py` 单独生成 phoneme 后再安全加入

### 3.2 动作路径

命令词动作的闭环是：

1. `WakeNet` 命中，状态进入 `wake_detected`
2. 短保持后进入 `awake`
3. 进入 `awake` 后先关闭 `WakeNet`，避免重复唤醒打断命令窗口
4. `awake` 窗口内把 `AFE fetch` 输出喂给 `MultiNet`
5. 命中固定命令后调用 `display_service_set_backlight_enabled()`
6. 命令执行完成或超时后重新打开 `WakeNet`，回到 `listening`

这一步的目标不是完成最终语音产品交互，而是先建立：

- 唤醒词事件
- 命令词窗口
- 真正设备动作

这三者之间的最小可运行闭环。

### 3.3 UI 与诊断

为便于本地实机诊断，显示层新增了：

- `Voice standby / listening / awake` 文本
- 运行时统计信息
- `backlight=on/off` 状态

这样在没有更复杂 UI 的前提下，也能直接从屏幕和串口看出：

- 当前是否处于监听或唤醒态
- 最近是否识别到命令
- 命令动作是否真的落到了设备

## 4. 一个重要验证陷阱

本轮开发中遇到一个关键陷阱：

- 虽然 [sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults) 已启用 `CONFIG_SR_MN_EN_MULTINET7_QUANT=y`
- 但本地已生成的 `firmware/sdkconfig` 仍保留旧配置 `CONFIG_SR_MN_EN_NONE=y`

这会导致：

- 构建成功
- 但 `srmodels.bin` 实际没有打入 `mn7_en`
- 启动期 `command_model_ready` / `command_set_ready` 误报为 `no`

最终修正方式是：

- 删除本地生成的 `firmware/sdkconfig`
- 重新执行 `idf.py reconfigure build`

修正后，`build/srmodels/` 同时出现：

- `wn9_hiesp`
- `mn7_en`

同时 `srmodels.bin` 增长到约 `2.9M`，且 flash 流程继续把模型镜像写到 `0x710000`。

## 5. 本地实机验证

### 5.1 artifact

本地验证 artifact：

- [hardware-validation-manifest.json](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-fixed-command-pass/hardware-validation-manifest.json)
- [monitor.log](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-fixed-command-pass/monitor.log)
- [hardware-validation-manifest.json](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-light-command-pass/hardware-validation-manifest.json)
- [monitor.log](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-light-command-pass/monitor.log)

### 5.2 启动期关键证据

串口日志已经直接证明 `MultiNet7` 被打包并成功初始化，而且 active commands 已切到官方 baseline：

```text
Quantized MultiNet7:rnnt_ctc_2.0, name:mn7_en
Command 1: TkN nN jc LiT
Command 2: TkN eF jc LiT
Command 2: TkN cV jc LiT
sr_service: preflight ... model_count=3 ... command_model_ready=yes command_set_ready=yes command_model=mn7_en
p4home_main: VERIFY:sr:command_model:PASS
p4home_main: VERIFY:sr:command_set:PASS
```

这说明：

- 命令模型已进入 `model` 分区
- `MultiNet` runtime 已创建成功
- 固定命令表已装载成功

### 5.3 运行期关键证据

运行期动作验证已经拿到顺序正确的 evidence：

```text
command detected: id=1 text=light_on
Setting LCD backlight: 100%
command detected: id=2 text=light_off
Setting LCD backlight: 0%
```

这说明当前 baseline 已经不只是“模型能加载”，而是已经真实走通：

- `WakeNet` 命中
- `awake` 命令窗口打开
- `MultiNet` 识别固定命令
- backlight 动作真正落到设备

需要说明的是，这次动作验证仍然是主机 TTS 对照，不是最终人工口播验收。

## 6. 当前边界

本次完成的是：

- `mn7_en` staging
- 固定命令词 runtime 接入
- `turn on/off the light` baseline
- `screen/display on/off` alias
- 启动期 `VERIFY:sr:command_model` / `VERIFY:sr:command_set`
- 顺序正确的 `light on -> light off` backlight 动作验证

本次还未完成的是：

- 真实 wake word + fixed command 的人工口播验收
- 更复杂命令集
- 与业务状态机或页面流程联动
- 命令执行后的音频提示音

## 7. 结论

`M3` 现在已经从“AFE 持续运行”推进到“固定命令动作闭环已成立”：

- `WakeNet` 后面已经可以接 `MultiNet`
- 系统已经具备最小可执行设备动作，并已在本地硬件上验证
- 启动期可以机器可读地裁决命令词基线是否建立

下一个合理动作是：

- 做一次真实人工口播验收，验证 `wake word -> fixed command -> backlight action`
- 然后把固定命令扩展到更贴近产品的最小业务动作
