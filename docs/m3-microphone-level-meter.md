# M3 Microphone Level Meter

## 1. 背景

在 `M3` 的 `ES8311` codec bring-up 完成后，项目已经具备：

- 手动触发 `Play Test Tone`
- 手动触发 `Capture Mic Sample`
- 板载麦克风采样能力

在接入 `ESP-SR` 之前，需要先把麦克风输入做成持续可观察、可停止、可验证的工程诊断能力。

## 2. 本次交付

- 在主页面增加 `Start Mic Meter` / `Stop Mic Meter`
- 增加 `Mic level` 电平条
- 增加实时指标文本：
  - `meter`
  - `bytes`
  - `peak`
  - `mean`
  - `nonzero`
- 将麦克风连续采样接入独立任务，不阻塞主界面
- 保留现有 `Play Test Tone` 与 `Capture Mic Sample` 按钮

## 3. 实现说明

### 3.1 audio_service

新增 microphone snapshot/result 读取能力：

- `audio_service_begin_microphone_stream()`
- `audio_service_read_microphone_stream()`
- `audio_service_end_microphone_stream()`
- `audio_service_get_microphone_snapshot()`

连续 meter 不再每次循环都重新打开/关闭 codec，而是：

1. 启动 meter 时打开 microphone stream
2. 循环读取 PCM
3. 停止 meter 时关闭 stream

这样避免了频繁 `open/close` 带来的额外时序噪声。

### 3.2 电平计算修正

首版实现里，页面电平条几乎不变化。实机验证后确认根因是：

- 原始 `mean_abs` 直接用于映射时，容易受到麦克风直流偏置或底噪抬高影响
- 结果是数值存在，但视觉变化很弱

本次修正改为：

1. 先计算整段 PCM 的 `dc_offset`
2. 对每个样本做去直流后再求绝对值
3. 用去直流后的 `mean_abs` / `peak_abs` 作为 meter 输入
4. 用面向近场语音的非线性刻度映射到 `0-100`

这使得静默与说话/拍手状态的差异能够在 UI 上明显体现。

### 3.3 display_service

新增：

- `Mic level` label
- `lv_bar`
- `Start/Stop Mic Meter` button
- 独立 `audio_meter` 任务

任务行为：

1. 点击 `Start Mic Meter`
2. 开启 microphone stream
3. 每 `250 ms` 读取一次 PCM
4. 更新 bar 和 metrics label
5. 点击 `Stop Mic Meter`
6. 关闭 stream 并停止任务

同时增加了节流日志，便于串口验证 meter 实际变化。

## 4. 实机验证

### 4.1 构建验证

执行：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py build
```

结果：

- 构建成功

### 4.2 烧录验证

执行：

```sh
idf.py -p /dev/cu.usbserial-10 flash
```

结果：

- 烧录成功
- 板子正常启动到主页面

### 4.3 Mic Meter 实机验证

用户实际操作：

1. 点击 `Start Mic Meter`
2. 对着板载麦克风说话或拍手
3. 点击 `Stop Mic Meter`

用户确认结果：

- 电平条可以接受，已能明显变化
- `Stop Mic Meter` 能正常停住

串口日志样例：

```text
I (...) display_service: mic meter sample=4 level=4% peak=58 mean=22 nonzero=1016
I (...) display_service: mic meter sample=8 level=3% peak=65 mean=19 nonzero=1010
I (...) display_service: mic meter sample=12 level=1% peak=49 mean=10 nonzero=994
I (...) display_service: mic meter sample=16 level=17% peak=702 mean=124 nonzero=1022
I (...) display_service: mic meter sample=20 level=3% peak=59 mean=18 nonzero=1008
```

结论：

- 静默状态与激励状态已能区分
- meter 已可作为后续语音前端的基础诊断能力

### 4.4 回归验证

验证结论：

- `heartbeat` 正常
- 显示与触摸路径未被破坏
- `Play Test Tone` / `Capture Mic Sample` 按钮仍保留
- 未观察到 panic 或循环重启

## 5. 已知边界

- 当前 meter 仍是工程诊断 UI，不是最终产品 UI
- 目前只做了基础电平可视化，还未接入：
  - VAD
  - 唤醒词
  - `ESP-SR`
  - 连续录音缓存管理

## 6. 结论

`M3` 的麦克风电平表功能已完成：

- 页面支持启动/停止 mic meter
- 电平条与指标会随环境声音变化
- 行为已完成实机构建、烧录与交互验证
- 现有 `display/touch/audio` 基线保持稳定
