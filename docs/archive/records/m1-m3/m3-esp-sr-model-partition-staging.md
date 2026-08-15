# M3 ESP-SR Model Partition And Staging

## 1. 背景

在 [m3-esp-sr-afe-scaffold.md](/Users/andyhao/workspace/p4home/docs/m3-esp-sr-afe-scaffold.md) 完成后，`ESP-SR` 依赖和 `AFE` 预检查入口已经进入工程，但当时启动日志仍然停在：

- `model partition 'model' not found`
- `models_available=no`
- `afe_ready=no`

问题不在 `sr_service` 本身，而在更底层的模型交付链路：

- partition table 没有 `model` 分区
- `esp-sr` 组件没有可打包的模型目标
- `idf.py flash` 只会烧应用镜像，不会额外烧录 `srmodels.bin`

## 2. 本次交付

- 在 [partitions.csv](/Users/andyhao/workspace/p4home/firmware/partitions.csv) 中新增 `model` 分区
- 在 [sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults) 中固定 `ESP-SR` 最小模型选择
- 确认 `idf.py reconfigure build` 会生成 `build/srmodels/srmodels.bin`
- 确认 `idf.py flash` 输出已包含 `0x710000 build/srmodels/srmodels.bin`
- 在 [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c) 中新增 `VERIFY:sr:*` 标记

## 3. 实现说明

### 3.1 model 分区

[partitions.csv](/Users/andyhao/workspace/p4home/firmware/partitions.csv) 现在增加：

```csv
model,    data, spiffs,  ,         4M,
```

构建后实际 partition table 为：

```text
storage,data,spiffs,0x610000,1M,
model,data,spiffs,0x710000,4M,
```

这里将 `model` 放在 `ota_1` 和 `storage` 之后，保留现有双 OTA 与通用存储布局，同时给后续 WakeNet / MultiNet 扩展留出余量。

### 3.2 最小模型选择

[sdkconfig.defaults](/Users/andyhao/workspace/p4home/firmware/sdkconfig.defaults) 当前固定：

- `CONFIG_MODEL_IN_FLASH=y`
- `CONFIG_SR_NSN_WEBRTC=y`
- `CONFIG_SR_VADN_WEBRTC=y`
- `CONFIG_SR_WN_WN9_HIESP=y`
- `CONFIG_SR_MN_CN_NONE=y`
- `CONFIG_SR_MN_EN_NONE=y`

这组配置的目标不是一次引入完整语音命令系统，而是先保证：

- `model` 分区不为空
- `esp_srmodel_init("model")` 能看到至少一个模型
- `AFE` 预检查可以从“分区缺失”推进到“模型已挂载”

当前选用 `wn9_hiesp`，只是为了建立 `M3` 的模型交付基线，不代表最终产品唤醒词决策。

### 3.3 模型打包与烧录链路

`espressif/esp-sr` 组件自身在其 `CMakeLists.txt` 中已经内置：

- 从 partition table 读取 `model` 分区
- 调用 `model/movemodel.py` 根据 `sdkconfig` 收集模型
- 生成 `build/srmodels/srmodels.bin`
- 将 `srmodels.bin` 挂到 `flash` 目标

因此项目侧不需要额外编写自定义打包脚本，只需要：

1. 提供 `model` 分区
2. 在 `sdkconfig` 中选中至少一组模型

### 3.4 启动日志标记

[app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c) 新增：

```text
VERIFY:sr:models:<PASS|FAIL>
VERIFY:sr:afe_preflight:<PASS|FAIL>
```

这样后续硬件 artifact 不仅能看到原始 `sr_service` 文本状态，还能直接用机器可读标记做裁决。

## 4. 本地验证

### 4.1 构建命令

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py reconfigure build
```

### 4.2 关键结果

构建输出确认：

- `Move and Pack models...`
- `Recommended model partition size: 285K`
- partition table 中存在 `model,data,spiffs,0x710000,4M,`
- `build/srmodels/srmodels.bin` 已生成，大小约 `284K`

`idf.py` 给出的烧录命令也已经自动包含：

```text
0x710000 build/srmodels/srmodels.bin
```

这说明模型镜像已经进入真实 `flash` 链路，而不是停留在构建期占位。

## 5. 当前注意事项

### 5.1 现有工作树的 sdkconfig 刷新

本仓库的 `firmware/sdkconfig` 在 `.gitignore` 中，不受版本控制。

这意味着：

- 新工作树在没有旧 `sdkconfig` 的情况下，会直接吃到 `sdkconfig.defaults` 新值
- 已经存在旧 `firmware/sdkconfig` 的工作树，可能保留旧的 WakeNet 选择

如果你在已有工作树里没有看到 `CONFIG_SR_WN_WN9_HIESP=y`，需要执行一次：

```sh
cd /Users/andyhao/workspace/p4home/firmware
idf.py reconfigure
```

必要时删除本地 `firmware/sdkconfig` 后再重新生成。

### 5.2 这一步还没证明的内容

本次已经证明：

- 模型分区存在
- 模型镜像已生成
- `flash` 链路会烧模型

本次还没证明：

- 实机启动后 `VERIFY:sr:models:PASS`
- 实机启动后 `VERIFY:sr:afe_preflight:PASS`
- `AFE feed/fetch` 运行时链路稳定

这些仍需要下一轮真实板卡烧录和串口日志验证。

## 6. 结论

`M3` 的 `model partition + model staging` 底座已经落地：

- 工程有了稳定的 `model` 分区
- `ESP-SR` 模型已进入 `build/flash` 链路
- 启动日志具备新的 `sr` 机器可读验证标记

下一个合理动作是：

- 执行一次真实 `flash + serial capture`
- 确认 `model partition 'model' not found` 已消失
- 再决定继续做 `AFE` runtime loop，还是直接推进唤醒词状态机
