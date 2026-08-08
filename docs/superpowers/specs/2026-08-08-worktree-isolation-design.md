# Worktree 执行隔离设计（#5）

状态：设计待评审
日期：2026-08-08
主题：大型 coding 任务可在 git worktree 中隔离运行——作为 Management Policy 的执行策略，管理后台可见

## 1. 背景与目标

探查确认：代码库无任何 git worktree 机制；runtime 只把 `providerCwd`（一个目录路径）通过 `runWorkflow`（runner.ts:354，`options.providerCwd ?? loaded.projectRoot`）传给 provider。要"在 worktree 中隔离运行"需新建整套 worktree 生命周期机制。

**目标**：让 supervisor workflow 通过其 Management Policy 声明"本策略下的运行在独立 git worktree 中执行"，运行时真实建/用/拆 worktree，且隔离状态在管理后台（运行卷宗）可见。

**已确认决策**：
- 生命周期：**运行后自动拆**（临时隔离）。
- 非 git 仓：**回退不隔离**（记证据，用原 providerCwd 跑，不报错）。
- 位置：**仓内 `.multi-agent/worktrees/<runId>`**。
- 管理后台可见：运行卷宗展示本次运行的隔离状态。

## 2. 数据模型

`ManagementPolicyDefinition` 加可选执行策略（`limits` 旁）：
```ts
execution?: { isolation?: "worktree" | "none" };  // 缺省 none
```
`ManagementPolicyCreateInput`/`UpdateInput` 同步。缺省 = none，现状不变。

Run 证据（WorkflowRunRecord / core Run 类型）加：
```ts
isolation?: { mode: "worktree" | "none"; worktreePath?: string; fallbackReason?: string };
```
client Run 类型对齐。

## 3. runtime 机制（新建，核心）

新模块 `src/runtime/worktree.ts`：
- `isGitRepo(root): Promise<boolean>` — `git -C <root> rev-parse --is-inside-work-tree`。
- `createRunWorktree(repoRoot, runId): Promise<{ path: string } | null>` — 若 git 仓：`git -C <repoRoot> worktree add --detach .multi-agent/worktrees/<runId>`，返回绝对路径；非 git 仓返回 null。
- `removeRunWorktree(repoRoot, path): Promise<void>` — `git worktree remove --force <path>` + `git worktree prune`；失败只记日志不抛。
- 全部经受控 spawn；路径段用 runId（已是安全格式）。

## 4. service 接入

`runTrackedWorkflow`（service.ts）：
- 读该 workflow 的 management policy 的 `execution.isolation`。
- 若 = "worktree"：
  - `base = providerCwd ?? projectRoot`；`isGitRepo(base)`：
    - 是 → `createRunWorktree(base, runId)` 得 worktree 路径，作为 `providerCwd` 传给 `runWorkflow`；`finally` 里 `removeRunWorktree`。isolation 证据 = `{ mode:"worktree", worktreePath }`。
    - 否 → 回退：用原 base 跑，isolation 证据 = `{ mode:"none", fallbackReason:"target is not a git repository" }`。
  - 拆除失败只记日志，不影响主运行链路与返回。
- 若 = "none"/缺省：现状不变（isolation 证据 = `{ mode:"none" }` 或不写）。
- isolation 证据写入 run.json。

> 注：worktree 路径作为 providerCwd 后，materialize/artifactRoot 仍指向数据根（artifacts 不进 worktree）；仅 provider 执行的工作目录变为 worktree。确认 artifactRoot 不受 providerCwd 改变影响（runner.ts:356 用 loaded.projectRoot/manifest，不是 providerCwd）。

## 5. 管理后台可见（UI）

RunsPage「运行元数据」DossierSection（RunsPage.tsx:174 的 ledger）加一行：
- 隔离：worktree（显示 worktreePath）/ none（普通）/ 回退（显示 fallbackReason）。
- 只读，随现有 run 证据展示。

## 6. 范围（YAGNI）

- 只 supervisor 的 management policy 带 execution.isolation（policy 本就只服务 supervisor）。
- 只做"每次运行一个临时 worktree，结束即拆"；不做并发复用/缓存/预热。
- 不做 worktree 内的分支管理策略（用 --detach，运行产物由人工事后处理——本设计运行后自动拆，故产物在拆前须靠 artifacts 记录；大 coding 任务若要留产物是后续增强）。
- 拆除失败不阻塞、不报错，只记日志。

## 7. 错误处理

- 非 git 仓 → 回退不隔离 + 证据 fallbackReason，不报错。
- worktree 建立失败（git 报错）→ 回退不隔离 + 证据 fallbackReason，运行照常。
- 拆除失败 → 记日志，不影响运行结果。
- 隔离逻辑不得让 worktree 相关故障冒泡到主运行链路。

## 8. 测试策略

- **worktree 模块单测**：用临时 git 仓验证 create 返回路径且 worktree 存在、remove 清理、非 git 仓 create 返回 null、remove 失败不抛。
- **service 集成**：policy=worktree 的运行——git 仓时 providerCwd 指向 worktree 且结束后被清理、run.isolation.mode=worktree；非 git 仓回退（mode=none + fallbackReason）；不影响运行结果。
- **client**：RunsPage 运行元数据展示隔离行（worktree / 回退）。
- 全量 `npm run check` 绿。

## 9. 组件边界

| 组件 | 职责 |
|---|---|
| ManagementPolicy.execution.isolation | 声明是否 worktree 隔离 |
| src/runtime/worktree.ts | git worktree 建/用/拆生命周期 |
| runTrackedWorkflow 接入 | 读策略、建 worktree、传 providerCwd、finally 拆、记证据、非git回退 |
| Run.isolation 证据 | 记录本次运行隔离状态 |
| RunsPage 运行元数据行 | 管理后台可见 |
