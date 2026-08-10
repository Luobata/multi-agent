# Worktree 执行隔离

本文只描述已实现的行为。

Worktree 执行隔离让 supervisor 工作流的每次运行在一个**独立 git worktree** 中执行。没有产生代码改动的 worktree 会在运行结束后自动拆除；存在改动的 worktree 会保留到人工验收，只有用户在运行卷宗中明确确认后才允许合并。它作为 [Management Policy](supervisor-workflows.md) 的一个执行策略声明，是否隔离随策略版本固定；隔离与交付状态都在运行卷宗（管理后台）可见。

## 一、如何开启

在 supervisor 工作流引用的 Management Policy 上设置执行策略：

```jsonc
{
  // ... 策略其余字段
  "execution": { "isolation": "worktree" }  // 缺省 "none" = 不隔离
}
```

`execution.isolation` 只接受 `"worktree"` 或 `"none"`；给出其它值会在策略创建 / 更新时被拒绝。缺省（不写 `execution`）等价于 `"none"`，即现状不变、不隔离。

策略是版本化资源。`updatePolicy=latest` 的工作流在运行前重新固定最新策略版本；`locked` 工作流继续使用显式固定版本。运行使用的 materialized supervisor policy 会包含 `execution` 快照，因此单次运行的隔离与严格门禁语义都有可追溯证据。

只有 supervisor 架构的工作流带 Management Policy。graph 工作流没有 Management Policy，永不隔离，也不记隔离证据。

## 二、运行时行为

当策略请求 `execution.isolation === "worktree"` 时，运行时：

1. 取执行根 `repoRoot`（传入的 `providerCwd`，否则回退到工作流的 `projectRoot`）。
2. 在任何 Provider 调用前确认 `repoRoot` 是 Git 工作树，并在仓内 `.multi-agent/worktrees/<runId>` 下创建一个 **detached** worktree（`git worktree add --detach`）。
3. 非 Git 执行根、worktree 创建失败或基线 commit 读取失败都会让 Invocation 失败；运行时绝不会回退到原 checkout 执行 Provider。
4. 创建成功后才把 worktree 路径作为本次运行的 `providerCwd` 传给 Provider。
5. 运行结束后检查 worktree 状态：无代码改动时在 `finally` 中拆除；有改动或状态检查失败时保留，避免静默丢失候选交付。

隔离只改变 provider 的**工作目录**。运行产物目录（artifacts）仍指向数据根，不进 worktree，因此 worktree 拆除不影响已持久化的证据。

worktree 初始为 detached。用户确认合并后，运行时才在 worktree 内创建 `codex/run-*` 交付分支并提交候选改动；打开预览、查看 diff 或查看验收证据都不会创建分支或修改目标仓库。

## 三、worktree 严格双门

worktree 策略代表真实代码交付模式。对应 supervisor Workflow 在创建、更新、计划和运行时都必须声明两个 `before-completion`、`required: true` 的 Gate：

- `quality.test`：`validatorId` 不能是 `none`。省略时自动使用 `e2e-evidence`，只接受 browser、http-behavior 或 automation-run 形式的真实 E2E 证据。
- `quality.audit`：必须 `fallback: block`。执行者必须是具有 `quality.audit` 能力的成员，且其 runtime role 不能与被审 code / integration source node 的 runtime role 相同。Supervisor 和无能力成员都不能兜底。

缺门或门配置不严格时，Workflow 创建 / 更新会被拒绝；`updatePolicy=latest` 在运行前切换到 worktree 策略时也会重新校验并拒绝旧的宽松 Workflow。运行时没有独立 auditor、或没有可审计的 code / integration source 时，Run 会 `blocked`，Gate execution evidence 会保存原因和被排除的 runtime roles。`isolation=none` 的既有通用 Gate 选择与 fallback 行为不变。

## 四、人工验收与合并门禁

服务端通过独立的只读 preview 聚合以下证据：Run 终态、全部 required Gate、通过的 required `quality.test` 与 `quality.audit`、结构化 E2E、截图 / 录屏、worktree diff、目标分支与目标工作区状态。`acceptedVerdict` 只作为展示证据，不能替代任一道 Gate。

1. `GET /api/runs/:id/merge-preview` 只执行 `status`、`diff`、`rev-parse`、证据文件枚举等只读操作，不创建分支或写 `delivery.json`。
2. Preview 返回有 256 KiB 上限的 unified diff、`truncated` 标记，以及 shell-safe、可复制的只读 Git 检查命令。
3. 用户必须勾选明确确认；客户端发送绑定当前 Run 的精确 confirmation token。
4. 服务端重新检查 Run、证据、目标分支与工作区，确认后才提交 worktree 变更。
5. 提交后先用 `git merge-tree` 做冲突预检；冲突时目标分支引用不变，worktree 与源分支保留。
6. 预检通过后使用 merge commit 合入当前目标分支；成功后移除 worktree，源分支和 `delivery.json` 作为交付证据保留。

目标仓库有未提交改动、目标分支已变化、Run 未通过、验收证据不足、worktree 无 diff 或 confirmation token 不匹配时，合并请求都会被拒绝。

## 五、keep / discard

服务端提供人工保留与丢弃动作，不实现 push：

- `POST /api/runs/:id/keep`：要求 `actor`，可带 `note`；只在 `delivery.json` 记录 `kept` 与人工决定，保留候选 worktree，不执行 merge / push。
- `POST /api/runs/:id/discard`：要求 `actor` 和 Preview 返回的精确 `DISCARD <runId>` token。服务端重新校验 Run Store 路径、托管 worktree 注册信息和本 Run 的 `codex/<runId>` 分支；已合并候选拒绝丢弃。确认后强制移除候选 worktree，并删除存在且未合并的本 Run 交付分支。

`discard` 只能成功一次。完成后只原子写入 `delivery.json` 的 `discarded` 状态，不修改不可变的 `run.json`。

## 六、失败关闭与兼容边界

- `worktree`：非 Git 或创建失败会在 Provider 执行前使 Invocation 失败，不产生降级执行。
- `none` / 缺省：非代码、模拟和历史流程保持原有非隔离行为。
- worktree 运行结束时的自动清理若无法可靠判断状态，会保留候选目录并记录日志，避免误删代码。

## 七、隔离与交付状态可见（运行卷宗）

每次运行的隔离状态记录在 `Run.isolation` 证据里，随 `run.json` 持久化，并在运行卷宗（RunsPage「运行元数据」）以只读的「隔离」行展示：

| 情况 | `Run.isolation` | 卷宗展示 |
|---|---|---|
| worktree 隔离 | `{ mode: "worktree", worktreePath: "<路径>" }` | `worktree` + worktree 路径 |
| 未隔离 / 无证据 | `{ mode: "none" }` 或缺省 | `普通` |

历史（无 `isolation` 字段的）运行不受影响，展示为「普通」，且不会出现合并动作。存在候选交付的 Run 还会展示变更文件、目标分支洁净状态、结构化 E2E 数量，以及 screenshot / recording 证据墙。证据媒体通过按 Run 和 asset id 解析的只读端点提供，不信任 `run.json` 中的 `artifactDir`。

## 八、组件边界

| 组件 | 职责 |
|---|---|
| `ManagementPolicy.execution.isolation` | 声明本策略下的运行是否 worktree 隔离 |
| `src/runtime/worktree.ts` | git worktree 建、状态检查与安全清理生命周期 |
| `src/runtime/worktreeDelivery.ts` | 证据发现、受限 unified diff、安全检查命令、keep / discard、显式合并确认与冲突预检 |
| `runTrackedWorkflow` 接入（`src/workbench/service.ts`） | 读策略、Provider 前 fail-closed 建 worktree、把 worktree 作为 `providerCwd`、按变更决定保留 / 清理并记证据 |
| `Run.isolation` 证据 | 记录本次运行的隔离状态 |
| Run artifact `delivery.json` | 记录 awaiting-acceptance / conflict / kept / discarded / merged 与人工决定，不改写不可变 `run.json` |
| RunsPage「验收与合并」 | 展示证据墙与缺项；只在 eligible 时开放人工确认入口 |
