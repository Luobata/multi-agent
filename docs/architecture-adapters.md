# Architecture Adapter 与模式演进

## 1. 当前实现

项目目前只注册 `graph`。这不是把未来架构锁死为 DAG，而是先完成一条可运行路径，同时把架构相关行为收敛到统一接口：

```ts
interface ArchitectureAdapter {
  id: string;
  validate(context): string[];
  compile(manifest, workflowId): ExecutionPlan;
  formatText(plan): string;
  formatMermaid(plan): string;
  execute(context): Promise<void>;
}
```

通用 Runtime 负责 Role 解析、Provider 调用、输出校验、重试和证据落盘；Architecture Adapter 只负责协作模式特有的配置、计划、状态推进与调度。这样新增架构不需要给通用 runner 增加一串 `if (architecture === ...)`。

`graph` 当前支持：

- 通过 `needs` 表达 DAG 依赖；
- 无依赖节点的 fan-out 并行；
- 多依赖节点的 gather/synthesis；
- 有界并发；
- collect-evidence 或 fail-fast 失败策略。

## 2. 不把 Wiki 中每个模式都做成 Adapter

多 Agent 模式往往位于不同维度。把所有名称平铺成同一种插件，会造成组合爆炸。建议按“它究竟改变什么”归类：

| 模式类别 | 本项目落点 | 示例 |
| --- | --- | --- |
| 控制循环 | Architecture Adapter | graph、supervisor、handoff、动态 group-chat |
| 图内协作结构 | Workflow 模板、节点类型或策略 | fan-out/gather、critic-review、debate、voting、reflection |
| Persona 与专业能力 | Role Profile + Skill | role-playing、专家角色、共享领域能力 |
| 共享状态与消息 | State/Transport backend | blackboard、event bus、shared memory |
| 外部接入协议 | Provider/Tool/Protocol adapter | MCP、A2A、远程模型服务 |
| 安全和人工控制 | Runtime policy 或显式节点 | workspace isolation、budget、approval、human-in-the-loop |

判断标准很直接：只有当一种模式需要不同的配置校验、计划形态、状态转换或执行循环时，才值得新增 Architecture Adapter。

## 3. 当前方案的分类

示例 `review-council` 的主形态是：

- 控制流：`graph`；
- 图内结构：三个 reviewer fan-out，chair gather/synthesis；
- Agent 行为：Role Profile 驱动的 role-playing；
- 决策方式：独立评审结果加证据保真的 coordinator synthesis；
- Provider：可替换 command adapter；
- 状态：本地文件 Run Store。

因此它不是单一的“fan-out”或“role-playing”架构，而是多个正交模式的组合；真正决定 runtime 控制循环的是 `graph`。

## 4. 推荐演进顺序

1. 先在 `graph` 上补齐条件边、gate/HITL 节点和可复用 workflow 模板。
2. 出现中心调度者反复观察和派工的需求时，实现 `supervisor` Adapter。
3. 出现 Agent 自主转交控制权、下一执行者运行时才确定的需求时，实现 `handoff` Adapter。
4. 出现开放式发言队列、动态成员或终止条件时，实现 `group-chat` Adapter。
5. 共享状态、远程协议和持久队列分别扩展 backend/Provider/MCP 层，不与控制流 Adapter 混写。

每次新增 Adapter 都应至少包含配置 Schema、语义校验、计划格式、文本与 Mermaid 表示、执行测试，以及失败/恢复语义。

## 5. 注册自定义 Adapter

Library 调用方可以在默认 registry 上注册实现，并将同一个 registry 同时传给 manifest 校验、计划编译和运行：

```ts
import {
  createDefaultArchitectureRegistry,
  loadManifest,
  registerArchitectureAdapter,
  runWorkflow
} from "multi-agent-architecture-kit";

const architectures = createDefaultArchitectureRegistry();
registerArchitectureAdapter(architectures, mySupervisorAdapter);

const loaded = loadManifest("multi-agent.yaml", { architectures });
await runWorkflow(loaded, "supervised-review", { architectures });
```

默认 CLI 只注册 `graph`。未来 Plugin 或专用 CLI 可以在启动时装载更多 Adapter，而无需修改 manifest loader 或通用 Runtime。
