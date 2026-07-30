# 多 Agent 常用模式与可视化编排 v1

## 1. 结论

当前项目的运行核心属于 **Graph / Workflow**：节点在编译期确定，`needs[]` 声明一个静态 DAG。员工档案又提供了 **Role-playing / SOP** 的身份层；员工可被 MCP 或 A2A 单独调用时，使用方式接近 **Agents-as-tools**。

因此，v1 不为每一种常见模式新增 Architecture Adapter。能被静态 DAG 忠实表达的模式做成 **Graph Template**；只有动态路由、循环收敛、运行时 handoff 等 Graph 不能表达的语义，未来才增加新的 Adapter。

参考分类：[Multi-Agent Patterns Wiki](https://multi-agent.wiki/patterns)。

## 2. 常见模式归类

| 模式 | 静态 Graph 可表达 | 本项目处理方式 |
| --- | --- | --- |
| Sequential Pipeline | 完整支持 | v1 模板 |
| Parallel Fan-out / Gather | 完整支持 | v1 模板 |
| Debate / Judge、Review Council | 固定评审轮次支持 | v1 固定 DAG 模板 |
| Plan–Execute–Synthesize | 固定执行线支持 | v1 模板 |
| Generator–Critic | 单轮支持 | 可由顺序模板手工改造，后续模板扩展 |
| Supervisor / Manager | 只支持固定派单 | 固定派单可做模板；动态派单留给未来 Adapter |
| Conditional Router / Handoff | 不完整 | 未来 Adapter |
| Refinement Loop | 不支持动态收敛循环 | 未来 Adapter |
| Group Chat / Blackboard | 需要共享状态与发言调度 | 未来 Adapter |

## 3. v1 模板

### Sequential Pipeline

`定义 → 执行 → 验收`。适合需求澄清、实现与验收边界清晰的交付链路。并发为 1，默认 fail-fast。

### Parallel Fan-out / Gather

`并行 A + 并行 B → 汇总`。适合两个独立专业视角并行工作，最后合并冲突与证据。

### Review Council

`主笔 → 产品评审 + 交付评审 → 裁决`。这是固定轮次的 Debate / Judge，不承诺运行时追加评审轮次。

### Plan–Execute–Synthesize

`规划 → 执行 A + 执行 B → 综合`。适合较大任务先对齐接口和验收标准，再并行交付。

所有模板都只生成以下普通 Graph 数据：

```jsonc
{
  "architecture": "graph",
  "patternId": "parallel-fanout-gather",
  "nodes": [
    { "id": "track-a", "employeeId": "...", "needs": [], "with": {} },
    { "id": "track-b", "employeeId": "...", "needs": [], "with": {} },
    { "id": "synthesize", "employeeId": "...", "needs": ["track-a", "track-b"], "with": {} }
  ]
}
```

`patternId` 只记录来源，不参与运行时调度。

## 4. 编排交互

用户路径：

1. 选择架构模板。
2. 将本地员工映射到角色槽位；同一员工可以承担多个槽位。
3. 生成未保存的 Graph 草稿。
4. 在画布拖动节点调整布局。
5. 在节点检查器中改派员工、修改 `needs`、编辑 `with`。
6. 前端做即时预检，保存时由 TypeScript Graph 核心做权威校验。
7. 保存产生 Workflow 新版本，随后可运行或通过 A2A 对外发布。

### 画布事实边界

- 拖动节点只修改 `presentation.positions`，不改变执行语义。
- 依赖编辑只修改下游节点的 `needs[]`。
- UI 坐标与 `patternId` 不进入运行清单。
- 自动排版按 DAG 深度分层，只修改坐标。
- 循环、重复节点、悬空依赖在保存前阻断。

## 5. Skill 生命周期

全局 Skill 与员工绑定是两个层次：

| 操作 | 作用域 | 语义 |
| --- | --- | --- |
| 注册 / 修订 | 全局 Skill | 修订产生 Skill 新版本 |
| 归档 / 恢复 | 全局 Skill | 归档后不再允许常规新增绑定；历史版本继续保留 |
| 绑定 / 解绑 | 单个员工 | 保存产生 Employee 新版本 |
| 启用 / 停用 | 单个员工绑定 | 停用后保留配置和固定版本，但运行时不注入指令或工具 |
| 修改配置 | 单个员工绑定 | 按 Skill JSON Schema 校验后保存 |

绑定契约：

```ts
type RoleSkillBinding = string | {
  id: string;
  config?: JsonObject;
  enabled?: boolean;
};
```

`enabled: false` 的绑定仍出现在上下文检查器中，便于审计；它不会进入 effective prompt，也不会贡献工具声明。

## 6. UI 设计原则

界面复用参考图的结构 DNA：标题与统计、主操作、高密度台账、状态列、行级操作和检查器；视觉皮肤继续使用已有的暖灰纸张、宋体标题、朱红索引、绿色状态印章、双线边框与硬阴影。

信息层级分为：

1. 页面纸面：检索、统计、过滤。
2. 可操作记录：悬停时出现左侧朱红索引与轻量抬升。
3. 编辑层：Modal / Inspector 使用双线框和更强硬阴影。

避免冷白蓝色 SaaS 皮肤、过度圆角、玻璃拟态和每块内容都卡片化。

## 7. 后续 Adapter 判定

新增模式时先问三个问题：

1. 节点和边能否在运行前全部确定？
2. 是否不需要循环、条件跳转或运行时控制权转移？
3. 展开成普通 DAG 后，模式语义是否仍然真实？

三个答案都是“是”时，增加模板或策略；否则再设计独立 Architecture Adapter。候选优先级：

1. Conditional Router / Supervisor。
2. Refinement Loop / Generator–Critic loop。
3. Handoff / Swarm。
4. Group Chat / Blackboard shared-state runtime。

## 8. v1 验收

- 两名新员工有独立身份、提示词和 Provider，初始 Skill 为空。
- Skill 可注册、查看、版本化修订、归档和恢复。
- 员工 Skill 可绑定、解绑、改配置并独立启停。
- 停用 Skill 后 effective prompt 不包含其指令。
- 四个模板都能生成合法 DAG，并允许重复员工槽位映射。
- 节点可拖动，位置可保存；拖动不改变 `needs`。
- 画布可改派员工、修改依赖和 `with`。
- 保存时继续使用现有 Graph Adapter 校验与运行。
