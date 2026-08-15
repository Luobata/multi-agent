# 请求分流策略

## 作用与边界

请求分流策略（底层仍命名为 Entrance Policy）位于外部请求和实际执行目标之间。它解决“这次请求去哪里”这一层选择，不负责执行团队内部的计划、派单或收敛，也不代表任务已经创建。

`evaluate` 只计算分流决策，不创建 Invocation、Work Instance 或 Run。只有真正调用 `dispatch` 且目标是 Employee、Project Role、Graph 或协作编排时，才会创建可在员工大厅和运行卷宗查看的工单/运行；`direct.mode=caller` 会把控制权交还调用方，不创建内部任务。

```text
结构化调用元数据
  → Entrance Policy
      → direct      交还调用方，或调用一个固定 Employee
      → specialist  调用一个固定 Employee、Project Role 或 Graph Workflow
      → leader      启动一个固定 Supervisor Workflow
```

因此三个资源的职责不同：

- `Entrance Policy`：决定任务从哪里进入；
- `Workflow / Architecture`：决定选定目标内部如何执行；
- `Management Policy`：约束 Supervisor 的轮次、派单、并发、失败和完成条件。

Entrance Policy 不是 Architecture Adapter。它没有循环，也不生成执行图。Supervisor Workflow 命中后，才由 `supervisor` Adapter 进入“观察 → 派单 → 汇总 → 再计划或结束”的控制循环。

## 确定性决策

决策优先级固定为：

1. 调用方显式指定 `direct`、`specialist` 或 `leader`；
2. `route=auto` 时，按保存顺序命中第一条规则；
3. 没有规则命中时使用 `default`。

规则只能检查稳定的结构化数据：

- `tagsAllOf` / `tagsAnyOf`；
- `source` 中的协议、项目、角色、调用方和任务标识；
- `signals` 中安全的点分路径，以及 `eq`、`neq`、`gte`、`lte`、`in`、`exists` 比较。

消息正文不属于策略评估输入，也不能在策略中配置模糊关键词匹配。需要启动领队的入口先使用 `explicit-delivery` 模式严格解析完整口令，只接受 `交付领队` 或项目 `deliveryTargets` 明确列出的 `交付<领队名>`，再写入 `signals.explicitLeaderDelivery=true`。`请交付领队`、`交付一下`、`交付 领队`、普通的“多人协作/动态重规划”描述都不产生该信号。正文只在 `dispatch` 已完成路由后传给目标执行。

项目通过自身 descriptor 绑定这套模式，而不是在 Role 或 Architecture 中硬编码：

```yaml
connector:
  config:
    requirementAdvancement:
      entrancePolicyId: default-task-entrance-policy
      triggerMode: explicit-delivery
      deliveryTargets: [小米汪, 小米汪领队]
```

缺少 `triggerMode: explicit-delivery` 的旧项目配置会 fail closed，不再继续沿用宽松触发。每个项目必须在自己的 descriptor 中明确绑定后才能启动领队。

`evaluate` 是纯试算：不创建 Invocation、Work Instance 或 Run。`dispatch` 才执行决策结果。`direct.mode=caller` 的含义是把控制权明确交还外部主 Agent，不创建内部 Invocation，也不会自动升级到领队。

同一个 Employee 可以出现在不同目标中，但运行语义仍由目标边界决定。例如小米汪既可作为 `product-manager` Project Role 独立处理单一产品任务，也可作为 Supervisor Workflow 的主管管理一支团队。前者是一次专家调用，后者才会加载主管决策契约和 Management Policy 并进入多轮控制循环。

## 版本与证据

策略以 `current + versions[]` 保存。创建或修订时，所有目标会解析并固定版本：

- Employee 固定 `employeeVersion`；
- Project Role 固定 `projectVersion`、`projectBindingVersion` 和解析后的 Employee 版本；
- Graph / Supervisor Workflow 固定 `workflowVersion`。

后续员工任用或 Workflow 更新不会静默改变已有策略版本。每次实际分发把策略 ID、策略版本、决策来源、路由结果和固定目标写入 Invocation 的 `executionSnapshot.entrance`。归档只阻止新评估和分发，历史版本与运行证据仍可读取。

## 示例

下面的策略默认把简单请求交还调用方；单一职责请求进入对应项目角色；需要多个角色、动态重规划或独立验收时进入小米汪领队团队。

```json
{
  "id": "default-task-entrance-policy",
  "displayName": "默认请求分流策略",
  "description": "默认继续讨论，仅显式交付信号进入小米汪领队团队。",
  "direct": { "mode": "caller" },
  "specialists": {
    "frontend-developer": {
      "kind": "project-role",
      "projectId": "local-agent-workbench",
      "roleId": "frontend-developer"
    }
  },
  "leader": { "workflowId": "xiaomiwang-development-team" },
  "rules": [
    {
      "id": "explicit-leader-delivery",
      "when": { "signals": { "explicitLeaderDelivery": { "eq": true } } },
      "result": { "route": "leader" }
    },
    {
      "id": "frontend-specialist",
      "when": { "signals": { "requiredRole": { "eq": "frontend-developer" } } },
      "result": { "route": "specialist", "specialistKey": "frontend-developer" }
    }
  ],
  "default": { "route": "direct" }
}
```

```bash
npm run cli -- workbench entrance-policy create entrance-policy.json
npm run cli -- workbench entrance-policy get default-task-entrance-policy
npm run cli -- workbench entrance-policy evaluate default-task-entrance-policy evaluation.json
npm run cli -- workbench entrance-policy dispatch default-task-entrance-policy dispatch.json
```

HTTP 与 MCP 共用相同的 TypeScript 评估和分发实现；协议层只负责传输，不复制路由逻辑。

当 `dispatch` 返回 `kind=invocation-started` 时，Graph 与 Supervisor 都带有同一套 `monitor` 长轮询契约；宿主应立即循环 `wait_workflow_progress`，而不是在一次进度快照后结束当前回合。只有 `leader` 的 Supervisor 路径额外返回 `leaderSessionId`，并允许终态后通过 `continue_workflow_conversation` 继续领队对话；Graph specialist 路径不会创建领队 Session。
