# SDKConfig File Roles

## 1. 背景

随着项目开始实际执行 `idf.py set-target esp32p4`，`firmware/` 目录中已经出现自动生成的 `sdkconfig`。为了避免后续开发和 agent 上下文混淆 `sdkconfig.defaults` 与 `sdkconfig` 的职责，需要在项目文档中明确两者的角色边界。

## 2. 文件角色

### `sdkconfig.defaults`

定位：

- 人工维护的最小默认配置基线

用途：

- 固定项目明确想长期保持的少量默认行为
- 作为 `idf.py` 生成最终配置时的输入基线

维护原则：

- 想固定项目默认行为时，优先修改这个文件
- 只写必要项，避免过早把大量派生配置写死

### `sdkconfig`

定位：

- `ESP-IDF` 自动生成的完整配置快照

生成方式：

- `idf.py set-target`
- `idf.py build`
- `idf.py menuconfig`

用途：

- 反映当前构建实际生效的完整配置
- 展开目标芯片、组件依赖和默认值

维护原则：

- 用来观察当前配置结果
- 当前阶段不把它作为主维护入口

## 3. 当前项目约定

当前项目在 [firmware/README.md](/Users/andyhao/workspace/p4home/firmware/README.md) 和 [AGENT.md](/Users/andyhao/workspace/p4home/AGENT.md) 中已经同步以下约定：

- `sdkconfig.defaults` 是输入基线
- `sdkconfig` 是生成结果
- 后续 agent 在修改配置前，应先判断要改的是“项目默认值”还是“当前构建结果”

## 4. 结果

这次文档更新的目的是降低后续上下文误解，避免把 `sdkconfig` 与 `sdkconfig.defaults` 混为一谈，并减少对配置入口的重复讨论。
