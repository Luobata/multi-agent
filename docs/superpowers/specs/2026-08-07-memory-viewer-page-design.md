# Memory 后台查看页设计

状态：设计待评审
日期：2026-08-07
主题：为工作台后台新增只读的 Memory 台账浏览页（浏览 + 搜索 + 跳转运行卷宗）

## 1. 背景与目标

memory 系统已上线（见 `docs/superpowers/specs/2026-08-06-memory-system-design.md`），但目前只能通过 CLI / MCP / daemon HTTP 查看。用户希望在**后台 UI（档案室客户端）**里有一个查看入口。

探查确认：当前 client 代码 memory 出现 0 次——后台**没有**任何 memory 入口。现有 8 个导航页：员工大厅/员工档案/项目接入/技能台账/知识库/协作编排/运行卷宗/调用包。

**目标**：新增一个只读「记忆档案」页，能按 scope 浏览全部 memory、关键词搜索、查看详情并跳转到对应运行卷宗。

### 现状缺口

现有 daemon 只有 `POST /api/memory/search`——**必须带 query 才能检索**（词项打分），无法"空手浏览全部"。因此需补 list 接口。

### 非目标（YAGNI）

- UI 不做归档/删除操作（CLI `memory archive` 已有，避免后台变成误删入口）。
- 不做编辑、不做手动新增（memory 是自动提炼的衍生物）。
- 不做向量检索、不改现有检索算法。

## 2. 后端：补 list 接口

`MemoryStore` 现有 `listByScope(scopeKey)`，只差把 scope 清单暴露出来。新增：

- `MemoryStore.listScopes(): Promise<Array<{ scopeKey: string; count: number }>>` — 扫 `index/` 目录，返回所有 scope 分片及各自记录数。
- `WorkbenchService.listMemoryScopes()` → 代理上述方法。
- `WorkbenchService.listMemoryByScope(scopeKey)` → 代理 `MemoryStore.listByScope`，返回该 scope 下全部记录（含 archived，由前端过滤）。

新增两个只读 daemon 路由（照现有 GET 路由模式）：

- `GET /api/memory/scopes` → `{ scopes: [{ scopeKey, count }] }`
- `GET /api/memory/scope?key=<scopeKey>` → `{ records: [MemoryRecord] }`

检索仍复用 `POST /api/memory/search`。

## 3. 前端：MemoryPage.tsx（仿 RunsPage 三栏）

新增导航项「记忆档案」，插在「运行卷宗」之后（性质最像——都是只读运行衍生物）。页面组织：

- **左栏 · scope 列表**：按 employee / project 两组分区，每项显示 scopeKey 与条数。选中一个 scope。
- **中栏 · memory 列表**：列出选中 scope 下的 memory（标题 + `displayCreatedAt` + kind 标记）。顶部搜索框：有关键词走 `/api/memory/search`（打分排序），空则展示该 scope 全部。可过滤 active / archived。
- **右栏 · 详情**：
  - 默认**高亮展示 summary**（标题 + content）。
  - 点击展开**完整详情**：kind、时间（formatDateTime）、归属 scope、溯源字段（runId / traceId / invocationId / score）。
  - runId 做成**跳转「运行卷宗」**的链接。

复用现有共享组件 `DossierSection` / `EmptyState` / `SelectControl` / `Stamp` / `formatTime`，遵循 design.md 像素档案风格，不引入新样式体系。

## 4. 跨页跳转（运行卷宗）

第一版实现**真跳转**：点详情里的 runId → 切到「运行卷宗」页并定位到该 run。

实现方式：在 App.tsx 加一点跨页状态（一个 `pendingRunId`），导航到 runs 页时传给 RunsPage，RunsPage 在加载后据此选中/滚动到目标 run。这是受控的小改动，会触及 App.tsx 与 RunsPage.tsx。

## 5. 错误处理

- list / search 接口失败 → 前端降级为空态 + 提示，不崩页（照现有页面 try/catch 模式）。
- scope 列表为空（系统尚未产生 memory）→ 显示 EmptyState，说明"memory 在员工运行结束后自动提炼产生"。
- 跳转的 runId 在运行卷宗中不存在（已被清理）→ 运行卷宗正常展示列表，不定位，不报错。

## 6. 测试策略

- **后端**：`listMemoryScopes` / `listMemoryByScope` 单测（空库、多 scope、archived 记录一并返回）；两个 GET 路由的契约测试。
- **前端**：仿 `RunsPage.test.tsx` / `App.navigation.test.tsx`——测导航项「记忆档案」出现、scope 列表渲染、选中 scope 列出 memory、详情展开、runId 跳转触发页面切换。

## 7. 组件边界小结

| 组件 | 职责 | 依赖 |
|---|---|---|
| `MemoryStore.listScopes` | 扫 index/ 返回 scope 清单 + 条数 | 文件系统 |
| `WorkbenchService.listMemoryScopes/listMemoryByScope` | 服务层代理 | MemoryStore |
| daemon `GET /api/memory/scopes`、`/api/memory/scope` | 只读 HTTP 入口 | WorkbenchService |
| `MemoryPage.tsx` | 三栏浏览/搜索/详情 UI | api、共享组件 |
| App.tsx `pendingRunId` | 跨页跳转状态 | RunsPage |
