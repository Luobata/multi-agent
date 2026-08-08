# 小关（Gate Steward）· 工作流门禁管家

本文只描述已实现的行为。

小关是 Local Agent Workbench 内部自用的 `conversational` 系统员工（见 [系统员工](system-employees.md)），与小配（配置管家）、小知（知识管理员）并列。它负责 **supervisor 工作流门禁**（gate）的对话式管理：把用户「增 / 改 / 删门禁」的自然语言意图编译为 `WorkflowChangeRequest` 提案，等待人工审批后由后端 apply。只有 supervisor 架构的工作流有门禁；graph 工作流没有门禁，小关不处理。

关于门禁本身（`SupervisorGate` 结构、`flow.gates`、validator 校验）参见 [Supervisor Workflow 与 Management Policy](supervisor-workflows.md)。

## 一、职责边界

小关 **只提案、不审批、不 apply**：

- 通过受限的 Gate Control MCP 读取 supervisor 工作流门禁快照与已有提案，并浏览它们；
- 把门禁变更意图编译为 `WorkflowChangeRequest`，留在 `awaiting-approval` 状态；
- 绝不直接审批、apply，或宣称尚未审批的提案已经改动了门禁；
- 不虚构 `workflowId` / `gateId` / `requiredCapability` / `validatorId`；`validatorId` 只能引用已注册的 validator 或字面量 `none`；
- 不使用 Gate Control MCP 之外的能力修改系统。

作为 `conversational` 系统员工，小关自动受系统员工框架约束：归入后台「系统级员工」分区、禁止被外部项目绑定 / 直接调用 / 发布、编辑与归档受软保护。唯一调用入口是它在自身内部项目 `local-agent-workbench` 中的项目角色对话（经 `gate-control-conversation` skill 与 `codex-gate-control` provider）。

## 二、端到端流程

```text
对话（小关，只读快照 + 提案）
  → WorkflowChangeRequest（status: awaiting-approval，冻结提案时的 workflowVersion）
    → 人工审批（CLI 或 HTTP）
      → approve：经 updateWorkflow 应用到 flow.gates，产生新工作流版本，status → applied
      → reject：status → rejected，记录审批人与意见
  → UI 只读查看（不含审批 / apply 按钮）
```

提案冻结创建时的工作流版本。审批时若目标工作流版本已变化（stale），apply 会被拒绝且不自动 rebase；需要基于新版本重新提案。已 `applied` 或 `rejected` 的提案不可再次审批。

## 三、提案操作集

每个 `WorkflowChangeRequest` 携带一个或多个 operation，每个 operation 都必须带 `rationale`（理由）与 `risk`（风险）：

- `add-gate`：新增一个门禁（`gate` 为完整 `SupervisorGate`）。gate id 不得与现有门禁或同一提案内其它新增门禁重复；`requiredCapability` / `instructions` 非空；`mode ∈ {after-each-delegation, before-completion}`；`fallback ∈ {supervisor, block}`；`validatorId`（若给且非 `none`）必须是已注册的 validator。apply 时同步插入对应的 gate stage。
- `update-gate`：按 `gateId` 更新已存在门禁的部分字段（`patch`，不含 `id`）；patch 中给出的 `mode` / `fallback` / `required` / `validatorId` 按同样规则校验。
- `remove-gate`：按 `gateId` 移除已存在门禁；apply 时一并删除引用它的 gate stage。

apply 全程经 `updateWorkflow` 走正规的 workflow / flow 校验（含 gate stage 完整性），绝不直改工作流状态。

## 四、审批入口（人工，CLI 或 HTTP）

审批与 apply 只通过人工经 CLI 或 HTTP 完成；UI 只读，不提供审批 / apply 按钮。

### CLI

```bash
npm run cli -- workbench workflow-change list
npm run cli -- workbench workflow-change get <id>
npm run cli -- workbench workflow-change propose <file>        # <file> 为 WorkflowChangeCreateInput JSON
npm run cli -- workbench workflow-change approve <id> [--comment <c>]
npm run cli -- workbench workflow-change reject <id> [--comment <c>]
```

CLI 的审批人固定记为 `local-cli-owner`。

### HTTP（daemon）

```text
GET  /api/workflow-changes            列出全部提案（{ workflowChanges }）
POST /api/workflow-changes            创建提案（body: WorkflowChangeCreateInput）
GET  /api/workflow-changes/:id        取单条提案
POST /api/workflow-changes/:id/approve   审批通过并 apply（body: { actor?, comment? }）
POST /api/workflow-changes/:id/reject    拒绝（body: { actor?, comment? }）
```

approve / reject 的 `actor` 缺省记为 `local-owner`。`/api/bootstrap` 额外输出 `workflowChanges` 供 UI 加载。

## 五、UI 只读查看

后台客户端在「协作编排」页新增只读区「门禁变更」，与「开始一项工作 / Graph 编排 / 协作编排 / 管理策略库」并列。它列出每条 `WorkflowChangeRequest`：标题、状态、理由、目标工作流与冻结版本、requestedBy、时间；展开每个 operation 可读展示门禁字段，`update-gate` 显示字段前后对比 diff，并展示审批记录（actor / comment / at）。此区严格只读——不渲染任何审批 / apply 按钮，批准、拒绝与应用只通过上面的 CLI / HTTP 完成。

## 六、相关文件

- 员工模板：`templates/workbench/gate-steward.employee.json`
- skill 白名单：`templates/workbench/gate-control-conversation.skill.json`
- MCP 工具（`gate-control` profile）：`workflow_control_snapshot` / `workflow_change_list` / `workflow_change_get` / `workflow_change_propose`（`src/mcp/server.ts`）
- 后端审批链：`src/workbench/service.ts`（`createWorkflowChangeRequest` / `list` / `get` / `approveWorkflowChangeRequest` / `rejectWorkflowChangeRequest`）
- daemon 路由：`src/daemon/server.ts`
- CLI：`src/cli/main.ts`（`workbench workflow-change`）
- UI：`client/src/WorkflowChangePage.tsx`
