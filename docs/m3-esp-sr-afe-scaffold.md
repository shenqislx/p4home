# M3 ESP-SR AFE Scaffold

## 1. 背景

在 `M3` 的音频 codec bring-up 和麦克风电平表完成后，项目已经具备：

- 板载麦克风输入
- 扬声器 codec 路径
- 连续采样与基础音频诊断能力

下一步需要进入本地语音前端，但不应直接跳到唤醒词。  
更稳妥的顺序是先把 `ESP-SR` 依赖、`AFE` 配置入口和运行前检查接入工程。

## 2. 本次交付

- 接入 `espressif/esp-sr` managed component
- 固定依赖版本为 `2.1.4`
- 新增 `sr_service` 组件
- 在启动阶段输出 `ESP-SR AFE` 的预检查结果
- 将 `sr_service` 接入 `board_support` 与启动日志

## 3. 实现说明

### 3.1 依赖接入

在 [idf_component.yml](/Users/andyhao/workspace/p4home/firmware/components/sr_service/idf_component.yml) 中固定：

- `espressif/esp-sr = 2.1.4`

实际构建时，组件管理器已成功解析并下载：

- `espressif__esp-sr`
- 其依赖 `espressif/dl_fft`
- `espressif/esp-dsp`

这说明 `ESP-SR` 已经进入固件真实构建链路，不再是占位依赖。

### 3.2 sr_service 的职责

[sr_service.c](/Users/andyhao/workspace/p4home/firmware/components/sr_service/sr_service.c) 当前负责：

- 确认 `ESP-SR` 依赖已接入
- 确认麦克风链路是否 ready
- 调用 `esp_srmodel_init("model")` 检查模型分区
- 调用 `afe_config_init("MR", ...)` 进行 `AFE` 配置预检查
- 调用 `esp_afe_handle_from_config(...)` 检查 `AFE` 接口句柄是否可获取

当前仍未做：

- `AFE feed/fetch` 运行时循环
- WakeNet
- MultiNet
- 语音动作映射

### 3.3 输入格式

当前固定使用：

- `input_format = "MR"`

含义：

- `M`：板载麦克风通道
- `R`：播放参考通道

这是当前单麦语音前端的合理初始输入格式。

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

- `ESP-SR 2.1.4` 已真实进入 components 列表
- 工程构建成功

### 4.2 烧录验证

执行：

```sh
idf.py -p /dev/cu.usbserial-10 flash
```

结果：

- 烧录成功
- 板子正常启动

### 4.3 启动日志验证

实机日志关键片段：

```text
E (...) MODEL_LOADER: Can not find model in partition table
I (...) sr_service: preflight dependency_declared=yes microphone_ready=yes models_available=no model_count=0 input_format=MR model_path=model afe_config_ready=no afe_ready=no
I (...) sr_service: status=model partition 'model' not found
I (...) p4home_main: sr service dependency_declared=yes afe_config_ready=no afe_ready=no
I (...) p4home_main: sr service models_available=no model_count=0 status=model partition 'model' not found
```

结论：

- `ESP-SR` 依赖接入成功
- `sr_service` 已经进入启动路径
- 当前失败点已被精确收敛到：
  - 项目还没有 `model` 分区
  - 因而 `esp_srmodel_init("model")` 无法找到模型
  - `AFE` 尚未进入 ready 状态

这个结果是符合预期的，不属于异常回退。

### 4.4 回归验证

验证结论：

- 显示链路保持正常
- 触摸链路保持正常
- 音频 codec 基线未被破坏
- 启动后未出现 panic 或重启

## 5. 当前边界

本次完成的是：

- `ESP-SR` 工程接入
- `AFE` 预检查

本次还未完成的是：

- `model` 分区
- 模型文件 staging
- `AFE` 真正运行
- 唤醒词与命令词

## 6. 结论

`M3` 的 `ESP-SR AFE scaffold` 已完成：

- 依赖已接入
- `sr_service` 已落地
- 启动日志能明确输出 `AFE` 预检查状态
- 当前工程可稳定构建、烧录和启动

下一个合理动作是：

- 建立 `ESP-SR model partition + model staging`
