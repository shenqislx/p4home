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
- `riscv32-esp-elf-gcc` 为 `esp-14.2.0_20260121` / GCC 14.2.0
- Python 为 `3.14.3`，CMake 为 `4.2.3`
- 本机未安装 Ninja，本次构建实际使用 `Unix Makefiles` / GNU Make 3.81
- `firmware/dependencies.lock` SHA-256 为
  `f5f93d246735422a250bbb10dabb05338481f1c21556deebb2881e72e2275860`

2026-08-15 已完成一次不复用仓库 build cache 或生成 `sdkconfig` 的全量构建：

```sh
. /Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
idf.py \
  -C /Users/andyhao/workspace/p4home/firmware \
  -B /tmp/p4home-agent-phase0-clean-build-4 \
  -D IDF_TARGET=esp32p4 \
  -D SDKCONFIG=/tmp/p4home-agent-phase0-clean-build-4/sdkconfig \
  build
```

结果：

- `sdkconfig.defaults` 独立生成 C6 + Function Board + SDIO Hosted 配置；
- `p4home_firmware.bin` 为 `1,437,792 bytes`；
- 3 MiB 最小 app 分区剩余约 54%；
- `idf_size.py` 统计 image `1,437,384 bytes`；
- 静态 DIRAM `296,378 / 576,464 bytes`，约 51.41%；
- 未出现 unknown Kconfig 或 attempt-to-assign 警告。

证据摘要见 [Phase 0 build baseline](../evidence/agent-phase-0/build-baseline.md)。

## 5. 已知约束

- 当前安装不修改用户 shell profile，因此每个新 shell 都需要显式激活
- 真实项目构建仍建议通过项目内脚本激活，避免误落到别的 IDF 版本
- ESP-IDF 组件管理器在受限 macOS 沙箱内调用 `sysctl()` 可能得到
  `PermissionError: Operation not permitted`；这是宿主权限限制，不是固件编译错误

## 6. 后续建议

- 所有 `firmware/` 构建、烧录、monitor 命令统一先 source 项目脚本
- CI 或新机器验证应使用新的 build 目录和独立 `SDKCONFIG`，不要把
  `firmware/sdkconfig` 当作可重复构建输入
- 不运行 `idf.py update-dependencies`，除非有独立升级计划和回归验证
