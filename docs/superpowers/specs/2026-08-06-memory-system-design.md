# Memory 系统设计

状态：设计待评审
日期：2026-08-06
主题：为本地多 Agent 工作台新增按需检索的 memory 系统

## 1. 背景与目标

用户希望给多 Agent 工作台新增 memory 系统，让 Agent 可以**跨会话检索**过去的运行经验与偏好，而不是把全量历史注入 prompt（浪费 token）——需要时才检索。

### 消费者与价值

- **消费者**：LLM（Agent 运行时）。
- **核心价值**：按需检索而非全量注入以省 token；同时记住偏好。

### 现状约束（探查所得）

项目已有两套「留档」机制，memory 要提供的是它们之外的价值：

- `EmployeeSession`（`src/workbench/types.ts:327`）：存 `state.json` 的 sessions map，`messages[]` 每条带 `runId`，按 `contextPolicy.historyLimit` 截断。
- Run Store（`src/runtime/artifacts.ts`）：不可变证据目录 `~/.multi-agent/workbench/artifacts/runs/<runId>/`，含 `run.json`、`events.jsonl`、各节点 `attempt-N` 输入输出。**不进 state.json**——正是为了应对高频、增长型数据。

memory 是对这些原始证据的**精炼、可跨会话检索**的衍生层，不复制原文。

### 非目标（MVP 明确不做）

- 向量检索（沿用现有词项重叠打分，接口预留可替换）。
- 版本链、衰减淘汰、物理 GC（软删除已为未来留位）。
- agent 主动写入、偏好自动注入（预留 `kind: preference` 与 `supersedesId`，第一版不实现写入路径）。
- 引入新的「用户」实体（归属只用 employee + project）。
- 修改全系统存储时间戳格式（见 §8 决策）。

## 2. 架构决策

**方案 B：独立 Memory 子系统，与 Run Store 平级。**

新建 `MemoryStore`（文件式、追加导向，结构上仿 `artifacts/runs/`），拥有自己的记录类型与轻量增量索引；**复用 knowledge 的打分函数与预算裁剪逻辑**，沿用 `Resolver→Router→Retriever→Budget` 的分层范式，但**不套** knowledge 的 revision / 发布指针 / 人工审批模型（那是为人工策展设计的，与自动提炼冲突）。

### 被否决的方案

- **方案 A（memory 当特殊知识库）**：复用最大，但 knowledge 的 revision + 审批语义与「高频自动追加」根本冲突，硬套会别扭。
- **方案 C（memory 进 state.json 版本化）**：完全复用持久化层，但 state.json 是单文件 + 全局锁，memory 随运行无限增长会撑爆单文件、加剧锁竞争。项目本身把 Run 证据踢出 state.json 就是这个原因。规模一大即崩。

**选择理由**：memory 是高频写入 + 规模持续增长的数据，与 Run 证据同源，应采用同样的独立文件目录策略；同时复用 knowledge 的检索范式以保持一致的检索语义（`[K#]` 风格 citation）。

## 3. 数据模型与目录结构

```
~/.multi-agent/workbench/memory/
  records/<memoryId>.json     # 一条 memory = 一个文件（追加导向，不进 state.json）
  index/<scopeKey>.json       # 按 scope 分片的词项索引
```

`scopeKey` 形如 `employee:<employeeId>` 或 `project:<projectId>`——检索只加载相关分片，不扫全局。

### MemoryRecord

```jsonc
{
  "id": "mem_...",                 // 稳定唯一 id
  "scope": {
    "employeeId": "local-researcher",
    "employeeVersion": 7,          // 提炼时固定，溯源用
    "projectId": "cart-fe"         // 可空（非项目调用时）
  },
  "kind": "run-summary" | "node-detail" | "preference",  // MVP 用前两类；preference 预留
  "title": "前端购物车改价交付",
  "content": "提炼后的精炼文本（非原始会话）",
  "provenance": {                  // 溯源：指回不可变证据，不复制原文
    "runId": "run_...",
    "traceId": "run_...",          // 同一次运行的多条 memory 共享，支持下钻
    "invocationId": "inv_...",
    "nodeId": "frontend-task",     // 仅 node-detail
    "source": { "caller": "reviewer", "contextId": "thread-x" }  // 取自 InvocationSource
  },
  "status": "active" | "archived", // 软删除，不物理删
  "tokens": 128,                   // 预估 token，检索预算裁剪用（复用 knowledge estimateTokens）
  "createdAt": "2026-08-06T22:11:00.000Z",  // 存 ISO 8601；展示时格式化
  "supersedesId": null             // 偏好取代链；MVP 可空
}
```

设计要点：

1. **content 存提炼文本而非原始会话**——原始证据经 `provenance.runId/nodeId` 指回 Run Store。存储层就不全量，呼应「按需省 token」的初衷。
2. **软删除 + status 字段**，不套 knowledge 的 revision/审批链。
3. **按 scope 分片索引**——检索只加载相关分片，是规模增长后仍快的关键。
4. **traceId** 关联一次 supervisor 运行的运行级摘要与节点细条，支持下钻。

## 4. 写入流程（自动提炼）

挂在运行结束后，daemon 内**异步执行**，不阻塞调用方返回。

```
runWorkflow 完成 → runner 发出 run.completed
  → MemoryExtractor.onRunComplete(runId)
      1. 加载 Run 证据（run.json + events.jsonl + 节点 attempt 输出）
      2. 价值筛选 gate：这次运行值不值得沉淀？
      3. 用提炼器 Employee 提炼成 1 条运行级摘要（+ 可选高价值节点细条）
      4. 去重：与该 scope 已有 memory 比对，重复则跳过/合并
      5. 写入 MemoryStore + 更新 scope 索引
```

### 价值筛选 gate（先规则，后 LLM）

- 规则层先过滤：`failed/blocked/cancelled` 的运行 → 判断是否有可复用教训；`completed` 且 trivial（如单节点 mock 调用）→ 跳过。
- 通过规则层的才交给 LLM 提炼，省提炼成本。
- 对应用户诉求：「有效的才存，异常情况判断有无必要留」。

### 提炼器

**复用现有 Employee/Provider 机制**，配一个内部「提炼器员工」跑提炼 prompt（类比 knowledge 后台的受限 Codex 员工）。模型、prompt、脱敏都走现有 Provider 边界，不硬编码新的 LLM 调用。

### 关键属性

- **失败不影响主流程**：提炼是尽力而为的旁路，失败只记日志。Run 证据始终是权威。
- **幂等**：以 `runId` 为幂等键，同一 run 重复触发只写一次（防 daemon 重启重复提炼）。

## 5. 检索流程（按需工具）

**入口**：新增 MCP 工具 `search_memory`，agent 需要时主动调用，平时不注入 prompt。

```jsonc
{
  "tool": "search_memory",
  "arguments": {
    "query": "上次这个前端改价任务怎么做的",
    "scope": { "employeeId": "...", "projectId": "..." },  // 默认由调用上下文自动填
    "limit": 5,
    "kind": "run-summary"   // 默认只返回运行级摘要
  }
}
```

### 流程（复用 knowledge 骨架）

```
1. 解析 scope → 确定加载哪些 scope 索引分片（employee/project）
2. 只加载相关分片（不扫全局）  ← 效率核心
3. scoreChunk 词项重叠打分（复用 src/knowledge/retriever.ts 的打分函数）
4. 预算裁剪：limit + token 上限（复用 KnowledgeBudget）
5. 默认只返回 run-summary 层；带 traceId 可下钻
6. 返回带 [M#] citation 的结果（对齐 knowledge 的 [K#] 风格）
```

### scope 默认行为

检索 scope 默认由调用上下文自动填：agent 在项目 X 里跑，默认查项目 X + 自己（employee）的 memory；agent 也可显式指定跨 scope 查。

### 效率权衡（回答需求 Q2）

| 手段 | 作用 |
|---|---|
| 按需检索（不注入） | 不需要就零开销 |
| scope 分片索引 | 只扫该 employee/project 的 memory，不扫全库 |
| 预算裁剪 | limit + token 上限，复用 knowledge 的 maxChunks/maxTokens |

### 下钻（回答需求 Q3：supervisor 聚合）

一次 supervisor 运行天然产生多条节点级记录（声明式 DAG，每节点独立 WorkInstance + 领队多轮 + 多 gate）。采用**轻量两层**：

- 默认每次运行提炼 **1 条运行级摘要**。
- 仅当某节点独立高价值（如失败后恢复、关键决策）才额外存节点级细条，与摘要共享 `traceId`。
- 检索默认返回运行级摘要，需要细节时用 `traceId` 再查 `kind: node-detail` 下钻。
- **不强制双写**，避免检索噪声。

### 打分算法

沿用 knowledge 的词项重叠打分（非向量），规模不大时够用且零依赖。未来升级向量检索只需替换 `scoreChunk`，接口不变。

## 6. 改 / 删 与生命周期

### 改（update）

memory 记录基本不可变（它是某次运行的提炼快照）。唯一的「改」语义是**偏好取代**：新偏好与旧偏好冲突时，写新记录 + 旧记录置 `status: archived` + 新记录 `supersedesId` 指向旧的，保留溯源链，不原地覆盖。MVP 偏好类为预留，故第一版「改」基本只体现为归档。

### 删（delete）

软删除：只置 `status: archived`，不物理删文件；检索默认只返回 `active`。物理清理（GC/淘汰）留给未来。提供 CLI `memory archive <id>` 供人手动归档误存/过期条目。

### 为何不做版本链/衰减淘汰

YAGNI。用户选了精瘦 MVP，这些是明确的「未来」。软删除 + status 字段已为未来留好扩展位。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 提炼失败（LLM 报错/超时） | 记日志，跳过。memory 缺一条不影响任何功能 |
| 索引损坏/缺失 | 检索降级为空结果 + 日志；提供 `memory reindex` 从 records/ 重建 |
| 并发写（多 run 同时提炼） | 复用项目文件锁模式（仿 WorkbenchStore 序列化写），或按 scope 分片锁 |
| daemon 重启中断提炼 | `runId` 幂等键，重启后可安全重触发，不重复 |
| scope 缺失（无 project 的调用） | projectId 可空，只按 employee 存/查 |

**核心原则**：memory 是衍生的、尽力而为的便利层。其任何故障都不能影响主运行链路与 Run 证据——这是它能安全加进系统的前提。

## 8. 横切项：时间戳展示

**决策**：存储层继续用 ISO 8601 不动；只新增展示层格式化。

**证据**：系统 10+ 处依赖 ISO 8601 字典序做时间排序（`src/workbench/service.ts:1700/2658/3897/5972` 等的 `updatedAt.localeCompare` / `createdAt.localeCompare`）以及 `Date.parse`（`service.ts:1337`）。改存储格式为中文年月日会破坏这些排序与配置验证，且新旧数据无法比较。

**做法**：新增展示层工具 `formatDateTime(iso): string`，在 UI/CLI 输出时把 ISO 格式化为 `YYYY-MM-DD HH:mm:ss`。memory 的 `createdAt` 存 ISO、展示时格式化，与全系统一致。此项为横切项，不限于 memory。

## 9. 测试策略

复用现有 vitest。

- **单元**：价值筛选 gate 规则、scoreChunk 打分、预算裁剪、软删除过滤、`formatDateTime` 格式化。
- **集成**：MemoryStore 读写 + 索引重建；提炼器对 mock Run 证据的端到端提炼（用 mock provider，不打真实模型）。
- **检索**：给定一组 memory + query，验证 scope 过滤、排序、limit/token 裁剪、traceId 下钻。
- **回归**：注入必失败的提炼器，断言主运行链路与 Run 正常完成不受影响。

## 10. 组件边界小结

| 组件 | 职责 | 依赖 |
|---|---|---|
| `MemoryStore` | records/ 与 index/ 的读写、软删除、重建索引 | 文件系统、文件锁 |
| `MemoryExtractor` | 运行后价值筛选 + 调提炼器 Employee + 去重写入 | Run Store、Employee/Provider、MemoryStore |
| `MemoryRetriever` | scope 分片加载 + 打分 + 预算裁剪 + 下钻 | MemoryStore、复用 knowledge 打分/预算 |
| `search_memory` MCP 工具 | 检索入口，scope 默认填充 | MemoryRetriever、WorkbenchService |
| `formatDateTime` | 展示层时间格式化（横切） | 无 |
| CLI `memory archive/reindex` | 人工归档与索引重建 | MemoryStore |
```
