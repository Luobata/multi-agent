# Memory 后台查看页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作台后台新增只读「记忆档案」页——按 scope 浏览全部 memory、关键词搜索、查看详情并跳转运行卷宗。

**Architecture:** 后端补两个只读 list 接口（MemoryStore.listScopes + service 代理 + daemon GET 路由）；前端新增 MemoryPage.tsx（仿 RunsPage 三栏），接入导航；跨页跳转用 App.tsx 的 pendingRunId 状态传给 RunsPage。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀), Express (daemon), React 19 (client), vitest + jsdom。

## Global Constraints

- ESM 模块，import 路径带 `.js` 后缀。
- daemon 路由照现有模式：`app.get(path, asyncRoute(async (request, response) => { send(response, ...) }))`；辅助函数 `send`、`routeParam`、`booleanQuery` 已存在于 src/daemon/server.ts。
- MemoryStore 现有：`listByScope(scopeKey)`、`index/` 目录（文件名 `<dimension>__<id>.json`，如 `employee__researcher.json`）、`scopeKeyToFileName`、`readJson`、`safeId`。索引文件结构 `{ scopeKey: string; memoryIds: string[] }`。
- 前端调用统一用 `api<T>(pathname, init?)`（client/src/api.ts）；无 per-endpoint 封装。
- 前端时间展示用现有 `formatTime`（client/src/components.tsx，输出 `MM-DD HH:mm`）。共享组件：`DossierSection`、`EmptyState`、`SelectControl`、`Stamp`、`ReadonlyEvidence`、`scrollRecordIntoView`、`Icon`。
- 遵循 design.md 像素/蜡笔档案风格，不引入新样式体系；`Icon` 的 name 是封闭联合类型，加页面必须同步扩展它。
- 只读：UI 不做归档/删除/编辑。
- 测试用 vitest；后端用临时目录 `fs.mkdtemp`，前端仿现有 `RunsPage.test.tsx` / `App.navigation.test.tsx`。

---

### Task 1: MemoryStore.listScopes

**Files:**
- Modify: `src/memory/store.ts`（在 `listByScope` 后加方法）
- Test: `tests/memory-store.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `MemoryStore`、`ScopeIndex`、`readJson`、`this.root`。
- Produces: `async listScopes(): Promise<Array<{ scopeKey: string; count: number }>>` — 读 `index/` 目录下所有 `*.json`，每个解析出 `scopeKey` 与 `memoryIds.length`，按 scopeKey 升序返回；目录不存在或空返回 `[]`。

- [ ] **Step 1: 追加失败测试**

```typescript
// tests/memory-store.test.ts —— 在现有 describe("MemoryStore", ...) 内追加
  it("listScopes returns each scope key with its record count", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord({ id: "mem_1" }));
    await store.put(sampleRecord({ id: "mem_2" }));
    const scopes = await store.listScopes();
    // sampleRecord scope 同时落 employee:researcher 与 project:cart-fe
    const byKey = Object.fromEntries(scopes.map((s) => [s.scopeKey, s.count]));
    expect(byKey["employee:researcher"]).toBe(2);
    expect(byKey["project:cart-fe"]).toBe(2);
  });

  it("listScopes returns empty array on empty store", async () => {
    const store = await MemoryStore.open(dataRoot);
    expect(await store.listScopes()).toEqual([]);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: FAIL（`listScopes` 不是函数）

- [ ] **Step 3: 实现 listScopes**

```typescript
// src/memory/store.ts —— 在 listByScope 方法之后加入。
// index 文件名形如 employee__researcher.json；scopeKey 直接从文件内容读，避免反解析文件名。
  async listScopes(): Promise<Array<{ scopeKey: string; count: number }>> {
    const indexDir = path.join(this.root, "index");
    let files: string[];
    try {
      files = (await fs.readdir(indexDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const scopes: Array<{ scopeKey: string; count: number }> = [];
    for (const file of files) {
      const index = await readJson<ScopeIndex>(path.join(indexDir, file));
      if (!index) continue;
      scopes.push({ scopeKey: index.scopeKey, count: index.memoryIds.length });
    }
    scopes.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
    return scopes;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/memory-store.test.ts
git commit -m "feat: add MemoryStore.listScopes for browsing all memory scopes"
```

---

### Task 2: WorkbenchService memory list 方法

**Files:**
- Modify: `src/workbench/service.ts`（在 `reindexMemory` 后加两个方法）
- Test: `tests/memory-service-integration.test.ts`（追加用例）

**Interfaces:**
- Consumes: `this.memoryStore`（已注入，含 `listScopes`（Task 1）、`listByScope`）。
- Produces:
  - `async listMemoryScopes(): Promise<Array<{ scopeKey: string; count: number }>>` — 代理 `memoryStore.listScopes()`，失败返回 `[]`。
  - `async listMemoryByScope(scopeKey: string): Promise<MemoryRecord[]>` — 代理 `memoryStore.listByScope(scopeKey)`，失败返回 `[]`。

- [ ] **Step 1: 追加失败测试**

```typescript
// tests/memory-service-integration.test.ts —— 追加
  it("listMemoryScopes returns [] on a fresh service", async () => {
    const svc = await freshService();
    expect(await svc.listMemoryScopes()).toEqual([]);
  });

  it("listMemoryByScope returns [] for an unknown scope", async () => {
    const svc = await freshService();
    expect(await svc.listMemoryByScope("employee:nobody")).toEqual([]);
  });
```

> 注：`freshService()` 是该测试文件已有的辅助（`WorkbenchService.open({ dataRoot })`）。若未定义，仿文件内其他用例的建 service 方式。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-service-integration.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现两个方法**

```typescript
// src/workbench/service.ts —— 在 reindexMemory() 方法之后加入
  async listMemoryScopes(): Promise<Array<{ scopeKey: string; count: number }>> {
    try {
      return await this.memoryStore.listScopes();
    } catch {
      return [];
    }
  }

  async listMemoryByScope(scopeKey: string): Promise<MemoryRecord[]> {
    try {
      return await this.memoryStore.listByScope(scopeKey);
    } catch {
      return [];
    }
  }
```

> `MemoryRecord` 已在该文件 import（现有 memory 方法用到）。若未 import，加入 `import type { MemoryRecord } from "../memory/types.js";`（确认现有 import 行后再决定）。

- [ ] **Step 4: 运行测试确认通过 + 类型检查**

Run: `npx vitest run tests/memory-service-integration.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/memory-service-integration.test.ts
git commit -m "feat: add listMemoryScopes/listMemoryByScope to WorkbenchService"
```

---

### Task 3: Daemon 只读 list 路由

**Files:**
- Modify: `src/daemon/server.ts`（在 `POST /api/memory/search` 路由后加两个 GET 路由）
- Test: `tests/memory-mcp-route.test.ts`（追加 service 契约用例）

**Interfaces:**
- Consumes: `service.listMemoryScopes`、`service.listMemoryByScope`（Task 2）；辅助 `asyncRoute`、`send`、`request.query`。
- Produces:
  - `GET /api/memory/scopes` → `send(response, { scopes })`
  - `GET /api/memory/scope?key=<scopeKey>` → `send(response, { records })`（key 缺失时返回 `{ records: [] }`）

- [ ] **Step 1: 追加失败测试（service 契约层）**

```typescript
// tests/memory-mcp-route.test.ts —— 追加
  it("listMemoryScopes/listMemoryByScope match the GET route contract", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-list-"));
    const svc = await WorkbenchService.open({ dataRoot });
    expect(await svc.listMemoryScopes()).toEqual([]);
    expect(await svc.listMemoryByScope("employee:x")).toEqual([]);
  });
```

> 该文件已 import fs/os/path/WorkbenchService（现有用例用到）。若缺则补齐。

- [ ] **Step 2: 运行测试确认基线**

Run: `npx vitest run tests/memory-mcp-route.test.ts`
Expected: 若 Task 2 已完成则 PASS

- [ ] **Step 3: 加两个 GET 路由**

```typescript
// src/daemon/server.ts —— 紧接 app.post("/api/memory/search", ...) 之后加入
  app.get("/api/memory/scopes", asyncRoute(async (_request, response) => {
    send(response, { scopes: await service.listMemoryScopes() });
  }));
  app.get("/api/memory/scope", asyncRoute(async (request, response) => {
    const key = typeof request.query.key === "string" ? request.query.key : "";
    send(response, { records: key ? await service.listMemoryByScope(key) : [] });
  }));
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `npx vitest run tests/memory-mcp-route.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.ts tests/memory-mcp-route.test.ts
git commit -m "feat: add read-only GET /api/memory/scopes and /scope routes"
```

---

### Task 4: 前端 memory 类型 + api 封装

**Files:**
- Modify: `client/src/types.ts`（加 memory 类型）
- Test: 无独立测试（类型 + 薄封装，由后续页面测试覆盖）

**Interfaces:**
- Consumes: 无。
- Produces（client 侧类型，字段对齐 server `MemoryRecord`/`MemoryEvidence`）：
  - `MemoryKind = "run-summary" | "node-detail" | "preference"`
  - `MemoryScopeSummary { scopeKey: string; count: number }`
  - `MemoryRecord { id; scope: { employeeId: string; employeeVersion: number; projectId?: string }; kind: MemoryKind; title: string; content: string; provenance: { runId: string; traceId: string; invocationId?: string; nodeId?: string; source?: { caller?: string; contextId?: string } }; status: "active" | "archived"; tokens: number; createdAt: string; supersedesId: string | null }`
  - `MemoryEvidence { citationId: string; memoryId: string; kind: MemoryKind; title: string; content: string; traceId: string; score: number; createdAt: string }`

- [ ] **Step 1: 在 client types.ts 追加类型**

```typescript
// client/src/types.ts —— 文件末尾追加
export type MemoryKind = "run-summary" | "node-detail" | "preference";

export interface MemoryScopeSummary {
  scopeKey: string;
  count: number;
}

export interface MemoryRecord {
  id: string;
  scope: { employeeId: string; employeeVersion: number; projectId?: string };
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: { runId: string; traceId: string; invocationId?: string; nodeId?: string; source?: { caller?: string; contextId?: string } };
  status: "active" | "archived";
  tokens: number;
  createdAt: string;
  supersedesId: string | null;
}

export interface MemoryEvidence {
  citationId: string;
  memoryId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  traceId: string;
  score: number;
  createdAt: string;
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck:client`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add client/src/types.ts
git commit -m "feat: add client-side memory types"
```

---

### Task 5: Icon 扩展 + 导航接入「记忆档案」

**Files:**
- Modify: `client/src/components.tsx`（Icon 联合类型加 `"memory"` + 一个 SVG 分支）
- Modify: `client/src/App.tsx`（Page 类型、pageFromHash 允许列表、nav 数组、渲染块——先渲染占位，Task 6 替换为 MemoryPage）
- Test: `client/src/App.navigation.test.tsx`（追加断言导航项出现）

**Interfaces:**
- Consumes: 现有 `Icon`、`Page`、`nav`、`pageFromHash`。
- Produces: 导航新增 `{ id: "memory", label: "记忆档案", icon: "memory" }`，插在 `runs` 之后；`Icon` 支持 `name="memory"`。

- [ ] **Step 1: 追加导航测试（先失败）**

```typescript
// client/src/App.navigation.test.tsx —— 仿现有断言追加
  it("shows the 记忆档案 nav item", async () => {
    // 复用文件内现有的渲染 App 的方式；断言存在 label 为「记忆档案」的导航按钮
    // （若文件用 render(<App/>) + screen.getByTitle/getByText，照其风格）
    // 关键断言：
    // expect(screen.getByRole("button", { name: /记忆档案/ })).toBeTruthy();
  });
```

> 实施者：照 App.navigation.test.tsx 现有用例的渲染与查询风格补全（该文件已有对其他 nav 项的断言，复制其模式，把 label 换成「记忆档案」）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run client/src/App.navigation.test.tsx`
Expected: FAIL（找不到该导航项）

- [ ] **Step 3: 扩展 Icon 联合类型 + SVG**

```typescript
// client/src/components.tsx:512 —— Icon 的 name 联合类型加 "memory"
export function Icon({ name }: { name: "office" | "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs" | "publications" | "command" | "memory" }) {
```

在 Icon 内部的图标分支里，为 `"memory"` 加一个 SVG（仿现有分支的 24x24 viewBox、2px 硬边像素风；用一个"档案卡片/书签"造型即可）。实施者参照该函数内 `runs`/`knowledge` 分支的 SVG 写法，加一段 `name === "memory" && (...)`。

- [ ] **Step 4: App.tsx 三处接入**

```typescript
// 1) Page 类型（App.tsx:15）加 "memory"
type Page = "office" | "employees" | "projects" | "skills" | "knowledge" | "workflows" | "runs" | "publications" | "memory";

// 2) pageFromHash 允许列表加 "memory"
  return ["office", "employees", "projects", "skills", "knowledge", "workflows", "runs", "publications", "memory"].includes(value) ? value as Page : "office";

// 3) nav 数组，runs 之后插入
    { id: "memory" as const, label: "记忆档案", icon: "memory" as const },

// 4) 渲染块，runs 之后（Task 6 会把占位换成 MemoryPage）
      {page === "memory" && <div id="main-content">记忆档案（施工中）</div>}
```

- [ ] **Step 5: 运行测试确认通过 + 类型检查**

Run: `npx vitest run client/src/App.navigation.test.tsx && npm run typecheck:client`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components.tsx client/src/App.tsx client/src/App.navigation.test.tsx
git commit -m "feat: add 记忆档案 nav entry and memory icon"
```

---

### Task 6: MemoryPage 三栏页面

**Files:**
- Create: `client/src/MemoryPage.tsx`
- Modify: `client/src/App.tsx`（把 Task 5 的占位替换为 `<MemoryPage notify={notify} onOpenRun={...} />`）
- Test: `client/src/MemoryPage.test.tsx`

**Interfaces:**
- Consumes: `api<T>`、`DossierSection`/`EmptyState`/`SelectControl`/`Stamp`/`ReadonlyEvidence`/`formatTime`、类型（Task 4）、接口 `/api/memory/scopes`、`/api/memory/scope?key=`、`/api/memory/search`。
- Produces:
  - `export function MemoryPage({ notify, onOpenRun }: { notify: (message: string, kind?: "success" | "error") => void; onOpenRun: (runId: string) => void })`
  - 三栏：左 scope 列表（employee/project 分组，显示 count）；中 memory 列表（选中 scope 后加载 `/api/memory/scope`；搜索框非空时改用 `/api/memory/search` 带 employeeId/projectId）；右详情（summary 高亮 + 展开完整详情 + runId 按钮触发 `onOpenRun`）。
  - active/archived 过滤（SelectControl）。

- [ ] **Step 1: 写页面测试（先失败）**

```typescript
// client/src/MemoryPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryPage } from "./MemoryPage";
import * as apiModule from "./api";

describe("MemoryPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders scope list then lists memory on scope select and fires onOpenRun", async () => {
    const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (pathname: string) => {
      if (pathname === "/api/memory/scopes") return { scopes: [{ scopeKey: "employee:researcher", count: 1 }] } as never;
      if (pathname.startsWith("/api/memory/scope?")) return { records: [{
        id: "mem_1", scope: { employeeId: "researcher", employeeVersion: 1, projectId: "cart-fe" },
        kind: "run-summary", title: "前端改价", content: "完成", status: "active", tokens: 5,
        createdAt: "2026-08-07T02:00:00.000Z", supersedesId: null,
        provenance: { runId: "run_9", traceId: "run_9" }
      }] } as never;
      return {} as never;
    });
    const onOpenRun = vi.fn();
    render(<MemoryPage notify={() => {}} onOpenRun={onOpenRun} />);
    await waitFor(() => expect(screen.getByText(/employee:researcher/)).toBeTruthy());
    fireEvent.click(screen.getByText(/employee:researcher/));
    await waitFor(() => expect(screen.getByText("前端改价")).toBeTruthy());
    fireEvent.click(screen.getByText("前端改价"));
    // 详情展开后点 runId 跳转
    await waitFor(() => expect(screen.getByText(/run_9/)).toBeTruthy());
    fireEvent.click(screen.getByText(/run_9/));
    expect(onOpenRun).toHaveBeenCalledWith("run_9");
    expect(apiSpy).toHaveBeenCalledWith("/api/memory/scopes");
  });

  it("shows empty state when there are no scopes", async () => {
    vi.spyOn(apiModule, "api").mockResolvedValue({ scopes: [] } as never);
    render(<MemoryPage notify={() => {}} onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getByText(/还没有|暂无|memory/i)).toBeTruthy());
  });
});
```

> 实施者：测试查询用词（如 EmptyState 文案）以你实际写的 UI 文案为准，保持断言与实现一致。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run client/src/MemoryPage.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 MemoryPage**

实现 `client/src/MemoryPage.tsx`，要点（照 RunsPage.tsx 的结构与共享组件用法）：

```typescript
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { DossierSection, EmptyState, SelectControl, Stamp, ReadonlyEvidence, formatTime } from "./components";
import type { MemoryEvidence, MemoryRecord, MemoryScopeSummary } from "./types";

export function MemoryPage({ notify, onOpenRun }: {
  notify: (message: string, kind?: "success" | "error") => void;
  onOpenRun: (runId: string) => void;
}) {
  const [scopes, setScopes] = useState<MemoryScopeSummary[]>([]);
  const [selectedScope, setSelectedScope] = useState("");
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [selectedId, setSelectedId] = useState("");
  const [expanded, setExpanded] = useState(false);

  // 1) 载入 scope 列表
  useEffect(() => {
    api<{ scopes: MemoryScopeSummary[] }>("/api/memory/scopes")
      .then((v) => setScopes(v.scopes))
      .catch(() => notify("无法加载 memory scope", "error"));
  }, [notify]);

  // 2) 选中 scope 后载入记录（无 query 用 scope 列表；有 query 用 search）
  useEffect(() => {
    if (!selectedScope) { setRecords([]); return; }
    const [dimension, ...rest] = selectedScope.split(":");
    const id = rest.join(":");
    if (query.trim()) {
      const body = {
        query,
        employeeId: dimension === "employee" ? id : undefined,
        projectId: dimension === "project" ? id : undefined,
        limit: 40
      };
      api<{ evidence: MemoryEvidence[] }>("/api/memory/search", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }).then((v) => {
        // evidence 无 status/scope 全字段，映射成 MemoryRecord 的可展示子集
        setRecords(v.evidence.map((e) => ({
          id: e.memoryId, kind: e.kind, title: e.title, content: e.content,
          createdAt: e.createdAt, status: "active", tokens: 0, supersedesId: null,
          scope: { employeeId: "", employeeVersion: 0 },
          provenance: { runId: "", traceId: e.traceId }
        } as MemoryRecord)));
      }).catch(() => notify("检索失败", "error"));
    } else {
      api<{ records: MemoryRecord[] }>(`/api/memory/scope?key=${encodeURIComponent(selectedScope)}`)
        .then((v) => setRecords(v.records))
        .catch(() => notify("无法加载该 scope 的 memory", "error"));
    }
  }, [selectedScope, query, notify]);

  const visible = useMemo(
    () => records.filter((r) => statusFilter === "all" ? true : r.status === statusFilter),
    [records, statusFilter]
  );
  const detail = visible.find((r) => r.id === selectedId);
  const employeeScopes = scopes.filter((s) => s.scopeKey.startsWith("employee:"));
  const projectScopes = scopes.filter((s) => s.scopeKey.startsWith("project:"));

  if (scopes.length === 0) {
    return <DossierSection number="01" title="记忆档案">
      <EmptyState title="还没有任何记忆">
        Memory 在员工运行结束后自动提炼产生（多节点完成或失败的运行才会留存）。
      </EmptyState>
    </DossierSection>;
  }

  // 三栏布局：左 scope（employeeScopes/projectScopes 分组按钮，onClick setSelectedScope + 清空 selectedId）；
  // 中 记录列表（搜索输入 setQuery、statusFilter 的 SelectControl、visible.map 成可点条目 setSelectedId+setExpanded(false)）；
  // 右 详情（detail 存在时：Stamp status、title 高亮、content；一个「展开完整详情」按钮 toggle expanded；
  //     expanded 时用 ReadonlyEvidence 显示 kind / formatTime(createdAt) / traceId / runId；
  //     runId 非空时渲染 <button onClick={() => onOpenRun(detail.provenance.runId)}>{detail.provenance.runId}</button>）。
  // 具体 JSX 照 RunsPage.tsx 的三栏与 class 命名书写。
  return (/* ...三栏 JSX... */ null as never);
}
```

> 实施者：把上面注释块落实为真实三栏 JSX，复用 RunsPage 的 class 结构与共享组件；确保测试里查询的文本（scopeKey、title、runId、空态文案）与实现一致。search 路径下 runId 为空则详情不显示跳转按钮（evidence 不含 runId，仅含 traceId）——这点如实呈现，不伪造。

- [ ] **Step 4: App.tsx 用真实页面替换占位**

```typescript
// 顶部 import
import { MemoryPage } from "./MemoryPage";
// 渲染块（替换 Task 5 的占位）
      {page === "memory" && <MemoryPage notify={notify} onOpenRun={(runId) => { setPendingRunId(runId); navigate("runs"); }} />}
```

> `setPendingRunId` / `navigate` 在 Task 7 完善；本步可先用 `onOpenRun={() => navigate("runs")}` 让页面通过编译，Task 7 再接 pendingRunId。为避免返工，建议 Task 6、7 连续做。

- [ ] **Step 5: 运行测试确认通过 + 类型检查**

Run: `npx vitest run client/src/MemoryPage.test.tsx && npm run typecheck:client`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/MemoryPage.tsx client/src/App.tsx client/src/MemoryPage.test.tsx
git commit -m "feat: add three-pane MemoryPage for browsing and searching memory"
```

---

### Task 7: 跨页跳转到运行卷宗

**Files:**
- Modify: `client/src/App.tsx`（加 `pendingRunId` 状态 + 传给 RunsPage + MemoryPage 的 onOpenRun 设置它）
- Modify: `client/src/RunsPage.tsx`（接受 `pendingRunId` prop，加载后选中该 run）
- Test: `client/src/RunsPage.test.tsx`（追加：给定 pendingRunId 时选中对应 run）

**Interfaces:**
- Consumes: RunsPage 现有 `selectedId`/`setSelectedId`、`scrollRecordIntoView`。
- Produces:
  - App.tsx：`const [pendingRunId, setPendingRunId] = useState("")`；`<RunsPage notify={notify} activityRevision={activityRevision} pendingRunId={pendingRunId} onConsumePending={() => setPendingRunId("")} />`；MemoryPage 的 `onOpenRun={(runId) => { setPendingRunId(runId); navigate("runs"); }}`。
  - RunsPage：新增可选 props `pendingRunId?: string; onConsumePending?: () => void`；在 runs 加载完成后，若 `pendingRunId` 命中列表则 `setSelectedId(pendingRunId)` + `scrollRecordIntoView` + `onConsumePending()`。

- [ ] **Step 1: 追加 RunsPage 测试（先失败）**

```typescript
// client/src/RunsPage.test.tsx —— 追加
  it("auto-selects the run named by pendingRunId once loaded", async () => {
    // 仿文件内现有对 api 的 mock，返回一个含 id "run_9" 的 runs 列表
    // 渲染 <RunsPage notify={()=>{}} pendingRunId="run_9" onConsumePending={spy} />
    // 断言：加载后 run_9 被选中（详情区出现其标识），且 onConsumePending 被调用
  });
```

> 实施者：照 RunsPage.test.tsx 现有 mock 与断言风格补全（该文件已 mock `/api/runs`）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run client/src/RunsPage.test.tsx`
Expected: FAIL（pendingRunId 未生效）

- [ ] **Step 3: RunsPage 接 pendingRunId**

```typescript
// RunsPage 签名（RunsPage.tsx:120）改为：
export function RunsPage({ notify, activityRevision = "", pendingRunId = "", onConsumePending }: {
  notify: (message: string, kind?: "success" | "error") => void;
  activityRevision?: string;
  pendingRunId?: string;
  onConsumePending?: () => void;
}) {
  // ...existing state...
  // 在加载 runs 的 useEffect 里、setRuns(value) 之后追加：
  //   if (pendingRunId && value.some((r) => r.id === pendingRunId)) {
  //     setSelectedId(pendingRunId);
  //     scrollRecordIntoView(pendingRunId);
  //     onConsumePending?.();
  //   }
```

> `scrollRecordIntoView` 从 "./components" import（RunsPage 可能已 import；若未则补）。列表项须带可被 `scrollRecordIntoView(id)` 命中的 DOM id（照该函数约定；RunsPage 现有列表项若已有 id 复用之）。

- [ ] **Step 4: App.tsx 接线**

```typescript
// App.tsx：加状态
  const [pendingRunId, setPendingRunId] = useState("");
// runs 渲染块传 props
      {page === "runs" && <RunsPage notify={notify} activityRevision={activityRevision} pendingRunId={pendingRunId} onConsumePending={() => setPendingRunId("")} />}
// memory 渲染块的 onOpenRun（替换 Task 6 的临时实现）
      {page === "memory" && <MemoryPage notify={notify} onOpenRun={(runId) => { setPendingRunId(runId); navigate("runs"); }} />}
```

- [ ] **Step 5: 运行测试确认通过 + 类型检查**

Run: `npx vitest run client/src/RunsPage.test.tsx client/src/MemoryPage.test.tsx && npm run typecheck:client`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx client/src/RunsPage.tsx client/src/RunsPage.test.tsx
git commit -m "feat: jump from memory detail to the run dossier via pendingRunId"
```

---

### Task 8: 文档 + 全量校验

**Files:**
- Modify: `docs/memory-system.md`（加一节「后台查看入口」）
- Test: 无新增；跑全量 `npm run check`

**Interfaces:**
- Consumes: 无。
- Produces: 文档一节 + 全绿校验。

- [ ] **Step 1: 文档加一节**

在 `docs/memory-system.md` 的「检索入口」部分补一条第 4 入口：

> **4. 后台 UI「记忆档案」页**：档案室客户端左侧导航「记忆档案」。左栏按 employee/project 列出所有有 memory 的 scope 及条数；选中后中栏列出该 scope 的记录（可搜索、按 active/archived 过滤）；右栏详情默认高亮 summary，展开可见 kind/时间/scope/溯源字段，点 runId 跳转「运行卷宗」。只读——归档/删除仍走 CLI。对应只读接口 `GET /api/memory/scopes`、`GET /api/memory/scope?key=`。

- [ ] **Step 2: 全量校验**

Run: `npm run check`
Expected: typecheck（server+client）+ 全部测试 + build 全绿

- [ ] **Step 3: Commit**

```bash
git add docs/memory-system.md
git commit -m "docs: document the memory viewer page and its read-only routes"
```

---

## Self-Review

**1. Spec coverage（逐节核对）：**
- §2 后端 list 接口（listScopes + service 代理 + 两个 GET 路由）→ Task 1 + Task 2 + Task 3 ✅
- §3 前端三栏页面（scope 分组 / 列表+搜索+过滤 / summary 高亮+展开+runId 跳转）→ Task 4（类型）+ Task 5（导航+Icon）+ Task 6（页面）✅
- §4 跨页跳转（pendingRunId）→ Task 7 ✅
- §5 错误处理（接口失败降级、空态、runId 不存在不报错）→ Task 2/6（catch + EmptyState）、Task 7（`value.some` 命中才选中）✅
- §6 测试（后端 list 单测、前端仿 RunsPage/App.navigation）→ Task 1/2/3 后端、Task 5/6/7 前端 ✅
- §7 组件边界 → Task 1–7 一一对应 ✅

**2. Placeholder scan：** 无 TBD/TODO。Task 5 的 Icon SVG、Task 6 的三栏 JSX、几处测试查询用词标注了「照现有文件风格补全 / 与实现文案一致」——这是嵌入现有 React 组件时的合理"跟随现有模式"指引（SVG 造型与 JSX class 无法逐像素预写），非逻辑占位符；所有接口签名、状态、数据流、接口路径均已给全。

**3. Type consistency：** `MemoryScopeSummary`/`MemoryRecord`/`MemoryEvidence` client 与 server 字段对齐；`listScopes`（Task 1 定义、Task 2/3 使用）、`listMemoryScopes`/`listMemoryByScope`（Task 2 定义、Task 3 使用）、`pendingRunId`/`onConsumePending`（Task 7 App 与 RunsPage 两侧签名一致）、`onOpenRun`（Task 6 定义、Task 7 接线）命名贯通一致。

**已知风险提示（供执行者）：** Task 6、7 连续做（Task 6 的 onOpenRun 临时实现会被 Task 7 替换）。Task 5/6/7 都改 App.tsx 同一渲染区，串行执行避免冲突。search 路径下的 evidence 不含 runId（仅 traceId），详情跳转按钮仅在 scope-list 路径（完整 MemoryRecord）出现——这是真实数据限制，不要伪造 runId。
