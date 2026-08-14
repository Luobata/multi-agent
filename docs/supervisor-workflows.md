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

## 异步运行、持续跟踪与领队会话

异步启动 Supervisor Workflow 时，Workbench 会同时原子创建一个持久的领队 `EmployeeSession`。该 Session 固定主管 Employee/version，并记录原始 `invocationId`、`runId`、Workflow/version 和用户任务。Graph Workflow 只有 Invocation/Run，不创建领队 Session，也不会伪装成主管对话。

`start_workflow`、Workflow Publication 的 `start_publication` 和 Entrance Policy 的异步 `leader` 分发回执包含：

- `invocation.id` / `runId`；
- Supervisor 专属的 `leaderSessionId`；
- `monitor` 长轮询契约，包括 `initialCursor`、默认 30 秒心跳和不超过 55 秒的超时上限。

MCP 宿主收到回执后应立即循环调用 `wait_workflow_progress`：传入上次响应的 `nextCursor`，在 `terminal=false` 时保持当前回合，并把每次变化或心跳的中文 `progressReport` 告知用户；终态时主动交付最终摘要。等待由 Invocation/WorkInstance 活动事件唤醒，不使用忙轮询，超时、变化、终态和连接中止都会清理 listener/timer。`get_workflow_progress` 保留为兼容快照接口。

如果宿主回合或连接已经结束，但调用方保存了 `runId`，可调用 `resume_workflow_monitor(runId)` 取得同一 Invocation 的新 monitor 回执，再从新的 `initialCursor` 恢复上述循环；这不会创建第二次 Run。

运行期间，Workbench 会把去重的系统进度消息写入领队 Session；终态写入领队交付消息，但 Session 仍保持 `active`。之后可用 `continue_workflow_conversation(leaderSessionId, message)` 调用固定版本的主管 Employee 继续对话。服务端会反查 Session 与原 Supervisor Invocation、Run、Workflow 和主管绑定，普通 Employee Session 不能冒充领队 Session；通用 `invoke_employee` 也不能绕过此入口复用领队 Session。

daemon 重启不会恢复已经丢失的 Provider 进程本身。对于执行快照、Run 文件、生成后的 manifest 和原执行目录仍完整，且没有等待中人工决定的 Workflow，恢复门禁会从持久检查点重新物化同一个 Run：已通过节点不重做，中断节点重新调用 Provider，原 worktree 继续复用。不满足这些条件的 Invocation/WorkInstance 才会转为 `failed/interrupted`，中断说明会持久化到原领队 Session。

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

MVP 还支持一个仅用于高风险派单前置控制的结构化动作：

```json
{
  "action": "request-human-decision",
  "riskCategory": "dependency-install",
  "summary": "需要安装新的原生依赖",
  "assignments": [
    {
      "roleId": "backend-developer",
      "task": "安装并接入 native-addon",
      "workKind": "code"
    }
  ]
}
```

`riskCategory` 只接受 `dependency-install`、`data-migration`、`scope-expansion` 和 `irreversible-other`。Runtime 在任何成员节点进入 `node.scheduled` 之前创建持久 `HumanDecisionRequest`，固定原 `invocationId`、`runId`、Workflow/version、Supervisor node/round 和完整拟执行派单；Invocation 转为非终态 `awaiting-human-decision`。同一固定点重复创建返回同一请求，pending 期间拟执行派单绝不会启动。

人工可通过 HTTP 或完整 MCP 控制面读取并决定请求：

- `GET /api/human-decision-requests?invocationId=<id>`；
- `GET /api/human-decision-requests/<requestId>`；
- `POST /api/human-decision-requests/<requestId>/decide`，body 为 `{"decision":"approve|reject","comment":"...","decidedBy":"..."}`；
- MCP 对应 `list_human_decision_requests`、`get_human_decision_request`、`decide_human_decision_request`。

批准会唤醒内存中的同一后台 Invocation，并只执行请求里固定的派单；拒绝会把 comment 写回同一 Supervisor 历史，进入下一轮重规划，不创建新 Invocation 或 Session。请求只能决定一次；批准与拒绝都会留下持久状态记录，并向 Run 的 `events.jsonl` 追加 `human-decision.requested` / `human-decision.approved|rejected`，不会为审计改写 `run.json`。人工等待时间不计入 Management Policy 的 active execution duration。

daemon 重启时，关联 pending 请求会原子转为 `voided`，记录 `runtime-recovery` 和中断原因，之后不能再决定；存在这种请求的 Invocation 不会自动续跑。没有 pending 人工决定且恢复材料完整的 Workflow 可以从原 Run 检查点自动续跑，但这不等于恢复原 Provider 进程，也不提供跨进程队列所有权或恰好一次执行保证。

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

持续时间限制会作为绝对 deadline 传给每次 Provider 调用；人工决策暂停会等量顺延 deadline。支持 `AbortSignal` 的 Provider 会被及时中断；自定义 Provider 即使忽略取消并迟到返回，其结果也不会被接受，父 Workflow 仍按 Policy 记为 `blocked`。自定义 Provider 若要及时释放底层进程或远程请求，仍必须实现信号取消。

## 当前边界

- Supervisor 定义可绑定全局 Employee；在已连接项目中调用时，也可为主管和每个成员声明 `projectRoleId`，运行时按项目版本、Binding 版本和 Employee 版本固定任用关系。
- 不支持嵌套 Supervisor、Supervisor 调用 Graph Workflow、多主管或通用开放式 `ask_user`；当前人工交互仅限上述四类高风险动作的结构化一次性决定。
- daemon 重启后不会恢复正在执行的 Provider 进程；恢复材料完整且没有 pending 人工决定的 Workflow 会重放同一 Run，其他 Invocation 转为 `failed/interrupted`。真正的持久队列、租约、跨进程恰好一次执行和 Provider 续跑仍属于后续可靠性工作。
