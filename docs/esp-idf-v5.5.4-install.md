# ESP-IDF v5.5.4 Install

## 1. 背景

项目当前在 `M1` 阶段优先推进 `ESP32-P4 EVB` 的本地 bring-up，基线版本固定为 `ESP-IDF v5.5.4`。本机此前已存在多个 `ESP-IDF` 环境，但缺少 `v5.5.4`，因此需要新增一套独立安装。

## 2. 安装结果

已完成以下安装：

- IDF 源码目录：`/Users/andyhao/.espressif/v5.5.4/esp-idf`
- 用户级激活脚本：`/Users/andyhao/.espressif/tools/activate_idf_v5.5.4.sh`
- Python 环境：`/Users/andyhao/.espressif/tools/python_env/idf5.5_py3.14_env`
- 目标安装方式：`install.sh esp32p4`

本次安装与既有环境共存，没有覆盖：

- `v5.5.2`
- `v6.0-beta2`

## 3. 实施说明

### 3.1 版本获取

`v5.5.4` 源码已独立 checkout 到专用目录，未复用项目仓库内的 `firmware/` 目录，也未修改 shell 启动文件。

### 3.2 工具安装

安装过程中已补齐 `esp32p4` 所需工具与依赖，包含：

- `riscv32-esp-elf`
- `riscv32-esp-elf-gdb`
- `openocd-esp32`
- `esp-rom-elfs`
- 对应 Python 包依赖

### 3.3 激活方式

用户级激活入口为：

```sh
. ~/.espressif/tools/activate_idf_v5.5.4.sh
```

项目内统一入口见 [activate-idf-v5.5.4.sh](/Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh)。

## 4. 验证记录

已完成以下验证：

- `idf.py --version` 返回 `ESP-IDF v5.5.4`
- `idf.py --list-targets` 包含 `esp32p4`
- 项目内激活脚本可正确切换到该版本

附加验证情况：

- 对 [firmware](/Users/andyhao/workspace/p4home/firmware) 做过一次 `idf.py set-target esp32p4` 验证
- 流程已成功进入 `cmake` 和子模块初始化阶段
- 首次构建时卡在 `ESP-IDF` 某个按需拉取的蓝牙子模块，不影响 `v5.5.4` 已安装可用的结论

## 5. 已知约束

- 当前安装不修改用户 shell profile，因此每个新 shell 都需要显式激活
- 真实项目构建仍建议通过项目内脚本激活，避免误落到别的 IDF 版本

## 6. 后续建议

- 所有 `firmware/` 构建、烧录、monitor 命令统一先 source 项目脚本
- 下一步优先做一次完整 `firmware/` 构建打通，确认子模块初始化与组件依赖全部稳定
