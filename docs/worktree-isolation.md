# Worktree 执行隔离

本文只描述已实现的行为。

Worktree 执行隔离让 supervisor 工作流的每次运行在一个**临时 git worktree** 中隔离执行，运行结束后自动拆除。它作为 [Management Policy](supervisor-workflows.md) 的一个执行策略声明，是否隔离随策略版本固定；隔离状态在运行卷宗（管理后台）可见。

## 一、如何开启

在 supervisor 工作流引用的 Management Policy 上设置执行策略：

```jsonc
{
  // ... 策略其余字段
  "execution": { "isolation": "worktree" }  // 缺省 "none" = 不隔离
}
```

`execution.isolation` 只接受 `"worktree"` 或 `"none"`；给出其它值会在策略创建 / 更新时被拒绝。缺省（不写 `execution`）等价于 `"none"`，即现状不变、不隔离。

策略是版本化资源：修订策略会创建新版本，已有工作流不会自动跟随，需要修订工作流并显式选择新版本（见 [Supervisor Workflow 与 Management Policy](supervisor-workflows.md)）。运行中的 Invocation 使用启动时固定的策略版本，因此单次运行是否隔离在启动时即已确定。

只有 supervisor 架构的工作流带 Management Policy。graph 工作流没有 Management Policy，永不隔离，也不记隔离证据。

## 二、运行时行为

当策略请求 `execution.isolation === "worktree"` 时，运行时：

1. 取执行根 `repoRoot`（传入的 `providerCwd`，否则回退到工作流的 `projectRoot`）。
2. 若 `repoRoot` 是 git 工作树，在仓内 `.multi-agent/worktrees/<runId>` 下创建一个 **detached** worktree（`git worktree add --detach`），把该 worktree 路径作为本次运行的 `providerCwd` 传给 provider 执行。
3. 运行结束后（无论成功、失败还是异常）在 `finally` 中拆除该 worktree（`git worktree remove --force` + `git worktree prune`）。

隔离只改变 provider 的**工作目录**。运行产物目录（artifacts）仍指向数据根，不进 worktree，因此 worktree 拆除不影响已持久化的证据。

因为 worktree 是 detached 且运行结束即拆，隔离本身不做分支管理，也不保留 worktree 内的运行产物——需要保留的内容应通过 artifacts 记录。

## 三、非 git 仓回退（不报错）

当执行根不是 git 仓时，运行**回退为不隔离**：用原 `providerCwd` 照常运行，不报错，并在隔离证据里记 `fallbackReason`。同样地，worktree 创建失败（git 报错）也回退不隔离并记录原因。所有 worktree 相关故障都不会冒泡到主运行链路：

- 非 git 仓 → `{ mode: "none", fallbackReason: "target is not a git repository" }`。
- worktree 创建失败 → `{ mode: "none", fallbackReason: "worktree setup failed: <原因>" }`。
- worktree 拆除失败 → 只记日志，不影响运行结果与返回。

## 四、隔离状态可见（运行卷宗）

每次运行的隔离状态记录在 `Run.isolation` 证据里，随 `run.json` 持久化，并在运行卷宗（RunsPage「运行元数据」）以只读的「隔离」行展示：

| 情况 | `Run.isolation` | 卷宗展示 |
|---|---|---|
| worktree 隔离 | `{ mode: "worktree", worktreePath: "<路径>" }` | `worktree` + worktree 路径 |
| 回退不隔离 | `{ mode: "none", fallbackReason: "<原因>" }` | `回退 · <原因>` |
| 未隔离 / 无证据 | `{ mode: "none" }` 或缺省 | `普通` |

历史（无 `isolation` 字段的）运行不受影响，展示为「普通」。

## 五、组件边界

| 组件 | 职责 |
|---|---|
| `ManagementPolicy.execution.isolation` | 声明本策略下的运行是否 worktree 隔离 |
| `src/runtime/worktree.ts` | git worktree 建（`createRunWorktree`）/ 判定（`isGitRepo`）/ 拆（`removeRunWorktree`）生命周期 |
| `runTrackedWorkflow` 接入（`src/workbench/service.ts`） | 读策略、建 worktree、把 worktree 作为 `providerCwd`、`finally` 拆、记证据、非 git 仓回退 |
| `Run.isolation` 证据 | 记录本次运行的隔离状态 |
| RunsPage「运行元数据」隔离行 | 管理后台只读展示 |
