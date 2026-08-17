# Agent Phase 3 — Object-level World Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2 complete

## 1. 目标

在 Cat 房间级闭环稳定后，引入 sofa、desk、window 等对象锚点，使 Cat 的
`sit/look_at/interact` 成为真实可执行语义动作；不扩大 Robot/Human 权限。

## 2. 实施步骤

1. 定义 object registry、stable object id 与 room ownership；
2. 为对象配置 anchor、supported_actions、availability 和 animation binding；
3. 扩展导航、朝向、占用与失败条件；
4. 仅向 Cat RoleProfile 实现 `go_to/sit/look_at/interact`；
5. 扩展 capabilities 与 Tool Schema；
6. 增加对象不存在、不支持动作、被占用和中途取消测试；
7. 用归一化 Cat event 在 simulator 与实机验证 `go_to(sofa) → sit`，不把用户原文直接路由给 Cat；
8. 回归 Human/Robot 无法看到或调用对象级 Cat Tool。

## 3. 完成定义

- [ ] 模型不接触坐标即可稳定完成对象动作；
- [ ] capabilities 与真实执行能力一致；
- [ ] 对象级失败可被 Agent 正确观察；
- [ ] 对象级能力只属于 Cat，跨角色越权测试通过；
- [ ] 用户 review 通过后启动 Phase 4。
