# 小关 (Gate Steward) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现小关——WorkflowChangeRequest 完整审批链（create→approve/reject→apply，镜像 knowledge-change）+ gate-control-conversation skill + MCP/daemon/CLI + conversational 系统员工模板 + 只读查看 UI。

**Architecture:** `WorkflowChangeRequest` 类型 + `state.workflowChangeRequests`；service 审批链（apply 到 supervisor workflow 的 flow.gates，stale 拒绝）；skill/MCP/daemon/CLI 提案与人工审批通道；小关员工 `systemRole: conversational`；client 只读查看。

**Tech Stack:** TypeScript (ESM, `.js`), React 19 (client), vitest。

## Global Constraints

- ESM import 带 `.js` 后缀。
- 镜像现有 knowledge-change：state 槽（types.ts:720 `knowledgeChangeRequests`）、service 链（service.ts:3098 create / 3179 approve / 3243 reject）、MCP 工具（mcp/server.ts:525 `knowledge_change_*`）、daemon 路由（daemon/server.ts:299 `/api/knowledge-changes` + `/approve` `/reject`）、CLI。
- 真实 gate：`SupervisorGate`（types.ts:207）`{ id, requiredCapability, mode, required, instructions, fallback, validatorId? }`，挂 supervisor workflow 的 `flow.gates`（types.ts:265）。
- validatorId 合法性用 `listGateValidators()`（src/architectures/gateValidators.ts:59）校验。
- workflow 改动经 `updateWorkflow`（service.ts:5768）产生新版本。
- 小关是 conversational 系统员工——复用已上线的 systemRole 框架（自动归系统区、禁绑定/发布、软保护），无需重复实现约束。
- UI 只读，无 approve/reject/apply 按钮。
- 每步 TDD；改 service.ts 前先读相关方法作用域；改大文件串行。

---

### Task 1: WorkflowChangeRequest 类型 + state 槽

**Files:**
- Modify: `src/workbench/types.ts`（加类型 + WorkbenchState 槽）
- Test: `tests/workflow-change.test.ts`（新建，先只放类型编译占位/最简断言）

**Interfaces:**
- Consumes: `SupervisorGate`（types.ts:207）。
- Produces:
  - `WorkflowChangeOperation`（add-gate/update-gate/remove-gate 三态，各带 rationale+risk，见 spec §2）
  - `WorkflowChangeRequest`（id/workflowId/workflowVersion/status/title/reason/requestedBy/operations/review?/createdAt/updatedAt）
  - `WorkbenchState.workflowChangeRequests: Record<string, WorkflowChangeRequest>`

- [ ] **Step 1: 写类型 + 一个编译级测试**

```typescript
// tests/workflow-change.test.ts
import { describe, it, expect } from "vitest";
import type { WorkflowChangeRequest, WorkflowChangeOperation } from "../src/workbench/types.js";

describe("WorkflowChangeRequest types", () => {
  it("shapes an add-gate operation", () => {
    const op: WorkflowChangeOperation = {
      kind: "add-gate",
      gate: { id: "g1", requiredCapability: "quality.test", mode: "before-completion", required: true, instructions: "x", fallback: "block", validatorId: "e2e-evidence" },
      rationale: "r", risk: "low"
    };
    const req: WorkflowChangeRequest = {
      id: "wc-1", workflowId: "w", workflowVersion: 1, status: "awaiting-approval",
      title: "t", reason: "r", requestedBy: "gate-steward", operations: [op],
      createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z"
    };
    expect(req.operations[0]?.kind).toBe("add-gate");
  });
});
```

- [ ] **Step 2: 运行确认失败**（类型不存在）

Run: `npx vitest run tests/workflow-change.test.ts`
Expected: FAIL

- [ ] **Step 3: 加类型到 types.ts**（按 spec §2 逐字），并给 `WorkbenchState` 加 `workflowChangeRequests: Record<string, WorkflowChangeRequest>;`（与 `knowledgeChangeRequests` 相邻）。

> 注：加了 state 槽后，`initialState()`（src/workbench/store.ts）需初始化 `workflowChangeRequests: {}`——本 Task 一并加，否则运行时缺字段。搜 store.ts 里 `knowledgeChangeRequests: {}` 旁边加。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `npx vitest run tests/workflow-change.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/types.ts src/workbench/store.ts tests/workflow-change.test.ts
git commit -m "feat: add WorkflowChangeRequest types and state slot"
```

---

### Task 2: service 审批链 — create / list / get

**Files:**
- Modify: `src/workbench/service.ts`
- Test: `tests/workflow-change.test.ts`（追加）

**Interfaces:**
- Consumes: `listGateValidators`（gateValidators.ts）, `this.getWorkflow`, `SupervisorGate`, Task 1 类型。
- Produces:
  - `createWorkflowChangeRequest(input: { workflowId; title; reason; requestedBy?; operations })` — 校验目标是 supervisor workflow；每个 operation 合法（add：gate.id 在该 workflow 未重复、validatorId（若给）∈ listGateValidators、mode∈{after-each-delegation,before-completion}、fallback∈{supervisor,block}；update/remove：gateId 存在于 flow.gates）；冻结 `workflowVersion = 当前版本`；status="awaiting-approval"；存 state；返回 request。
  - `listWorkflowChangeRequests(): WorkflowChangeRequest[]`（按 createdAt 倒序）
  - `getWorkflowChangeRequest(id): WorkflowChangeRequest`（不存在抛错）

- [ ] **Step 1: 追加失败测试**

```typescript
// tests/workflow-change.test.ts —— 追加（需要一个带 supervisor workflow 的 service；
// 参照 tests/workbench.test.ts 的 supervisor workflow 建号方式建最小 workflow）
  it("creates a change request freezing the workflow version and lists it", async () => {
    // 建 service + supervisor workflow（复用 workbench.test 里的 scripted-supervisor 建法）
    // const req = await svc.createWorkflowChangeRequest({ workflowId, title:"加e2e门禁", reason:"r",
    //   operations:[{ kind:"add-gate", gate:{...}, rationale:"r", risk:"low" }] });
    // expect(req.status).toBe("awaiting-approval");
    // expect(req.workflowVersion).toBe(<当前版本>);
    // expect((await svc.listWorkflowChangeRequests()).length).toBe(1);
  });

  it("rejects an unknown validatorId", async () => {
    // createWorkflowChangeRequest add-gate validatorId:"nope" → rejects /validator/
  });

  it("rejects operating on a non-supervisor (graph) workflow", async () => {
    // 对 graph workflow 提案 → rejects
  });
```

> 实施者：补全建 supervisor workflow 的最小脚手架（参照 tests/workbench.test.ts:588 的 scripted-supervisor 用例）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/workflow-change.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 create/list/get**（镜像 createKnowledgeChangeRequest 结构，service.ts:3098）。id 用 `wc-${timestamp}-${uuid8}`。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `npx vitest run tests/workflow-change.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/workflow-change.test.ts
git commit -m "feat: add createWorkflowChangeRequest/list/get with gate validation"
```

---

### Task 3: service 审批链 — approve(apply) / reject

**Files:**
- Modify: `src/workbench/service.ts`
- Test: `tests/workflow-change.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 create/get, `this.updateWorkflow`（5768）, `getWorkflowChangeRequest`。
- Produces:
  - `approveWorkflowChangeRequest(id, actor="local-owner", comment?)` — stale 校验（目标 workflow 当前版本 ≠ request.workflowVersion → 抛错）；request 非 awaiting-approval → 抛错；把 operations 应用到 flow.gates（add 追加 / update 合并 patch 到匹配 gateId / remove 过滤掉 gateId），经 updateWorkflow 产新版本；request.status="applied" + review。
  - `rejectWorkflowChangeRequest(id, actor="local-owner", comment?)` — 非 awaiting-approval 抛错；status="rejected" + review。

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加
  it("approve applies add-gate to flow.gates and bumps workflow version", async () => {
    // create add-gate → approve → getWorkflow 的 flow.gates 含新 gate，version 增加，request.status==="applied"
  });
  it("approve applies update-gate (patch merge) and remove-gate", async () => {
    // 分别验证 update 合并字段、remove 删除
  });
  it("rejects approve when workflow version is stale", async () => {
    // create → 另外 updateWorkflow 改版本 → approve rejects /stale|version/
  });
  it("rejects re-approving an applied/rejected request", async () => {});
  it("reject sets status rejected with review", async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/workflow-change.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 approve/reject**（镜像 approveKnowledgeChangeRequest，service.ts:3179；apply 逻辑构造新的 gates 数组交给 updateWorkflow）。

- [ ] **Step 4: 运行确认通过 + typecheck + workbench 回归**

Run: `npx vitest run tests/workflow-change.test.ts tests/workbench.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/workflow-change.test.ts
git commit -m "feat: add approve(apply)/reject for workflow change requests with stale guard"
```

---

### Task 4: daemon 路由

**Files:**
- Modify: `src/daemon/server.ts`
- Test: `tests/workflow-change.test.ts`（追加 service 契约用例即可，路由 e2e 由现有 daemon 范式覆盖）

**Interfaces:**
- Consumes: Task 2/3 的 service 方法。
- Produces（照 knowledge-changes 路由，daemon/server.ts:299）：
  - `GET /api/workflow-changes` → `{ workflowChanges: service.listWorkflowChangeRequests() }`
  - `POST /api/workflow-changes` → `service.createWorkflowChangeRequest(body)`（201）
  - `GET /api/workflow-changes/:id` → get
  - `POST /api/workflow-changes/:id/approve` → approve（body 取 actor/comment）
  - `POST /api/workflow-changes/:id/reject` → reject
  - bootstrap（daemon/server.ts:147 附近）加 `workflowChanges: service.listWorkflowChangeRequests()`。

- [ ] **Step 1: 加路由**（照现有 knowledge-changes 五个路由 + bootstrap 字段）。
- [ ] **Step 2: typecheck + 现有 daemon 测试不回归**

Run: `npm run typecheck:server && npx vitest run tests/workbench.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/daemon/server.ts
git commit -m "feat: add daemon routes for workflow change requests"
```

---

### Task 5: gate-control-conversation skill + MCP 工具

**Files:**
- Create: `templates/workbench/gate-control-conversation.skill.json`
- Modify: `src/mcp/server.ts`
- Modify: `src/runtime/systemProviders.ts`（若需新 provider profile，照 knowledge-control）
- Test: 契约测试（service 层已覆盖；MCP 工具注册照现有范式）

**Interfaces:**
- Consumes: daemon 的 workflow-change 路由。
- Produces:
  - MCP 工具 `workflow_change_list` / `workflow_change_get` / `workflow_change_propose`（照 mcp/server.ts:525 knowledge_change_* 的 registerTool + request 代理 daemon）。
  - skill JSON：只读 workflow snapshot + workflow_change_propose 工具白名单。

- [ ] **Step 1: 写 skill JSON**（照 templates/workbench/knowledge-control-conversation.skill.json 形态）。
- [ ] **Step 2: 注册 3 个 MCP 工具**（照 knowledge_change_* 模式）。
- [ ] **Step 3: typecheck**

Run: `npm run typecheck:server`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add templates/workbench/gate-control-conversation.skill.json src/mcp/server.ts src/runtime/systemProviders.ts
git commit -m "feat: add gate-control-conversation skill and MCP tools"
```

> 实施者：确认 systemProviders.ts 是否真需要改（若小关复用现有 codex 控制面 provider 形态但挂不同 MCP，可能需要一个新的系统 provider profile；照 codex-knowledge-control 的 store.ts:121 定义方式）。若不需要则不改该文件。

---

### Task 6: CLI 命令

**Files:**
- Modify: `src/cli/main.ts`

**Interfaces:**
- Consumes: service 方法。
- Produces: `workbench workflow-change list / get <id> / propose <file> / approve <id> [--comment] / reject <id> [--comment]`（照现有 knowledge-change CLI）。

- [ ] **Step 1: 加 CLI 子命令组**（照现有 knowledgeChange CLI）。
- [ ] **Step 2: typecheck + 冒烟**

Run: `npm run typecheck:server && npx tsx src/cli/main.ts workbench workflow-change list`
Expected: 类型通过；空库输出 `[]`

- [ ] **Step 3: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat: add workflow-change CLI commands"
```

---

### Task 7: 小关员工 + provider 模板

**Files:**
- Create: `templates/workbench/gate-steward.employee.json`
- Create（若需）: `templates/workbench/codex-gate-control.provider.json`
- Test: 临时脚本验证创建（验证后删除）

**Interfaces:**
- Consumes: `systemRole` 框架、gate-control-conversation skill。
- Produces: gate-steward 员工模板（`systemRole: "conversational"`、project scope local-agent-workbench、绑 skill、write:none、受限 provider）。

- [ ] **Step 1: 写模板**（照 knowledge-steward.employee.json，改 skill/provider/prompt，加 `systemRole: "conversational"`）。
- [ ] **Step 2: 临时脚本验证**：临时数据目录创建 provider + 员工，确认成功且 `isSystemEmployee` 识别为系统员工、systemRole=conversational。验证后删脚本。
- [ ] **Step 3: Commit**

```bash
git add templates/workbench/gate-steward.employee.json templates/workbench/codex-gate-control.provider.json
git commit -m "feat: add gate steward conversational system employee templates"
```

---

### Task 8: client 只读查看 UI

**Files:**
- Modify: `client/src/types.ts`（加 WorkflowChangeRequest 类型）
- Create/Modify: client 页面（新增 workflow-change 只读视图，或并入协作编排页只读区）
- Test: client 测试

**Interfaces:**
- Consumes: `GET /api/workflow-changes`。
- Produces: 只读列表 + 详情（operation 展开、update 前后对比、rationale/risk、审批记录）；无写按钮。

- [ ] **Step 1: client 类型**：加 WorkflowChangeRequest（对齐 server 字段）。
- [ ] **Step 2: 写失败测试**：mock `/api/workflow-changes`，断言列表 + 一条 add/update operation 的可读展示。
- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run <该测试文件>`
Expected: FAIL

- [ ] **Step 4: 实现只读视图**（照现有只读证据/列表组件、design.md 风格；update-gate 显示字段 diff）。
- [ ] **Step 5: 运行通过 + typecheck:client**

Run: `npx vitest run <该测试文件> && npm run typecheck:client`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "feat: add read-only workflow change request viewer"
```

---

### Task 9: 文档 + 全量校验

**Files:**
- Create/Modify: `docs/`（小关使用文档：对话提案 → CLI/HTTP 审批 → 只读查看）

- [ ] **Step 1: 文档**：说明小关是 conversational 系统员工、提案流程、审批走 CLI/HTTP、UI 只读查看；更新 docs/system-employees.md 把小关从"预留"改为"已实现"。
- [ ] **Step 2: 全量校验**

Run: `npm run check`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: document gate steward and mark 小关 implemented"
```

---

## Self-Review

**1. Spec coverage：** §2 类型→T1；§3 审批链→T2(create/list/get)+T3(approve/reject)；§4 skill/MCP/daemon/CLI→T4(daemon)+T5(skill/MCP)+T6(CLI)；§5 小关员工→T7；§6 只读 UI→T8；§9 测试贯穿各 Task；文档+校验→T9。✓
**2. Placeholder scan：** 无 TBD。几处"实施者补全 supervisor workflow 脚手架/确认 systemProviders 是否需改/选 UI 落点"属嵌入现有代码的合理指引，非逻辑占位；类型、方法签名、校验规则、镜像锚点均给全。
**3. Type consistency：** `WorkflowChangeRequest`/`WorkflowChangeOperation` 全程一致（T1 定义，T2-8 使用）；`createWorkflowChangeRequest`/`approveWorkflowChangeRequest` 等签名 T2/T3 定义、T4/T6 复用一致；status 值 `awaiting-approval|applied|rejected` 一致。

**已知风险（供执行者）：** T2/T3 都改 service.ts 审批链，串行；T3 approve 的 apply 必须经 updateWorkflow 走正规校验（勿直接改 state.workflows 绕过 gate 校验）。T5 的 systemProviders 改动不确定性最高——先判断是否真需要新 provider profile。
