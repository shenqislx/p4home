# M3 ESP-SR AFE Runtime Selftest

## 1. 背景

在 [m3-esp-sr-model-partition-staging.md](/Users/andyhao/workspace/p4home/docs/m3-esp-sr-model-partition-staging.md) 完成后，工程已经具备：

- `model` 分区
- `srmodels.bin` 打包与烧录链路
- 启动期 `VERIFY:sr:models`
- 启动期 `VERIFY:sr:afe_preflight`

但当时 `sr_service` 仍只停留在：

- `esp_srmodel_init("model")`
- `afe_config_init("MR", ...)`
- `esp_afe_handle_from_config(...)`

也就是说，`AFE` 只是“可创建”的预检查通过，还没有证明真实的 `feed/fetch` runtime 路径已经走通。

## 2. 本次交付

- 在 [sr_service.c](/Users/andyhao/workspace/p4home/firmware/components/sr_service/sr_service.c) 中增加最小 `AFE runtime selftest`
- 在 [audio_service.c](/Users/andyhao/workspace/p4home/firmware/components/audio_service/audio_service.c) 中补充原始麦克风 sample 读取接口
- 在 [sr_service.h](/Users/andyhao/workspace/p4home/firmware/components/sr_service/include/sr_service.h) 中扩展 runtime 状态字段
- 在 [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c) 中新增 `VERIFY:sr:afe_runtime`
- 完成一次本地真实 `flash + serial capture` 验证

## 3. 实现说明

### 3.1 runtime selftest 的边界

`sr_service_init()` 现在不再只做 `AFE` preflight，还会执行一次最小 runtime 自检：

1. 创建 `afe_data`
2. 查询 `feed_chunksize` / `fetch_chunksize`
3. 打开 microphone stream
4. 连续读取少量 PCM frame
5. 按当前 `input_format = "MR"` 组装 AFE 输入
6. 调用 `afe->feed(...)`
7. 调用 `afe->fetch_with_delay(...)`
8. 若拿到非空输出数据，则标记 `afe_runtime_ready=yes`

这里的目标不是开始长期语音循环，而是先证明：

- 麦克风输入可送进 `ESP-SR AFE`
- `AFE` 能完成至少一次真实 `feed/fetch`

### 3.2 audio_service 的配合改动

为避免 `sr_service` 直接持有 codec 细节，这次在 [audio_service.h](/Users/andyhao/workspace/p4home/firmware/components/audio_service/include/audio_service.h) 中新增了：

```c
esp_err_t audio_service_read_microphone_samples(
    int16_t *samples,
    size_t sample_count,
    audio_service_microphone_snapshot_t *snapshot);
```

这样 `sr_service` 可以复用现有 microphone open/read/close 路径，但只拿到自己需要的原始 sample。

### 3.3 一次实际踩到的回归

这轮开发中曾把 `1024` sample buffer 改成局部栈数组，结果实机启动时在 `main` 任务触发了 `Stack protection fault`。

最终修复方式是恢复静态 capture buffer，而不是在启动路径上继续堆栈分配大块 PCM 缓冲。

这次回归说明：

- 音频和语音启动链路虽然逻辑简单，但对 `main` 任务栈余量比较敏感
- 后续若继续做 runtime loop，应优先复用静态缓冲或堆分配

## 4. 本地实机验证

### 4.1 构建与烧录

执行：

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

### 4.2 artifact

本地验证 artifact：

- [hardware-validation-manifest.json](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-afe-runtime-selftest/hardware-validation-manifest.json)
- [monitor.log](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-afe-runtime-selftest/monitor.log)

### 4.3 关键日志

串口日志确认：

```text
sr_service: preflight ... afe_ready=yes afe_runtime_ready=yes feed_chunksize=512 fetch_chunksize=512 feed_frames=1 fetch_frames=1
p4home_main: VERIFY:sr:models:PASS
p4home_main: VERIFY:sr:afe_preflight:PASS
p4home_main: VERIFY:sr:afe_runtime:PASS
```

这说明本地板卡上已经真实证明：

- 模型已加载
- `AFE` 预检查通过
- 最小 `feed/fetch` runtime 路径通过

## 5. 当前残留问题

日志中仍然保留一条 `i2s_channel_disable(...): the channel has not been enabled yet`。

结合本轮结果，它当前不会阻塞：

- `audio` startup selftest
- `sr` preflight
- `sr` runtime selftest

所以它仍然属于已知时序噪声，而不是这次功能的失败条件。

## 6. 结论

`M3` 的 `ESP-SR AFE runtime selftest` 已完成：

- `AFE` 已从“可初始化”推进到“可真实 feed/fetch”
- 本地硬件串口日志已具备 `VERIFY:sr:afe_runtime:PASS`
- 语音链路已经不再只是构建级或初始化级验证

下一个合理动作是：

- 将 `AFE` 从启动期自检推进到持续 runtime loop
- 明确音频 owner 模型，避免后续 `audio_service` 与 `sr_service` 争用同一套 codec/I2S 资源
