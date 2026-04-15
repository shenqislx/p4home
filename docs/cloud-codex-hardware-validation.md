# Cloud Codex Hardware Validation

## Summary

本项目的硬件验证采用两段式职责划分：

- GitHub Actions 负责 `build -> flash -> serial capture -> artifact upload`
- 云端 Codex 负责读取 artifact，并根据当前任务目标判断是否通过

这意味着 GitHub Actions 的成功只表示“硬件执行链路成功”，不表示“功能已经通过业务验收”。

当前本地 Codex skill 名称：

- `$p4home-hardware-validation`

该 skill 用于让云端 Codex 在进入 `p4home` 仓库的硬件验证任务时，直接按同一套 artifact-first 协议工作。

仓库内同步副本：

- [SKILL.md](/Users/andyhao/workspace/p4home/.codex/skills/p4home-hardware-validation/SKILL.md)

如果云端 Codex 所在环境无法直接看到本机 `$CODEX_HOME/skills`，应从本仓库安装该 skill 到它自己的 `CODEX_HOME/skills`。

推荐安装方式：

1. 在云端 Codex 中使用预装的 `$skill-installer`
2. 从 GitHub repo `shenqislx/p4home` 安装路径 `.codex/skills/p4home-hardware-validation`

逻辑上等价于：

```sh
python3 install-skill-from-github.py \
  --repo shenqislx/p4home \
  --path .codex/skills/p4home-hardware-validation
```

## Workflow

入口 workflow：

- [firmware-self-hosted-flash-serial.yml](/Users/andyhao/workspace/p4home/.github/workflows/firmware-self-hosted-flash-serial.yml)

该 workflow 运行在带以下标签的 self-hosted runner 上：

- `self-hosted`
- `macOS`
- `ARM64`
- `esp32-p4`

## Artifact Contract

workflow 会上传一个统一 artifact：

- Artifact name: `esp32-p4-monitor-log`

artifact 内至少包含两个文件：

- `firmware/monitor.log`
- `firmware/hardware-validation-manifest.json`

其中：

- `monitor.log` 保存 build、flash、以及串口采集原始输出
- `hardware-validation-manifest.json` 保存本次执行的结构化元数据

## Manifest Schema

当前 manifest 字段：

```json
{
  "schema_version": 1,
  "mode": "artifact-only",
  "verdict_owner": "cloud-codex",
  "git_sha": "<commit sha>",
  "run_id": "<github run id>",
  "run_attempt": "<github run attempt>",
  "job": "flash-and-monitor",
  "serial_port": "/dev/cu.usbserial-10",
  "monitor_seconds": 20,
  "log_file": "monitor.log"
}
```

字段语义：

- `mode=artifact-only` 表示 workflow 不做功能业务裁决
- `verdict_owner=cloud-codex` 表示最终通过/失败由云端 Codex 解释

## Minimal Workflow Verdict

workflow 只在以下基础失败场景返回失败：

- checkout / build / flash 失败
- 串口采集脚本运行失败
- `monitor.log` 缺失或为空
- artifact 上传失败

workflow 不再负责：

- 固定业务日志断言
- 某个功能改动是否真正生效
- 某个测试目标的 `PASS/FAIL` 解释

## Cloud Codex Decision Model

云端 Codex 的推荐读取顺序：

1. 下载 artifact
2. 读取 `hardware-validation-manifest.json`
3. 确认本次 run 的 `git_sha`、串口、采集时长符合预期
4. 读取 `monitor.log`
5. 根据当前任务目标解释日志并给出 `PASS/FAIL`

建议把功能判断放在任务上下文里，而不是 GitHub Actions 里。例如：

- 某个改动要求日志出现新配置项
- 某个改动要求启动流程进入某个 service
- 某个改动要求错误日志消失

这些都应由云端 Codex 根据当前任务动态解释，而不是把所有规则预写在 workflow 中。

## Recommended Firmware Logging

虽然 workflow 不负责裁决，但固件仍然建议输出稳定的、面向机器的验证标记，例如：

```text
VERIFY:touch:init:PASS
VERIFY:wifi:connect:FAIL reason=timeout
VERIFY:settings:migration:PASS
```

这样可以显著降低云端 Codex 解析串口日志的歧义。

## Future Extensions

如果后续需要把 Codex 的判定再反馈到 GitHub，可在此协议之上追加：

- PR comment 回写
- commit status / check run 回写
- workflow_dispatch 输入 `verification_case`
- 多轮硬件验证矩阵
