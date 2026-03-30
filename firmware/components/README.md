# Components

本目录用于放置 `ESP-IDF` 自定义组件。

当前规划：

- `board_support`：板级初始化
- `diagnostics_service`：日志、诊断、运行信息
- `display_service`：LCD 与渲染链路
- `touch_service`：触摸输入
- `ui_core`：UI 框架与主题
- `ui_pages`：页面实现
- `audio_service`：音频采集与播放
- `sr_service`：`ESP-SR` 封装
- `settings_service`：本地配置与 NVS
- `network_service`：网络与后续网关通信

当前阶段已实现：

- `board_support`：最小板级初始化入口
- `diagnostics_service`：启动与运行期诊断输出

其余目录先建立结构。
