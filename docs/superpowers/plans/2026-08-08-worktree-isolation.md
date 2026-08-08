# Worktree 执行隔离 Implementation Plan（#5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** supervisor 的 Management Policy 可声明 `execution.isolation="worktree"`；运行时真实建/用/拆 git worktree（运行后自动拆、非 git 仓回退不隔离、仓内 .multi-agent/worktrees/<runId>），隔离状态记入 run 证据并在运行卷宗可见。

**Architecture:** policy 加 execution 字段 → 新 src/runtime/worktree.ts 生命周期 → runTrackedWorkflow 读策略/建worktree/传 providerCwd/finally拆/记证据/非git回退 → Run.isolation 证据 → RunsPage 展示。

**Tech Stack:** TypeScript (ESM, `.js`), Node child_process (git), React 19, vitest。

## Global Constraints

- ESM import 带 `.js` 后缀。
- 真实成功 run 状态是 `"passed"`（非 completed）——沿用现有词表。
- ManagementPolicy 现有结构 types.ts:~100（limits 在 120，execution 加在旁）。
- runTrackedWorkflow（service.ts:2164）：artifactRoot 用 this.store.dataRoot（不受 providerCwd 影响，artifacts 不进 worktree）；providerCwd 在 2183 传入 runWorkflow。
- git 操作经 child_process spawn，`git -C <root> ...`；worktree 路径 `.multi-agent/worktrees/<runId>`。
- worktree 相关任何故障（建/拆）不得冒泡到主运行链路：建失败→回退不隔离，拆失败→只记日志。
- 隔离只对 supervisor workflow 的 management policy 生效。
- 每步 TDD；worktree 模块单测用临时 git 仓（fs.mkdtemp + git init）。

---

### Task 1: ManagementPolicy.execution 字段 + Run.isolation 证据类型

**Files:**
- Modify: `src/workbench/types.ts`（policy execution 字段 + create/update input；WorkflowRunRecord isolation）
- Modify: `src/core/types.ts`（如 Run 类型在此则加 isolation）
- Modify: `src/workbench/service.ts`（buildManagementPolicy 透传 execution）
- Test: `tests/worktree-isolation.test.ts`（新建，policy 持久化 execution 的断言）

**Interfaces:**
- Produces:
  - `ManagementPolicyDefinition.execution?: { isolation?: "worktree" | "none" }`
  - `ManagementPolicyCreateInput`/`UpdateInput` 同步可选 execution
  - Run/WorkflowRunRecord `isolation?: { mode: "worktree" | "none"; worktreePath?: string; fallbackReason?: string }`

- [ ] **Step 1: 失败测试**

```typescript
// tests/worktree-isolation.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "wt-iso-")); }

describe("management policy execution.isolation", () => {
  it("persists execution.isolation on a policy", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const policy = await svc.createManagementPolicy({
      id: "iso-policy", displayName: "Iso", description: "d",
      allowedRoleIds: ["researcher"], instructions: "i",
      limits: { maxRounds: 2, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60000 },
      execution: { isolation: "worktree" }
    } as never);
    expect(policy.execution?.isolation).toBe("worktree");
  });

  it("defaults to no execution isolation", async () => {
    const svc = await WorkbenchService.open({ dataRoot: tmp() });
    const policy = await svc.createManagementPolicy({
      id: "plain", displayName: "Plain", description: "d",
      allowedRoleIds: ["researcher"], instructions: "i",
      limits: { maxRounds: 2, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 60000 }
    } as never);
    expect(policy.execution?.isolation).toBeUndefined();
  });
});
```

- [ ] **Step 2: 确认失败** — `npx vitest run tests/worktree-isolation.test.ts` → FAIL
- [ ] **Step 3: 实现** — types 加字段；buildManagementPolicy（service.ts:~5663）透传 `execution: input.execution`（校验：若给则 isolation ∈ {"worktree","none"}）；Run/WorkflowRunRecord 加 isolation。
- [ ] **Step 4: 确认通过 + typecheck** — `npx vitest run tests/worktree-isolation.test.ts && npm run typecheck:server` → PASS
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: add execution.isolation to management policy and Run.isolation evidence"`

---

### Task 2: src/runtime/worktree.ts 生命周期

**Files:**
- Create: `src/runtime/worktree.ts`
- Test: `tests/worktree-module.test.ts`

**Interfaces:**
- Produces:
  - `isGitRepo(root: string): Promise<boolean>`
  - `createRunWorktree(repoRoot: string, runId: string): Promise<{ path: string } | null>` — git 仓则建 `.multi-agent/worktrees/<runId>`（`git -C repoRoot worktree add --detach <relpath>`）返回绝对路径；非 git 仓返回 null。
  - `removeRunWorktree(repoRoot: string, worktreePath: string): Promise<void>` — `git -C repoRoot worktree remove --force <worktreePath>` 然后 `git -C repoRoot worktree prune`；失败 catch 记 console.warn，不抛。

- [ ] **Step 1: 失败测试**

```typescript
// tests/worktree-module.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitRepo, createRunWorktree, removeRunWorktree } from "../src/runtime/worktree.js";

function gitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "f.txt"), "x");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

describe("worktree lifecycle", () => {
  it("isGitRepo true for a repo, false for a plain dir", async () => {
    expect(await isGitRepo(gitRepo())).toBe(true);
    expect(await isGitRepo(fs.mkdtempSync(path.join(os.tmpdir(), "plain-")))).toBe(false);
  });

  it("creates and removes a run worktree in a git repo", async () => {
    const root = gitRepo();
    const wt = await createRunWorktree(root, "run-abc");
    expect(wt).not.toBeNull();
    expect(fs.existsSync(wt!.path)).toBe(true);
    expect(wt!.path).toContain(path.join(".multi-agent", "worktrees", "run-abc"));
    await removeRunWorktree(root, wt!.path);
    expect(fs.existsSync(wt!.path)).toBe(false);
  });

  it("returns null when target is not a git repo", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain2-"));
    expect(await createRunWorktree(plain, "run-x")).toBeNull();
  });

  it("removeRunWorktree does not throw on a bad path", async () => {
    const root = gitRepo();
    await expect(removeRunWorktree(root, path.join(root, "nope"))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 确认失败** — `npx vitest run tests/worktree-module.test.ts` → FAIL
- [ ] **Step 3: 实现 worktree.ts**（spawn git，promisify execFile；createRunWorktree 先 isGitRepo，再 mkdir 父目录、git worktree add --detach）。
- [ ] **Step 4: 确认通过 + typecheck** — `npx vitest run tests/worktree-module.test.ts && npm run typecheck:server` → PASS
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: add git worktree lifecycle helpers"`

---

### Task 3: runTrackedWorkflow 接入（建/用/拆/回退/证据）

**Files:**
- Modify: `src/workbench/service.ts`
- Test: `tests/worktree-isolation.test.ts`（追加集成）

**Interfaces:**
- Consumes: Task 2 worktree helpers, Task 1 policy.execution + Run.isolation。
- 行为：runTrackedWorkflow 内——解析该 workflow 的 management policy（supervisor 才有）；若 execution.isolation==="worktree"：base=providerCwd??projectRoot；isGitRepo(base)?create→用其 path 作 providerCwd 传 runWorkflow，finally removeRunWorktree，run.isolation={mode:"worktree",worktreePath}；:回退 run.isolation={mode:"none",fallbackReason:"target is not a git repository"}。否则 mode none。worktree 建/拆故障不冒泡。

- [ ] **Step 1: 失败测试**（追加）

```typescript
// 追加：用 scripted-supervisor（参照 tests/workbench.test.ts:588）建一个 policy.execution.isolation=worktree 的 supervisor workflow，
// 在一个 git 仓 providerCwd 下 runWorkbenchWorkflow：
//   expect(result.run.isolation?.mode).toBe("worktree")
//   运行后该 worktree 路径已被清理（fs.existsSync false）
// 再在非 git 仓 providerCwd：expect(result.run.isolation?.mode).toBe("none"); fallbackReason 含 "git"
```
> 实施者：补全 supervisor workflow 脚手架（参照 workbench.test.ts:588 scripted-supervisor），providerCwd 用一个临时 git 仓 / 非 git 仓。

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现接入**（在 runTrackedWorkflow 包裹 runWorkflow：解析 policy → 若 worktree 则 create+改 providerCwd+try/finally remove；把 isolation 写进 runResult.run 并落 run.json；非git/建失败回退并记 fallbackReason）。注意读 policy 的方式：从 workflow.managementPolicy 解析（supervisor workflow 才有该字段）。
- [ ] **Step 4: 确认通过 + typecheck + 全量回归** — `npx vitest run tests/worktree-isolation.test.ts tests/workbench.test.ts && npm run typecheck:server` → PASS
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: run supervisor workflows in an isolated worktree when policy requests it"`

---

### Task 4: RunsPage 展示隔离状态

**Files:**
- Modify: `client/src/types.ts`（Run 加 isolation）
- Modify: `client/src/RunsPage.tsx`（运行元数据 ledger 加隔离行）
- Test: `client/src/RunsPage.test.tsx`（追加）

**Interfaces:**
- Consumes: Run.isolation。
- Produces: RunsPage.tsx:174「运行元数据」DossierSection 的 `<dl className="ledger">` 加一行：隔离 = worktree（显示 worktreePath）/ 普通 / 回退（显示 fallbackReason）。

- [ ] **Step 1: 失败测试**（追加）— mock 一个 run detail 带 isolation:{mode:"worktree",worktreePath:"/x/.multi-agent/worktrees/run-1"}，断言渲染出隔离行 + worktree 标识。（照 RunsPage.test.tsx 现有 detail mock 风格。）
- [ ] **Step 2: 确认失败** — `npx vitest run client/src/RunsPage.test.tsx`
- [ ] **Step 3: client types.ts 加 Run.isolation；RunsPage ledger 加隔离行**（worktree 显示路径、none 显示"普通"、有 fallbackReason 显示回退原因）。
- [ ] **Step 4: 确认通过 + typecheck:client** — `npx vitest run client/src/RunsPage.test.tsx && npm run typecheck:client`
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: show run isolation status in the run dossier"`

---

### Task 5: 文档 + 全量校验

**Files:**
- Create/Modify: `docs/`（worktree 隔离使用说明）

- [ ] **Step 1: 文档** — 说明：supervisor 的 management policy 设 execution.isolation=worktree 即让运行在临时 git worktree 隔离执行、结束自动拆、非 git 仓回退不隔离、运行卷宗可见隔离状态。
- [ ] **Step 2: 全量校验** — `npm run check` → 全绿
- [ ] **Step 3: Commit** — `git add docs/ && git commit -m "docs: document worktree execution isolation"`

---

## Self-Review

**1. Spec coverage：** §2 数据模型→T1；§3 worktree 机制→T2；§4 service 接入(建/用/拆/回退/证据)→T3；§5 UI 可见→T4；文档+校验→T5。✓
**2. Placeholder scan：** 无 TBD；T3 测试标注"补 supervisor 脚手架"是嵌入现有测试范式的合理指引。接口/行为/git 命令/回退规则均给全。
**3. Type consistency：** `execution.isolation`、`Run.isolation{mode,worktreePath,fallbackReason}` 全程一致（T1 定义、T3/T4 用）；worktree helpers `isGitRepo/createRunWorktree/removeRunWorktree`（T2 定义、T3 用）签名一致。

**已知风险（供执行者）：** T3 是核心——必须保证 worktree 建/拆故障不冒泡（建失败回退、拆在 finally 且 catch）；artifactRoot 用 dataRoot 不受 providerCwd 改变影响（已确认 runner.ts:356）。T3 改 service.ts。git worktree 测试依赖环境有 git（CI 通常有）。
