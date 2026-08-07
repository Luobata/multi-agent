# Memory 系统

本地优先的跨会话经验记忆。员工每次运行结束后，系统会异步把这次运行里可复用的经验精炼成一条紧凑记录并落盘；平时**不注入**任何 memory，只有在需要时才通过检索入口按 employee/project 维度按需取回，从而避免把历史全量塞进上下文、省 token。

## Memory 是什么

- 一条 memory 是对**一次运行**的可复用经验精炼（当前实现只产出 `run-summary` 一种）。
- 记录带来源证据（runId / traceId / invocationId / caller），检索时以 `[M#]` 形式给出引用编号，便于溯源。
- 存储与展示分离：落盘时间戳用 ISO 8601（保证排序与 `Date.parse` 兼容），展示层用 `formatDateTime` 转成本地时区的 `YYYY-MM-DD HH:mm:ss`。

## 目录结构

数据根目录默认 `~/.multi-agent/workbench/`（可用环境变量 `MULTI_AGENT_DATA_DIR` 覆盖），memory 子树位于：

```
~/.multi-agent/workbench/memory/
  records/                     # 一条 memory 一个 JSON 文件（<id>.json），全量事实
  index/                       # 按 scope 分片的倒排：<dimension>__<id>.json，内含 memoryIds 列表
    employee__<employeeId>.json
    project__<projectId>.json
```

- `records/` 是唯一事实源；`index/` 只是加速检索的分片，可随时用 `reindex` 从 `records/` 全量重建。
- 写入用「临时文件 + rename」原子落盘，避免半写文件。

## 自动提炼：触发时机与降级

提炼发生在**员工运行结束后**，作为异步旁路执行，特点如下：

- **触发点**：一次员工调用的运行完成后触发，绝不阻塞调用返回。
- **价值 gate 筛选**（`shouldExtract`）：
  - `cancelled` 运行：跳过。
  - `failed` / `blocked` 运行：提炼（失败经验也可复用）。
  - `completed` 且只有单节点：跳过（琐碎运行）。
  - `completed` 且多节点：提炼。
- **提炼器**：优先复用内部提炼器 Employee（id `memory-summarizer`）；若该员工不存在或调用抛错，则**降级为规则摘要**（记录运行状态与节点数），保证始终能落盘。
- **幂等**：同一 `runId` 的 `run-summary` 已存在时直接返回已有记录，不重复写。
- **失败降级**：整个提炼链路 best-effort，任何异常都被吞掉，绝不影响主运行链路。
- **防递归**：提炼器 Employee 自身的运行不再触发提炼。

## 归属维度（scope）

每条记录归属两个维度：

- `employee`：`employeeId`（记录同时保存 `employeeVersion`）。
- `project`：`projectId`（仅当该次运行带项目归属时才有）。

检索时按传入的 employee / project 维度只加载对应分片，不扫全局。

## 检索入口

三个入口最终都走 `WorkbenchService.searchMemory`：

1. **`search_memory` MCP 工具**：供 Agent 按需调用。参数 `query`（必填）、`employeeId`、`projectId`、`limit`（1–40）、`kind`。经 daemon 代理。
2. **Daemon HTTP**：`POST /api/memory/search`，body 为 `{ query, employeeId?, projectId?, limit?, kind? }`，返回 `{ evidence: [...] }`。
3. **CLI**：见下。

检索行为：

- 只在传入 scope 的分片内检索，过滤掉非 `active`（已归档）记录与非目标 `kind`（默认 `run-summary`）。
- 打分基于查询词与记录标题 / 正文的词项重叠（标题命中加权），得分为 0 的记录被剔除，按分数、再按 `createdAt` 倒序排序。
- token 预算：累计 token 超过上限（4000）后停止追加，`limit` 默认 5、上限 40。
- 每条结果带 `citationId`（`M1`、`M2`…）、`memoryId`、`kind`、`title`、`content`、`traceId`、`score`、`createdAt`。

## CLI 用法

```bash
# 检索（按需，可限定 scope / 条数 / kind）
workbench memory search "<query>" [--employee <id>] [--project <id>] [--limit <n>] [--kind run-summary|node-detail|preference]

# 软删除（归档）一条记录
workbench memory archive <id>

# 从 records/ 全量重建 index/ 分片
workbench memory reindex
```

`memory search` 输出在原始字段基础上追加 `displayCreatedAt`（本地时区 `YYYY-MM-DD HH:mm:ss`），原始 `createdAt`（ISO 8601）保留不变。

## 改 / 删 / 生命周期

- **软删除**：`archive` 把记录 `status` 置为 `archived`，文件保留，检索时被过滤，不物理删除。
- 数据类型预留了 `supersedesId` 字段用于「新版本取代旧记录」的关系，当前尚未有自动 supersede 流程。

## 时间戳

- 存储层：`createdAt` 一律 ISO 8601。
- 展示层：`formatDateTime(iso)` 输出本地时区 `YYYY-MM-DD HH:mm:ss`；非法或空输入原样返回。

## 非目标（当前**未**实现）

以下能力不在当前实现范围内，文档不描述其行为：

- 向量 / 语义检索（当前只有本地词项重叠打分）。
- 记忆衰减 / 自动淘汰 / 过期清理。
- 偏好（preference）的自动注入到运行上下文（`preference` 只是预留的 kind 枚举，无自动写入与注入链路）。
- Agent 运行中主动写 memory（写入只由运行结束后的自动提炼触发）。
- 新的「用户」实体或以用户为维度的归属（归属只有 employee / project）。
