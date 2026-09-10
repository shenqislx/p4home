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
- `sdkconfig`：`idf.py` 生成的完整配置快照
- `partitions.csv`：分区表

配置文件说明：

- `sdkconfig.defaults`：人工维护的最小默认配置。这里只放项目明确想固定的少量基线项。
- `sdkconfig`：由 `idf.py set-target`、`idf.py build`、`menuconfig` 等流程生成或更新的完整配置结果，会展开目标芯片和组件依赖的默认值。

维护原则：

- 想固定项目默认行为时，优先修改 `sdkconfig.defaults`
- 想看当前构建实际使用了哪些配置时，查看 `sdkconfig`
- 不要把 `sdkconfig` 当作当前阶段的主维护入口

WebSocket 兼容性修复：

- 固定 ESP-IDF v5.5.4 的 `transport_ws.c` 会保存 HTTP Upgrade 响应之后的 WebSocket 字节，
  但 poll/read-header 两个入口仍只等待底层 socket，可能让 HA 的首个 `auth_required` 停在
  缓存中，直到握手超时。
- `cmake/ws-buffer-readiness.cmake` 在构建目录生成修复副本，并替换该 target 的对应源文件；
  不修改全局 SDK 或 managed components。缓存非空时直接继续读取，缓存为空时沿用原语义。
- `scripts/patch-idf-ws-buffer.py` 校验受测上游文件 SHA-256；升级 SDK 或文件变化时构建拒绝
  自动套用旧补丁，需重新 review。确定性回归：
  `python3 -m unittest tests.harness.test_ws_buffer_readiness`（仓库根目录，需本机 ESP-IDF 源码）。

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
