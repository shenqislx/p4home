# Phase 2C P4 World Service & UI Separation Evidence

> Date: 2026-08-18
> Firmware: ESP-IDF v5.5.4 / ESP32-P4
> Host: macOS, CMake, Node.js 24.19.0
> Real transport / hardware flash: 未执行，属于 Phase 2D

## 验收范围

本纵切新增 P4 `world_service`，由它持有 Cat 的 room、activity、active action 和单调
`state_version`。`ui_home_actor` 的公开语义修改入口已移除，只接收复制的 World snapshot 并维护
行走帧、目标坐标等纯渲染状态。本地 HA fallback policy 也迁入 `world_service`；Agent 在线时不参与
决策，Agent 离线时继续依据现有 HA 汇总驱动角色，未修改 HA 客户端与触控跳转链路。

动作执行层支持冻结 v1 的五个 Tool、容量 8 的总 in-flight 队列、accepted/started/terminal 生命周期、
取消、相对 deadline、`action_id` 冲突检测和至少 600000 ms 的终态幂等保留。128 条动作记录从 P4
PSRAM 分配，避免占用内部 BSS；PSRAM 不可用时初始化 fail-closed。

## 退出门禁

| 门禁 | 结果 | 证据 |
|---|---:|---|
| 五个 Cat Tool 完整生命周期 | 通过 | host test 依次运行 get_state/go_to_room/set_activity/say/get_snapshot |
| 队列总容量 8 | 通过 | 同时包含 started action 时，第 9 个 in-flight 请求稳定返回 QUEUE_FULL |
| cancel / accepted deadline / started deadline | 通过 | 显式 due sweep 可在不启动动作时回收全部过期 accepted；started deadline 也得到稳定 failed 终态并清除 active action |
| duplicate / action_id conflict | 通过 | 相同请求返回缓存终态且无 state_version 变化；不同参数返回 ACTION_ID_CONFLICT |
| 10 分钟终态保留与容量保护 | 通过 | 128 条记录满时 fail-closed；TTL 到达后可裁剪并重新接受 |
| v1 UTF-8 文本边界 | 通过 | 256 个中文字符成功；257 个字符拒绝；UI 对完整 v1 文本分页且不切断 UTF-8 code point，相同文本的新 revision 会重新播放 |
| UI 不持有房间语义真值 | 通过 | actor public API 仅 create/apply_snapshot/create_dialog，契约测试阻止语义 mutator 回流 |
| Agent 离线 fallback | 通过 | host test 与像素 simulator 验证离线 HA policy；Agent 在线时 fallback 不覆盖 snapshot |
| 多消费者准备 | 通过 | observer 有界为 4，重复注册幂等，为 2D transport 与 UI 同时订阅保留边界 |

## 验证结果

纯 World Service host target 使用 `-Wall -Wextra -Werror`：

```text
cmake -S sim -B /private/tmp/p4home-world-service-test-only \
  -G "Unix Makefiles" -DP4HOME_WORLD_SERVICE_TEST_ONLY=ON
cmake --build /private/tmp/p4home-world-service-test-only -j4
ctest --test-dir /private/tmp/p4home-world-service-test-only --output-on-failure

1/1 world_service_host_test passed
```

冻结协议与 UI 分层契约：

```text
python3 -m unittest discover -s tests/contract -p 'test_*.py' -v
Ran 34 tests
OK
```

完整 Pixel Home simulator 构建、同一状态机测试与 3 帧 headless smoke 通过；启动日志包含：

```text
VERIFY:ui:pixel_home:PASS rooms=6 groups=12 grid=4px
ui_actor say: 信号断了…先打个盹
```

Agent Phase 2A/2B 回归：

```text
Node 24.19.0
tsc --noEmit -p tsconfig.json: exit 0
tests 111, pass 111, fail 0
```

ESP-IDF v5.5.4 干净临时目录构建在发现静态记录导致内部 RAM 链接溢出后，改为 PSRAM 分配并重新
构建成功：

```text
p4home_firmware.bin size: 0x162420
smallest app partition: 0x300000
free: 0x19dbe0 (54%)
```

## 结论与后续边界

Phase 2C host 与固件编译退出门禁满足，可以进入 2D Real Transport & Hardware Gate。当前没有真实
Device WebSocket、WSS 鉴权、断线两小时、实机连续 100 次动作、8 FPS 或堆栈/heap 运行期证据；
这些不能由 host snapshot 或本次固件链接结果替代，必须在 2D 单独采集。
