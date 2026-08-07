# Changelog — Memory 系统

跨会话经验记忆子系统：运行结束后自动提炼可复用经验，按 employee/project 维度按需检索，避免全量注入省 token。以下按合并到 `main` 的顺序记录（含真实 commit）。

> 范围：`f8d528f … 69f061d`（`5633674` 属并行的 Futaba 主题工作，不在本系列内）。
> 累计（memory 相关文件）：19 文件，约 +3372 行（含设计/计划/文档与测试）。

---

## 1. Memory 系统核心 — `f8d528f`

跨会话、按需检索的 memory 基础设施，作为衍生的、尽力而为的旁路，任何故障不影响主运行链路与 Run 证据。

- **存储** `src/memory/store.ts`：文件式 `MemoryStore`（仿 `artifacts/runs/`，不进 state.json），records/ 一条一文件 + index/ 按 scope 分片；原子写、软删除、`reindex` 重建、`listByScope`。
- **检索** `src/memory/retriever.ts`：复用 knowledge 的词项重叠打分（非向量）+ 预算裁剪；只加载相关 scope 分片；带 `[M#]` citation。
- **提炼** `src/memory/extractor.ts` + `extractionGate.ts`：运行后异步提炼；价值 gate 筛选；幂等（按 runId）；提炼失败降级不影响主链路。
- **类型** `src/memory/types.ts`；接入 `WorkbenchService`（异步触发 + `searchMemory`）；MCP 工具 `search_memory` + daemon `POST /api/memory/search`；CLI `memory search/archive/reindex`。
- **横切**：展示层 `formatDateTime`（存储仍 ISO 8601，只在 UI/CLI 格式化）。
- 设计/计划：`docs/superpowers/specs|plans/2026-08-06-memory-system*`。

## 2. 后台「记忆档案」查看页 — `242ba6a`

只读浏览 UI，让 memory 可视。

- 后端补只读接口：`MemoryStore.listScopes` + `WorkbenchService.listMemoryScopes/listMemoryByScope` + `GET /api/memory/scopes`、`GET /api/memory/scope?key=`。
- 前端 `client/src/MemoryPage.tsx`（三栏：scope 列表 / 记录+搜索+active-archived 过滤 / 详情 summary 高亮+展开+跳转运行卷宗）；导航新增「记忆档案」+ 图标；App 加 `pendingRunId` 跨页跳转。
- 只读——归档/删除仍走 CLI，后台不设写入口。
- 设计/计划：`docs/superpowers/specs|plans/2026-08-07-memory-viewer-page*`。

## 3. 修复：成功运行不产出 memory — `3c75817`

**根因**：价值 gate 判 `status === "completed"`，但 runner 从不发这个——成功运行的真实状态是 `"passed"`（`WorkflowRunStatus = running|passed|blocked|failed`）。导致任何成功运行都过不了 gate；且多节点 workflow 路径根本没接提炼触发。

- `extractionGate` 改判 `"passed"`；
- `runTrackedWorkflow` 为 supervisor 运行接提炼触发（scope = supervisor employee + project），graph/直接调用保留原触发不双触发；
- 修正被假状态掩盖的单测，新增真实 supervisor 运行的集成测试。

## 4. 提炼器员工模板 + 干净 content — `6ec633a`

让 content 从规则摘要变成真 LLM 提炼。

- 模板：`codex-memory-summarizer.provider.json`（codex，不挂 MCP）+ `memory-summarizer.employee.json`（global scope，`{summary}` 输出）。系统按固定 id `memory-summarizer` 自动识别。
- `summarizerContent()` helper：结构化 output 取 `summary` 字段，避免 codex JSON 被 stringify 成噪声。
- 文档补配置步骤；顺带修一个遗留的测试 typecheck 缺陷。

## 5. 修复：提炼输入纳入运行证据 — `38eaf5c`

**根因**：提炼器输入只有 runId/status/节点名，codex 无从提炼（真跑返回“无法提炼具体可复用经验”）。

- `RunLike` 扩展带 node.output + run.output；新增 `buildRunEvidence()`（渲染节点状态+产出+最终结果，8000 字上限）喂给提炼器。
- **真实端到端验证通过**：多节点 supervisor 运行 → 提炼出有实质价值的经验（如「多角色需求应先固化产品边界与验收原文，再并行产出工程与测试；未决项单列而非整体阻塞」）。

## 6. 运维与排障文档 — `69f061d`

`docs/memory-system.md` 新增「运维与排障」：daemon 跑长驻 dist/ 需 rebuild+重启才生效、只有过 gate 的运行才产出、提炼异步分钟级延迟、content 空话/规则摘要的成因、故障不影响主链路。

---

## 已知边界（当前**未**实现）

向量/语义检索、记忆衰减/淘汰、preference 自动注入、Agent 运行中主动写、以「用户」为维度的归属——均为非目标。

## 运维要点（务必知道）

- 改 `src/` 下 memory 代码后，daemon 不会自动用新代码：需 `npm run build` + 重启 daemon（kill 端口 4318 进程会自动拉起新进程）。
- 只有多节点 supervisor 运行、或 failed/blocked 运行才提炼；单节点成功调用按设计跳过。
- content 为真 LLM 文本依赖本地 `codex` 可用；否则降级为规则摘要。
