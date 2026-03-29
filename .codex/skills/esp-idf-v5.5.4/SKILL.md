# ESP-IDF v5.5.4 Activation

## 何时使用

当任务涉及以下任一情况时，先使用本 skill：

- 运行 `idf.py`
- 构建、清理、烧录或监视 `firmware/`
- 需要确认当前 shell 使用的是项目指定的 `ESP-IDF v5.5.4`
- 需要避免误用本机其他已安装的 `ESP-IDF` 版本

## 项目约束

本项目当前固定使用：

- `ESP-IDF v5.5.4`
- 目标芯片：`esp32p4`

不要默认使用本机其他 IDF 版本，即使它们已经安装。

## 标准做法

在任何需要 `idf.py` 的 shell 命令前，先 source 项目内激活脚本：

```sh
. /Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
```

如果命令要在 `firmware/` 目录执行，推荐合并成一条 shell：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
idf.py --version
```

## 验证要求

激活后至少执行以下校验：

```sh
idf.py --version
idf.py --list-targets | rg '^esp32p4$'
```

预期结果：

- 版本输出包含 `ESP-IDF v5.5.4`
- target 列表包含 `esp32p4`

## 实现细节

项目内统一入口是：

- `/Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh`

该脚本内部会复用用户级激活脚本：

- `/Users/andyhao/.espressif/tools/activate_idf_v5.5.4.sh`

不要在 agent 命令里重复手写复杂 PATH。优先复用项目脚本。

## 失败处理

如果激活失败，按顺序检查：

1. `/Users/andyhao/.espressif/v5.5.4/esp-idf` 是否存在
2. `/Users/andyhao/.espressif/tools/activate_idf_v5.5.4.sh` 是否存在
3. `idf.py --version` 是否仍然落到别的版本
4. 当前命令是否用了“执行脚本”而不是“source 脚本”

错误示例：

```sh
/Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
```

正确示例：

```sh
. /Users/andyhao/workspace/p4home/scripts/activate-idf-v5.5.4.sh
```
