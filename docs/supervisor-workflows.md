# Supervisor Workflow 与 Management Policy

## 领域关系

Workbench 有两种可运行 Workflow：

- `graph`：节点和依赖在运行前完整声明；Graph 本身就是控制程序。
- `supervisor`：主管反复观察、派单和收敛；每次 Run 的 execution graph 在运行中增量生成。

Management Policy 不是第三种 Architecture，也不能单独运行或发布。它是 Supervisor Workflow 引用的版本化资源：

```text
Supervisor Workflow
  = Supervisor Employee version
  + Management Policy version
  + workflow-local roleId → Employee version bindings
  + input contract
```

Employee 回答“谁负责”，Policy 回答“按什么边界管理”，Workflow 回答“这支团队用哪个固定版本完成什么任务”，Adapter 执行实际控制循环。

Supervisor Workflow 也不负责判断每个外部请求是否需要领队。需要统一入口控制时，先由独立的 [请求分流策略](task-entrance-policies.md) 在 direct、specialist 和 leader 之间做确定性选择；只有命中 `leader` 才启动这里描述的控制循环。

## 创建与版本

管理策略通过 UI 的“协作编排 → 管理策略库”、HTTP 或 CLI 创建：

```bash
npm run cli -- workbench management-policy create policy.json
npm run cli -- workbench management-policy update evidence-manager policy-update.json
npm run cli -- workbench management-policy get evidence-manager
```

策略保存 `current + versions[]`。修订会创建新版本；已有 Supervisor Workflow 不会自动跟随。升级策略必须修订 Workflow 并显式选择新版本。运行中的 Invocation 使用启动时固定的 Workflow、Policy 和 Employee 版本。

策略归档前检查活动 Workflow 引用。被活动 Workflow 引用时归档会被拒绝；先归档引用方后才能归档策略。恢复同样创建新版本，历史 Run 不被重写。

## 决策协议

主管 Employee 的普通身份、Skill、Knowledge 和 Provider 继续来自 Employee Registry。Supervisor materializer 只在此 Workflow 内覆盖主管的输出契约，要求返回以下动作之一：

```json
{
  "action": "delegate",
  "summary": "为什么这样派单",
  "assignments": [
    {
      "roleId": "researcher",
      "task": "收集相关证据",
      "context": {}
    }
  ]
}
```

```json
{
  "action": "finish",
  "summary": "最终结论摘要",
  "result": {}
}
```

`roleId` 是 Workflow 局部的稳定职责槽，不是 Employee ID、Provider ID 或工具名。Runtime 使用由成员清册生成的 JSON Schema 阻止主管调用未绑定角色，并再次执行 Policy 的轮次、派单、并行和时间限制。

## 动态执行与证据

Supervisor 逻辑上有循环，持久化记录使用 time-expanded DAG：

```text
supervisor-r1
  → researcher-r1-1
  → reviewer-r1-2
  → supervisor-r2
  → ...
```

`node.scheduled` 事件幂等创建 WorkInstance。每个动态实例记录 `kind`、`roleId`、`round` 和 `parentNodeId`；Run Store 继续保存节点 Prompt、Provider stdout/stderr、规范化输出、Knowledge evidence、状态事件以及增量更新的 `plan.json` / `run.json`。

成员技术失败有两种策略：

- `observe-and-replan`：下一轮主管仍能读取失败状态和错误，可以改派或采用兜底结果；即使某个成员失败，主管成功恢复后父 Workflow 仍可 `passed`。
- `fail-fast`：任一成员技术失败使 Workflow `failed`。

轮次、派单数、并行数或持续时间耗尽表示管理边界内无法收敛，终态是 `blocked`，不是技术 `failed`。

持续时间限制会作为绝对 deadline 传给每次 Provider 调用。支持 `AbortSignal` 的 Provider 会被及时中断；自定义 Provider 即使忽略取消并迟到返回，其结果也不会被接受，父 Workflow 仍按 Policy 记为 `blocked`。自定义 Provider 若要及时释放底层进程或远程请求，仍必须实现信号取消。

## 当前边界

- Supervisor 成员当前绑定全局 Employee，不绑定项目内部 Employee / Project Role。
- 不支持嵌套 Supervisor、Supervisor 调用 Graph Workflow、多主管或 `ask_user` 决策。
- daemon 重启后的持久队列恢复仍属于后续可靠性工作；Run 证据已经持久化，但正在执行的 Provider 进程不会恢复。
