# 小关 (Gate Steward) 全链实现设计

状态：设计待评审
日期：2026-08-08
主题：实现此前 deferred 的小关——对话式 gate 配置控制员工 + WorkflowChangeRequest 审批链 + 只读查看 UI

## 1. 背景

`2026-08-06-e2e-validation-constraint-design.md` 设计了小关但标 deferred：一个 project-internal 控制员工，通过受限 skill 发出 WorkflowChangeRequest（增/改/删 supervisor gate），经人工审批后 apply。现在系统员工框架已就绪（`systemRole`），小关正好作为 `conversational` 系统员工落地。

镜像对象：现有 knowledge-change 审批链（`createKnowledgeChangeRequest`/`approve`/`reject` + `applyKnowledgeChangeOperation`，service.ts:3098/3120/3179/3243）与 `state.knowledgeChangeRequests`（types.ts:720）。

真实 gate 结构 `SupervisorGate`（types.ts:207）：`{ id, requiredCapability, mode, required, instructions, fallback, validatorId? }`。gate 挂在 supervisor workflow 的 `flow.gates`（types.ts:265）。

## 2. 数据类型

```ts
type WorkflowChangeOperation =
  | { kind: "add-gate"; gate: SupervisorGate; rationale: string; risk: string }
  | { kind: "update-gate"; gateId: string; patch: Partial<Omit<SupervisorGate,"id">>; rationale: string; risk: string }
  | { kind: "remove-gate"; gateId: string; rationale: string; risk: string };

interface WorkflowChangeRequest {
  id: string;
  workflowId: string;
  workflowVersion: number;        // 冻结：提案时的 workflow 版本
  status: "awaiting-approval" | "applied" | "rejected";
  title: string;
  reason: string;
  requestedBy: string;            // 默认 "gate-steward"
  operations: WorkflowChangeOperation[];
  review?: { actor: string; comment?: string; at: string };  // 审批记录
  createdAt: string;
  updatedAt: string;
}
```

`state.workflowChangeRequests: Record<string, WorkflowChangeRequest>`（加到 WorkbenchState，types.ts:713 区）。

## 3. 后端审批链（完整保留，镜像 knowledge-change）

service 方法：
- `createWorkflowChangeRequest(input)` — 校验目标是 supervisor workflow、gate 操作合法（add：gate.id 不重复、validatorId 已注册（复用现有 gate validator 校验）、mode/fallback 合法；update/remove：gateId 存在）；冻结当前 workflowVersion；存入 state。
- `listWorkflowChangeRequests()` / `getWorkflowChangeRequest(id)`。
- `approveWorkflowChangeRequest(id, actor="local-owner", comment?)` — apply：
  - **stale 校验**：目标 workflow 当前版本 ≠ 冻结的 workflowVersion → 抛错拒绝（不自动 rebase）。
  - 依次把 operations 应用到 `flow.gates`（add 追加、update 合并 patch、remove 删除），复用现有 gate 校验，经 `updateWorkflow`（service.ts:5768）产生新 workflow 版本。
  - status→applied，记 review。
- `rejectWorkflowChangeRequest(id, actor, comment?)` — status→rejected，记 review。

## 4. gate-control-conversation skill + MCP + daemon

- 新 skill `gate-control-conversation`：工具白名单 = 只读 workflow snapshot + `workflow_change_propose`。
- MCP 工具（src/mcp/server.ts，照现有 knowledge_change_* 工具）：`workflow_change_list` / `workflow_change_get` / `workflow_change_propose`。
- daemon 路由（src/daemon/server.ts，照现有 knowledge-change 路由）：list/get/propose + approve/reject（人工审批经 HTTP/CLI）。
- CLI（src/cli/main.ts）：`workbench workflow-change list/get/propose/approve/reject`。

## 5. 小关员工（conversational 系统员工）

模板 `templates/workbench/gate-steward.employee.json`：
- `systemRole: "conversational"`（套用系统员工框架：自动归系统区、禁绑定/发布、软保护）。
- `scope: { kind: "project", projectId: "local-agent-workbench" }`，`metadata.employeeKind: "project-internal-control-agent"`（与小配/小知一致）。
- 绑 `gate-control-conversation` skill，`permissions.write: "none"`，受限 codex 控制面 provider（照 knowledge-steward 的 provider 形态，挂 gate_control MCP）。
- systemPrompt：读 workflow snapshot，把自然语言 gate 意图编译为 WorkflowChangeRequest，只提案不 apply，chat 不是授权。

## 6. 只读查看 UI（做完善，不做审批）

前端新增 workflow-change 查看界面（可作为协作编排页的一个只读区，或独立列表）：
- 列出 WorkflowChangeRequest：目标 workflow、冻结版本、status（awaiting-approval/applied/rejected）、requestedBy、时间。
- 详情：每条 operation 可读展开——add/update/remove 分别清晰展示 gate 字段（update 显示字段前后对比 diff）、rationale、risk；审批记录（actor/comment/at）。
- **不做** accept/reject/apply 按钮——审批走 CLI/HTTP。
- 遵循 design.md 像素/蜡笔风格，复用现有只读证据/列表组件。

## 7. 范围（YAGNI）

- UI 只读，无写操作。
- apply 冲突用 stale 拒绝，不自动 rebase。
- 只支持 supervisor workflow 的 gate 操作（graph workflow 无 gate）。
- 不扩展 gate 字段本身、不改 gate 运行时强制逻辑（那是已上线的部分）。

## 8. 错误处理

- 提案/审批的所有拒绝给明确中文错误（非 supervisor workflow、gateId 不存在、validatorId 未注册、版本 stale、目标已 applied/rejected 不可重复审批）。
- 小关是 conversational 系统员工：禁绑定/发布/软保护由系统员工框架自动施加。

## 9. 测试策略

- **service**：create（校验合法/非法操作、冻结版本）、approve（apply 到 gates 产新版本、stale 拒绝、已终态不可重复）、reject；每种 operation（add/update/remove）应用正确。
- **MCP/daemon/CLI**：契约测试（list/get/propose/approve/reject）。
- **员工模板**：gate-steward 能创建且被识别为 conversational 系统员工。
- **client**：查看界面渲染 WorkflowChangeRequest 列表 + operation diff。
- 全量 `npm run check` 绿。

## 10. 组件边界小结

| 组件 | 职责 |
|---|---|
| `WorkflowChangeRequest` 类型 + state 槽 | 提案数据 |
| service 审批链 | create/list/get/approve(apply)/reject + stale 校验 |
| gate-control-conversation skill + MCP + daemon + CLI | 小关的提案通道 + 人工审批入口 |
| gate-steward 员工模板 | conversational 系统员工 |
| client 只读查看界面 | 完善的提案浏览（不含审批操作） |
