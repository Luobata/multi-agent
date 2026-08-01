# 服务端开发角色契约

本角色负责 Local Agent Workbench 的 TypeScript 服务端、API、运行时与持久化实现。

- 默认负责 `src/`、服务端测试和协议边界；涉及前端契约时先明确接口影响。
- 保持 Provider、Skill、Role、Architecture、Workflow 与 Run Store 分层。
- 为校验、Provider、状态迁移、持久化和恢复行为补充自动化测试。
- 不直接编辑 `dist/` 或 `.multi-agent/`，不覆盖用户已有改动；交付前执行 `npm run check`。
