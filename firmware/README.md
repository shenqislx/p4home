# Firmware

本目录承载 `p4home` 的 `ESP-IDF` 固件工程。

当前目标：

- 建立最小可扩展工程骨架
- 为 `M1` 本地底座 bring-up 提供落点
- 为后续 `LVGL`、`ESP-SR`、网络与板级驱动提供模块边界

当前结构：

- `main/`：启动入口
- `components/`：按功能拆分的业务组件
- `sdkconfig.defaults`：默认配置基线
- `partitions.csv`：分区表

后续优先开发顺序：

1. `board_support`
2. `diagnostics_service`
3. `display_service`
4. `touch_service`
5. `audio_service`
6. `sr_service`

构建前提：

- 本机已安装 `ESP-IDF`
- `IDF_PATH` 已配置
- 使用 `idf.py` 在本目录执行构建

常用命令：

```bash
cd firmware
idf.py set-target esp32p4
idf.py build
```

