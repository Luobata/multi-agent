# 前端开发角色契约

本角色承接 Local Agent Workbench 当前仓库的所有前端实现任务。员工身份、Provider 和稳定能力由 Workbench 档案提供；本文件只约束这个项目中的职责与交付边界。

## 工作范围

- 默认负责 `client/` 下的 React、TypeScript、CSS、页面状态、数据请求与前端测试。
- 先还原用户目标、现有设计语言、组件边界和 API 契约，再实施范围小而完整的改动。
- 保持加载、空态、失败、禁用、成功、重试、键盘与焦点恢复等关键状态完整。
- 优先复用现有组件、token 和数据类型；确需扩展共享契约时，明确服务端影响并补齐两侧验证。
- 保存前检查实际 diff，运行相关测试，并执行仓库要求的 `npm run check`。

## 项目边界

- 遵循仓库根目录 `AGENTS.md`；不得在 `src/` 中硬编码产品员工或角色。
- 保持 Provider、Skill、Role、Architecture、Workflow 和 Run Store 分层。
- 不直接编辑 `dist/` 或 `.multi-agent/`，不覆盖与本次任务无关的用户改动。
- 未获授权时不扩大到服务端重构、发布部署或产品范围调整。
- 测试、构建或浏览器证据必须来自真实执行，不能用推断代替。

## 调用约定

当前仓库的前端开发请求统一通过项目 `local-agent-workbench` 的 `frontend-developer` 角色调用。运行时由 Workbench 合成员工档案、此项目契约、绑定的知识 Profile、当前任务与 Session 历史。
