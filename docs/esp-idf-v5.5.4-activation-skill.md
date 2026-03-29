# ESP-IDF v5.5.4 Activation Skill

## 1. 背景

项目机器上存在多个 `ESP-IDF` 版本。为了避免后续 agent 在 `firmware/` 构建、烧录或环境检查时误用其他版本，项目内新增了专用激活脚本与本地 skill。

## 2. 固化结果

本次新增：

- 项目内激活脚本：[activate-idf-v5.5.4.sh](/Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh)
- 项目内 skill：[SKILL.md](/Users/andyhao/workspace/p4home/.codex/skills/esp-idf-v5.5.4/SKILL.md)

同时更新：

- [AGENT.md](/Users/andyhao/workspace/p4home/AGENT.md)

## 3. 设计原则

- 仓库内只保留统一入口，不在各处重复硬编码 PATH
- 项目脚本内部复用用户级激活脚本：`/Users/andyhao/.espressif/tools/activate_idf_v5.5.4.sh`
- 任何需要 `idf.py` 的任务，都应先显式激活 `v5.5.4`

## 4. 标准用法

### 4.1 项目内统一激活

```sh
. /Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
```

### 4.2 在 firmware 目录下执行

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
idf.py --version
```

## 5. 验证标准

激活后至少执行：

```sh
idf.py --version
idf.py --list-targets | rg '^esp32p4$'
```

预期结果：

- 版本输出包含 `ESP-IDF v5.5.4`
- target 列表包含 `esp32p4`

## 6. 失败处理

若激活失败，按顺序检查：

1. `/Users/andyhao/.espressif/v5.5.4/esp-idf` 是否存在
2. `/Users/andyhao/.espressif/tools/activate_idf_v5.5.4.sh` 是否存在
3. 当前命令是否使用了 `source`
4. 激活后 `idf.py --version` 是否仍落到其他版本

错误示例：

```sh
/Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
```

正确示例：

```sh
. /Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
```

## 7. 适用范围

以下场景默认使用本 skill：

- `idf.py build`
- `idf.py flash`
- `idf.py monitor`
- `idf.py set-target esp32p4`
- 检查 `firmware/` 的 IDF 环境
