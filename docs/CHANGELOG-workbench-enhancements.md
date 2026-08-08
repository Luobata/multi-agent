# Changelog — Workbench 能力增强批次（#1–#5）

系统员工概念、小关、被动接入可视、设计风格沉淀、worktree 执行隔离——五项改进外加一处文档修正。基于真实 git 历史。

> 范围：`903fa1e..301bc2f`（memory changelog 之后）。累计 47 文件，约 +3700 行（含设计/计划/文档与测试）。
> 每项都走 brainstorm → spec → plan → 子代理逐任务实现+review → 整分支 review → 合并；全量 `npm run check` 每次合并前后验证 exit 0。

---

## 0. Memory gate 状态词修正 — `44ed4a3`

`docs/memory-system.md` 的价值 gate 描述从 `completed` 修正为 runner 真实的 `passed`（代码早已用 passed，文档滞后）。

## 1. 系统员工一等概念 — `8408f92`

把"系统员工"从纯 metadata 标注升级为一等概念。

- `EmployeeDefinition.systemRole?: "automatic" | "conversational"`（缺省 = 业务员工）+ helper `isSystemEmployee`/`systemRoleOf`。
- 四类约束：UI 分区（复用现有系统区）、禁绑定为项目角色/禁发布、禁人工直调（automatic；内部 `system:` caller 豁免，保护小忆自动提炼）、软保护编辑归档（`allowSystemEmployeeMutation` 显式确认可改）。
- automatic 守卫下沉到唯一汇聚点 `invokeResolvedEmployee`（覆盖 invokeEmployee/invokePinnedEmployee/invokeProjectRole 全部入口）。
- 迁移小忆=automatic、小配/小知=conversational。

## 2. 小关 (Gate Steward) 全实现 — `a594980`

实现此前 deferred 的小关：对话式 gate 配置控制员工 + 完整审批链。

- `WorkflowChangeRequest` 类型 + state；service 审批链 create→approve/reject→**apply（经 updateWorkflow，不绕过 gate 校验；stale 版本拒绝）**，镜像 knowledge-change。
- 操作集：add/update/remove-gate（各带 rationale+risk）；apply 同时维护 gate stage。
- `gate-control-conversation` skill + `workflow_change_*` MCP 工具 + daemon 路由 + CLI（人工审批入口）。
- 小关员工模板（conversational 系统员工）+ `codex-gate-control` seeded 系统 provider。
- 只读查看 UI（无 approve/apply 按钮，审批走 CLI/HTTP）。

## 3. 被动接入项目的员工关系可见 — `0176107`

查清后收窄为 UI 抛光：被动(MCP)接入本与主动同源，linked 项目的员工关系已在详情面板可见。

- MCP-linked 的项目卡片列表内联显示已分派员工名（而非只显计数），"MCP 接入 → 哪些员工"一眼可见。

## 4. 设计风格沉淀 — `b93c760`

把设计风格沉淀成可复用形态：可注入指令入 Skill，参考资料复用现有知识库。

- `design-style-futaba` skill：从 design.md 提炼的可注入视觉指令（配色 token/字体/2px 硬边/皮肤切换/无障碍）。员工绑定即获得整套风格语言。
- 参考资料归入已有 `local-agent-workbench` 知识库的 design collection（不新建重复库）。
- docs/design-language.md 说明沉淀与复用。

## 5. Worktree 执行隔离 — `301bc2f`

supervisor 的 Management Policy 可声明在 git worktree 中隔离执行大型任务。

- `ManagementPolicyDefinition.execution?.isolation="worktree"`；新 `src/runtime/worktree.ts`（isGitRepo/create/remove，execFile 无 shell 注入）。
- 运行时在 `runTrackedWorkflow` 建 worktree（仓内 `.multi-agent/worktrees/<runId>`）作 providerCwd、运行后 finally 自动拆；非 git 仓回退不隔离。
- **worktree 故障不冒泡主链路；artifacts 不进 worktree**（artifactRoot 用 dataRoot）。
- Run.isolation 证据 + 运行卷宗展示隔离状态（worktree 路径/普通/回退原因）。

---

## 过程中的关键决策与纠正（如实记录）

- **#3 范围纠正**：原设想改数据模型，查证后发现被动/主动同源、关系已可见 → 收窄为 UI 抛光，避免白做大功能。
- **#4 避免重复**：发现已有 design collection，只做真正缺的 skill，参考资料复用现有库。
- **#5 如实上报体量**：代码库原无 git worktree 机制，明确这是大后端功能而非加字段，确认后才做。
- **拆分坚持**：#2 小关本可与 #1 同轮，因体量大坚持拆为独立周期，各自做深。

## 已知非阻塞项（parked）

- 小关 MCP 白名单契约测试（GS-T5 minor）；worktree service.ts:2193-2234 minor。均经整分支 review 判为非阻塞。
