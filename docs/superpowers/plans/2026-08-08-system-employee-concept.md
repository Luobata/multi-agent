# 系统员工（System Employee）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把“系统员工”升级为一等概念：员工加显式 `systemRole` 字段，据此施加 UI 分区、禁绑定/发布、禁人工直调（automatic）、软保护编辑归档四类约束，并迁移现有 3 个内部员工模板。

**Architecture:** 在 `EmployeeDefinition`/`EmployeeCreateInput` 加可选 `systemRole: "automatic" | "conversational"`；service 各受控方法查 `systemRole` 施加约束；client 员工列表按 `systemRole` 分区；模板标注 systemRole。小关本轮不实现（预留）。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀), React 19 (client), vitest。

## Global Constraints

- ESM import 带 `.js` 后缀。
- 新字段 `systemRole?: "automatic" | "conversational"`；缺省 = 业务员工，行为不变。
- **禁人工直调只拦“人工来源”**：`extractMemoryForRun` 调小忆是内部系统调用，**绝不能被拦**。用一个内部 caller 标记区分（见 Task 4）。runner 的 InvocationSource.kind 只有 `workbench|http|mcp|a2a`，不能只按 kind 判断。
- **软保护**：`updateEmployee`/`archiveEmployee` 对系统员工默认拒绝，接受显式确认标志放行。
- 所有拒绝给明确中文错误信息。
- 不折叠 UI、不实现小关、不删旧 `employeeKind` metadata。
- 测试用 vitest；改现有大文件 service.ts 前先读相关方法作用域。
- 每步 TDD：先失败测试 → 最小实现 → 通过 → 提交。

---

### Task 1: systemRole 类型 + helper + buildEmployeeDefinition 透传

**Files:**
- Modify: `src/workbench/types.ts`（`EmployeeDefinition` + `EmployeeCreateInput` 加字段）
- Modify: `src/workbench/service.ts`（`buildEmployeeDefinition` 透传 + 加 helper）
- Test: `tests/system-employee.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `EmployeeDefinition`/`EmployeeCreateInput`/`buildEmployeeDefinition`。
- Produces:
  - `EmployeeDefinition.systemRole?: "automatic" | "conversational"`；`EmployeeCreateInput.systemRole?: "automatic" | "conversational"`。
  - 导出 helper（service.ts 顶层）：`export function systemRoleOf(e: { systemRole?: string }): "automatic" | "conversational" | undefined` 与 `export function isSystemEmployee(e: { systemRole?: string }): boolean`。
  - `buildEmployeeDefinition` 把 `input.systemRole` 原样写入返回对象（校验：只接受 undefined/"automatic"/"conversational"，否则抛错）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/system-employee.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService, isSystemEmployee, systemRoleOf } from "../src/workbench/service.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "sysemp-")); }

describe("systemRole field + helpers", () => {
  it("helpers classify employees", () => {
    expect(isSystemEmployee({})).toBe(false);
    expect(isSystemEmployee({ systemRole: "automatic" })).toBe(true);
    expect(systemRoleOf({ systemRole: "conversational" })).toBe("conversational");
    expect(systemRoleOf({})).toBeUndefined();
  });

  it("createEmployee persists systemRole", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const e = await svc.createEmployee({
      id: "sys-auto",
      identity: { displayName: "Auto", background: "bg", responsibilities: ["r"] },
      systemRole: "automatic"
    });
    expect(e.systemRole).toBe("automatic");
  });

  it("createEmployee rejects an invalid systemRole", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await expect(svc.createEmployee({
      id: "bad", identity: { displayName: "X", background: "b", responsibilities: ["r"] },
      systemRole: "nope" as never
    })).rejects.toThrow(/systemRole/);
  });

  it("business employees have no systemRole", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const e = await svc.createEmployee({ id: "biz", identity: { displayName: "Biz", background: "b", responsibilities: ["r"] } });
    expect(e.systemRole).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/system-employee.test.ts`
Expected: FAIL（helper 未导出 / systemRole 未透传）

- [ ] **Step 3: 实现**

在 `src/workbench/types.ts` 的 `EmployeeDefinition` 末尾字段区（`updatedAt` 前）加：
```typescript
  systemRole?: "automatic" | "conversational";
```
在 `EmployeeCreateInput` 同样加：
```typescript
  systemRole?: "automatic" | "conversational";
```

在 `src/workbench/service.ts` 顶层（其它 helper 附近）加：
```typescript
export function systemRoleOf(e: { systemRole?: string }): "automatic" | "conversational" | undefined {
  return e.systemRole === "automatic" || e.systemRole === "conversational" ? e.systemRole : undefined;
}
export function isSystemEmployee(e: { systemRole?: string }): boolean {
  return systemRoleOf(e) !== undefined;
}
```

在 `buildEmployeeDefinition` 的 return 对象里（`presentation` 附近）加透传 + 校验。在函数体校验区加：
```typescript
  if (input.systemRole !== undefined && input.systemRole !== "automatic" && input.systemRole !== "conversational") {
    throw new Error(`employee ${id} systemRole must be "automatic" or "conversational"`);
  }
```
return 对象加：
```typescript
    systemRole: input.systemRole,
```

> 注：`buildUpdatedEmployeeDefinition`（紧随其后）也需保留 systemRole——实施者确认它是否复制现有字段；若它基于 current 展开则默认保留，若逐字段构造则显式带上 `systemRole: input.systemRole ?? current.systemRole`。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `npx vitest run tests/system-employee.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/types.ts src/workbench/service.ts tests/system-employee.test.ts
git commit -m "feat: add systemRole field and system-employee helpers"
```

---

### Task 2: 禁绑定为项目角色 + 禁发布 Publication

**Files:**
- Modify: `src/workbench/service.ts`（项目角色绑定方法 + `createPublication`）
- Test: `tests/system-employee.test.ts`（追加）

**Interfaces:**
- Consumes: `isSystemEmployee`（Task 1）, `this.getEmployee`。
- Produces: 绑定方法与 `createPublication` 在目标员工 `isSystemEmployee` 时抛明确错误。

- [ ] **Step 1: 追加失败测试**

```typescript
// tests/system-employee.test.ts —— 追加
  it("rejects publishing a system employee", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "sys-c", identity: { displayName: "Conv", background: "b", responsibilities: ["r"] }, systemRole: "conversational" });
    await expect(svc.createPublication({
      // 用 createPublication 的最小 employee 发布入参（实施者对齐真实签名）
      kind: "employee", employeeId: "sys-c"
    } as never)).rejects.toThrow(/系统员工|system employee/);
  });
```

> 实施者：`createPublication` 真实入参形状见 service.ts:5994；绑定测试若需先 connect+bind 项目，参照 tests/workbench.test.ts 里现有 project bind 用例的建号方式，断言绑定系统员工被拒。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/system-employee.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

在项目角色绑定方法（处理 `roleBinding.employeeId` 的绑定入口，实施者定位真实方法名——binding 写入处，service.ts 约 2726/2849 附近或专门的 bindProject 方法）中，对每个被绑定的 employeeId：
```typescript
const target = this.getEmployee(employeeId);
if (isSystemEmployee(target)) {
  throw new Error(`员工 ${employeeId} 是系统员工（systemRole=${target.systemRole}），不允许绑定为项目角色`);
}
```

在 `createPublication`（service.ts:5994）解析出目标 employee 后：
```typescript
if (isSystemEmployee(target)) {
  throw new Error(`员工 ${target.id} 是系统员工，不允许对外发布`);
}
```

> 实施者：对齐 createPublication 实际如何取到目标 employee（可能是 employee 直发或 workflow 内成员）；workflow 发布若含系统员工成员也应拒绝。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `npx vitest run tests/system-employee.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/system-employee.test.ts
git commit -m "feat: block binding/publishing system employees"
```

---

### Task 3: 软保护编辑 / 归档

**Files:**
- Modify: `src/workbench/service.ts`（`updateEmployee` + `archiveEmployee` 加确认标志）
- Test: `tests/system-employee.test.ts`（追加）

**Interfaces:**
- Consumes: `isSystemEmployee`。
- Produces:
  - `updateEmployee(id, input, options?: { allowSystemEmployeeMutation?: boolean })`：目标是系统员工且无 `allowSystemEmployeeMutation` → 抛错；带标志 → 放行。
  - `archiveEmployee(id, options?: { allowSystemEmployeeMutation?: boolean })`：同上。
  - 现有调用方（无第二参）对业务员工行为不变。

- [ ] **Step 1: 追加失败测试**

```typescript
// tests/system-employee.test.ts —— 追加
  it("soft-protects system employees from edit/archive unless confirmed", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "sys-a", identity: { displayName: "A", background: "b", responsibilities: ["r"] }, systemRole: "automatic" });
    await expect(svc.updateEmployee("sys-a", { description: "x" })).rejects.toThrow(/系统员工|confirm/);
    const updated = await svc.updateEmployee("sys-a", { description: "x" }, { allowSystemEmployeeMutation: true });
    expect(updated.description).toBe("x");
    await expect(svc.archiveEmployee("sys-a")).rejects.toThrow(/系统员工|confirm/);
    const archived = await svc.archiveEmployee("sys-a", { allowSystemEmployeeMutation: true });
    expect(archived.status).toBe("archived");
  });

  it("does not affect business employees", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "biz2", identity: { displayName: "B", background: "b", responsibilities: ["r"] } });
    const u = await svc.updateEmployee("biz2", { description: "y" });
    expect(u.description).toBe("y");
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/system-employee.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

给 `updateEmployee`（service.ts:4501）与 `archiveEmployee`（4563）加可选第二/末参 `options?: { allowSystemEmployeeMutation?: boolean }`，在方法开头取到 current employee 后：
```typescript
if (isSystemEmployee(current) && !options?.allowSystemEmployeeMutation) {
  throw new Error(`员工 ${id} 是系统员工，默认受保护；如确需修改请显式确认（allowSystemEmployeeMutation）`);
}
```

> 实施者：确认这两个方法当前签名，追加可选参数不破坏既有调用；current employee 的获取用现有 `this.getEmployee(id)`。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `npx vitest run tests/system-employee.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/system-employee.test.ts
git commit -m "feat: soft-protect system employees from edit/archive"
```

---

### Task 4: 禁人工直调 automatic（且不误伤小忆内部触发）

**Files:**
- Modify: `src/workbench/service.ts`（`invokeEmployee` 人工来源守卫 + `extractMemoryForRun` 标记内部来源）
- Test: `tests/system-employee.test.ts`（追加）

**Interfaces:**
- Consumes: `isSystemEmployee`, `systemRoleOf`。
- Produces:
  - `invokeEmployee`（service.ts:4784）：当目标 `systemRoleOf === "automatic"` 且来源为人工（非内部标记）→ 抛错拒绝。
  - `extractMemoryForRun` 调 `invokeEmployee` 时带内部来源标记 `source: { kind: "workbench", caller: INTERNAL_CALLER }`（`const INTERNAL_CALLER = "system:memory-extractor"`）。
  - 守卫逻辑：`source.caller` 以 `system:` 前缀开头视为内部系统调用，豁免。
  - `conversational` 系统员工不受此拦截（允许人工对话调）。

- [ ] **Step 1: 追加失败测试**

```typescript
// tests/system-employee.test.ts —— 追加
  it("blocks human direct-invocation of an automatic system employee", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "sys-auto2", identity: { displayName: "Auto", background: "b", responsibilities: ["r"] }, systemRole: "automatic" });
    // 人工来源（默认 workbench，无 system: caller）应被拒
    await expect(svc.invokeEmployee("sys-auto2", { message: "hi" })).rejects.toThrow(/系统员工|自动|not.*directly/);
  });

  it("allows internal system-caller invocation of an automatic employee", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "sys-auto3", identity: { displayName: "Auto", background: "b", responsibilities: ["r"] }, systemRole: "automatic" });
    // 内部来源标记豁免；mock provider 会正常返回
    const r = await svc.invokeEmployee("sys-auto3", { message: "hi" }, { kind: "workbench", caller: "system:memory-extractor" });
    expect(r.runId).toBeTruthy();
  });

  it("allows human invocation of a conversational system employee", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    await svc.createEmployee({ id: "sys-conv2", identity: { displayName: "Conv", background: "b", responsibilities: ["r"] }, systemRole: "conversational" });
    const r = await svc.invokeEmployee("sys-conv2", { message: "hi" });
    expect(r.runId).toBeTruthy();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/system-employee.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `invokeEmployee`（4784）取到 `current` employee 后、现有 internal-project 检查附近加：
```typescript
const isInternalCaller = typeof source.caller === "string" && source.caller.startsWith("system:");
if (systemRoleOf(current) === "automatic" && !isInternalCaller) {
  throw new Error(`员工 ${employeeId} 是自动型系统员工，只能由系统触发，不支持人工直接调用`);
}
```

在 `extractMemoryForRun`（约 service.ts:1719，调 summarize 的 `invokeEmployee` 处，即 initMemory 里 `this.invokeEmployee(MEMORY_SUMMARIZER_ID, {message})`，service.ts 约 1664）改为带内部来源：
```typescript
const INTERNAL_CALLER = "system:memory-extractor"; // 提到模块顶层常量更佳
const result = await this.invokeEmployee(MEMORY_SUMMARIZER_ID, { message: ... }, { kind: "workbench", caller: INTERNAL_CALLER });
```

> **关键**：不做这一步，小忆的自动提炼会被新守卫拦死（它 systemRole=automatic，且原调用无 caller）。这是本 Task 的核心防回归点。

- [ ] **Step 4: 运行确认通过 + 全量测试（防回归 memory）**

Run: `npx vitest run tests/system-employee.test.ts tests/memory-service-integration.test.ts tests/workbench.test.ts && npm run typecheck:server`
Expected: PASS（尤其 memory 集成测试不因守卫回归）

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/system-employee.test.ts
git commit -m "feat: block human direct-invocation of automatic system employees; exempt internal caller"
```

---

### Task 5: client 员工列表按 systemRole 分区

**Files:**
- Modify: `client/src/types.ts`（Employee 类型加 systemRole）
- Modify: `client/src/OfficePage.tsx` 和/或 `client/src/EmployeePage.tsx`（分区渲染）
- Test: `client/src/EmployeePage.test.tsx` 或 `OfficePage.test.tsx`（追加分区断言）

**Interfaces:**
- Consumes: 后端返回的 `systemRole`。
- Produces: 员工列表出现“系统员工”分区/标识；系统员工归入该区，业务员工在原区；不折叠。

- [ ] **Step 1: client 类型加字段**

在 `client/src/types.ts` 的 `Employee` 接口加：
```typescript
  systemRole?: "automatic" | "conversational";
```

- [ ] **Step 2: 写失败测试**

在现有员工列表测试文件追加：mock 数据含一个 systemRole 员工，断言渲染出“系统员工”分区标识且该员工在其中。（照该测试文件现有渲染/查询风格写。）

Run: `npx vitest run client/src/EmployeePage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现分区**

在员工列表渲染处，用 `employee.systemRole` 把列表分成两组渲染：普通业务员工组 + “系统员工”组（带小标题/标识）。不折叠、不隐藏。照 design.md 像素/蜡笔风格，复用现有分组/标题组件。

- [ ] **Step 4: 运行确认通过 + typecheck:client**

Run: `npx vitest run client/src/EmployeePage.test.tsx && npm run typecheck:client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/types.ts client/src/EmployeePage.tsx client/src/OfficePage.tsx client/src/*.test.tsx
git commit -m "feat: group system employees into a distinct section in the UI"
```

---

### Task 6: 迁移现有内部员工模板 + 文档 + 全量校验

**Files:**
- Modify: `templates/workbench/memory-summarizer.employee.json`（+ `systemRole: "automatic"`）
- Modify: `templates/workbench/configuration-steward.employee.json`（+ `systemRole: "conversational"`）
- Modify: `templates/workbench/knowledge-steward.employee.json`（+ `systemRole: "conversational"`）
- Modify: `docs/memory-system.md` 或新增简短文档说明系统员工概念 + 小关预留

**Interfaces:**
- Consumes: Task 1 的字段。
- Produces: 3 个内部员工模板带 systemRole；文档记录概念与小关预留。

- [ ] **Step 1: 模板加 systemRole**

给三个模板各加顶层 `"systemRole": "automatic"`（小忆）/ `"conversational"`（小配、小知）。保留其现有 `metadata.employeeKind` 不动。

- [ ] **Step 2: 文档**

在合适文档加一节“系统员工”：解释 `systemRole` 两级、四类约束、软保护如何确认修改；注明“小关（Gate Steward）将于下一轮作为 `conversational` 系统员工实现”。

- [ ] **Step 3: 模板可创建验证**

用临时数据目录跑一次创建（tsx 脚本或 CLI），确认三个模板带 systemRole 能成功创建、且 `systemRole` 落到定义上。验证后删除临时脚本。

- [ ] **Step 4: 全量校验**

Run: `npm run check`
Expected: typecheck(server+client) + 全部测试 + build 全绿

- [ ] **Step 5: Commit**

```bash
git add templates/workbench/*.employee.json docs/
git commit -m "docs: migrate internal employees to systemRole; document system-employee concept"
```

---

## Self-Review

**1. Spec coverage：**
- §2 数据模型（systemRole 字段）→ Task 1 ✓
- §3 约束矩阵：UI 分区 → Task 5；禁绑定/发布 → Task 2；禁人工直调(automatic) → Task 4；软保护 → Task 3 ✓
- §4 实现落点（helper/service/client/模板迁移/小关预留）→ Task 1-6 ✓
- §5 边界（不折叠/不实现小关/不删旧 metadata/软保护）→ 各 Task 遵守 ✓
- §7 测试 → 每 Task 内嵌；Task 4 显式跑 memory 回归 ✓

**2. Placeholder scan：** 无 TBD。几处标“实施者对齐真实签名”（createPublication 入参、绑定方法名、buildUpdatedEmployeeDefinition 是否保留字段）——因嵌入现有大文件，属合理的跟随现有模式指引，非逻辑占位；核心字段/守卫/常量/测试均已给全。

**3. Type consistency：** `systemRole` 字面量 `"automatic"|"conversational"` 全程一致（types/service/client/模板）；`isSystemEmployee`/`systemRoleOf`（Task 1 定义，Task 2/3/4 使用）；`allowSystemEmployeeMutation`（Task 3 定义并被 update/archive 共用）；`INTERNAL_CALLER = "system:memory-extractor"` + `source.caller.startsWith("system:")` 守卫（Task 4 一致）。

**已知风险提示（供执行者）：** Task 4 是最高风险——新守卫若不豁免内部 caller 会拦死小忆的自动提炼，直接回归 memory 系统。Task 4 Step 4 必须跑 memory 集成测试确认不回归。Task 1-4 都改 service.ts，串行执行。
