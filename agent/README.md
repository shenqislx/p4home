# P4 Home Agent Runtime

Phase 1 的 TypeScript workspace。当前纵切只运行冻结契约、Core Tool Loop 与 Mock P4 Home
工具；不连接真实 P4、Home Assistant 或 Ollama。

## 环境

- Node.js 24.19 或更新的 Node 24 LTS 版本；
- pnpm 11.19.0；
- 安装脚本 allowlist 仅允许 `esbuild`，用于 `tsx` 测试加载器。

```bash
cd agent
pnpm install --frozen-lockfile
pnpm typecheck
pnpm validate:contracts
pnpm test
```

所有验证入口都会先执行 Node 主版本 preflight，避免 pnpm 管理进程与实际 Runtime 使用不同
Node 主版本时产生假通过。

## 当前分层

- `apps/runtime`：进程入口与健康状态；
- `packages/contracts`：AJV 加载并验证仓库根目录冻结的两份 v1 契约；
- `packages/core`：核心实体类型、取消、相对 timeout、最多四项的顺序 Tool Loop；
- `packages/domain-p4home`：无需真实设备的五工具 Mock 与 allowlist；
- `packages/provider-ollama`：Ollama capability 边界，具体 adapter 待实现；
- `packages/storage-sqlite`：审计存储接口，SQLite 实现待补充。

Phase 1 不得导入真实 P4 WebSocket 执行链，也不得把 token 暴露给模型或日志。
