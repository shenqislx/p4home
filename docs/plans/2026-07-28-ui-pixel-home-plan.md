# Pixel Home 动态首页 Plan

## 1. 背景

现有 `Modes / Energy / Lights / Climate` 页面已经覆盖基础控制与数据展示，但默认入口仍以功能列表为主，缺少能代表产品性格的家庭总览和具有戏剧感的场景反馈。

## 2. 目标

- 新增默认 `HOME` 页面，用像素小屋表达真实家庭状态。
- 继续保留现有精确数据与控制页面，避免牺牲实用性。
- 聚合现有 Home Assistant 实体，展示房间亮灯数、空调和温度状态。
- 没有硬件或 HA 数据时仍呈现完整、明确的等待状态。
- 为快捷模式增加非阻塞的场景导演反馈。

## 3. 范围

包含：

- `Pixel Home` 动态首页。
- 客厅、餐厨、书房、主卧四个房间聚合。
- 昼夜环境、像素角色、轻量待机动画。
- 房间和侧边快捷入口导航。
- 快捷模式发送过程的阶段反馈。

不包含：

- 新增毫米波、RGB 灯带、旋钮或 NFC 硬件。
- 修改 Home Assistant 自动化脚本。
- 将单个 HA script 的提交结果伪装成逐设备执行结果。

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ui_pages/ui_page_home.c`
- `firmware/components/ui_pages/include/ui_page_home.h`
- `firmware/components/ui_pages/ui_pages.c`
- `firmware/components/ui_pages/ui_page_quick_modes.c`
- `firmware/components/ui_pages/CMakeLists.txt`

### 4.2 模块拆解

- Home 页面：房间聚合、环境绘制、角色状态、导航。
- 页面壳：增加 HOME 导航并作为默认页。
- Scene Director：展示“检查连接、发送 HA、等待家庭响应”的真实阶段。

### 4.3 数据流 / 控制流

`panel_data_store` 实体快照 -> 按 group 聚合 -> 房间视觉与全屋摘要。

点击房间 -> 有空调运行时进入 Climate，否则进入 Lights。

点击快捷模式 -> 异步调用 HA script，同时 Scene Director 展示提交阶段 -> 返回成功或失败。

## 5. 实现任务

1. 新增 Home 页面与四个房间视图。
2. 接入实体观察者与动态刷新。
3. 增加昼夜和像素角色动画。
4. 更新导航与默认页。
5. 增强快捷模式反馈。

## 6. 测试方案

### 6.1 构建验证

- 使用 ESP-IDF v5.5.4 执行 `idf.py build`。

### 6.2 功能验证

- 无 HA 时页面完整显示等待状态。
- binary / climate 更新会刷新对应房间。
- 点击房间和侧边按钮可以进入已有页面。
- Scene Director 不阻塞 LVGL 或 HA 请求任务。

### 6.3 回归验证

- Modes / Energy / Lights / Climate 初始化和导航保留。
- 原有页面枚举和诊断文本仍可区分各页面。

### 6.4 硬件/联调验证

- 当前无硬件连接，本轮不执行触摸、屏幕刷新和真实 HA 联调。
- 后续实机重点验证动画刷新成本、触摸命中与中文字体显示。

## 7. 风险

- 大量实体首次同步可能触发密集刷新；Home 页面使用异步合并刷新避免重复重绘。
- UI 视觉只能通过构建检查，最终布局仍需要实机截图确认。
- HA script API 只能证明指令已提交，不能证明场景中的每个设备已执行。

## 8. 完成定义

- 固件构建通过。
- 新 HOME 页面默认显示。
- 现有四页均可导航。
- 无硬件状态不会崩溃或出现空白页。
- 快捷模式反馈准确描述 HA 指令提交阶段。

