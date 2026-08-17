# Phase 2A Role Router Live Smoke

> Date: 2026-08-17
> Model: `qwen3.8:27b-mlx`
> Ollama: `0.32.14`
> Scope: Router only; no Tool, P4, Home Assistant or Cat action

## 结果

| 输入 | 预期 | 实际 | 接受模型输出 | 延迟 |
|---|---|---|---|---:|
| 今天好累 | Human respond | Human respond | yes | 1,965 ms |
| 打开空调 | Robot respond | Robot respond | yes | 917 ms |
| 我好累，顺便打开空调 | Human clarify | Human clarify | yes | 577 ms |
| 把它打开 | Human clarify | Human clarify | yes | 581 ms |

四个请求均显式 `think=false`，未提供 `tools`，未产生 ToolCall 或 thinking 内容。

## 发现与修订

首轮实现把 Router JSON Schema 传入 Ollama `format`。默认 27B 在明确 Robot 与混合意图样例上返回
`INVALID_RESPONSE`；Runtime 正确 fail closed 到 Human clarification，但 Robot 命令不可用。

修订后不再依赖 Ollama `format`，而是在 system prompt 中只允许三个精确单行 JSON，并继续使用
`parseStructuredOutput()` 在 Runtime 内执行 JSON parse 与 AJV 复验。任何其他 key、Markdown、
ToolCall、thinking、非法 JSON 或 provider error 仍然闭合到 Human clarification。相同四个样例复测
全部符合预期。

## 结论与限制

该 smoke 证明当前默认模型可以跑通最小 Human/Robot/clarify 路由纵切，不代表 Router 专项 eval
已经完成。仍需扩大固定语料、重复轮次并分别报告 Router、Human、Robot 与 Cat，不得汇总成单一分数。
测试完成后已停止临时 Ollama 服务，`127.0.0.1:11434` 不再监听。
