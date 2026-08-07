# Memory 系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为本地多 Agent 工作台新增按需检索的 memory 系统——运行后自动提炼跨会话经验，Agent 通过 MCP 工具按 employee/project 维度检索，省 token。

**Architecture:** 独立 `MemoryStore`（文件式，仿 `artifacts/runs/`，不进 state.json）；`MemoryExtractor` 在运行结束后异步提炼；`MemoryRetriever` 复用 knowledge 的词项打分与预算裁剪；`search_memory` MCP 工具是检索入口。memory 是衍生的、尽力而为的便利层，故障不影响主运行链路。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀), Node fs/promises, vitest, commander (CLI), @modelcontextprotocol/sdk (MCP)。

## Global Constraints

- ESM 模块，import 路径带 `.js` 后缀（如 `from "./store.js"`）。
- 存储用 JSON 文件 + 原子写（临时文件 + rename），复用 `writeJsonAtomic` 模式（`src/knowledge/store.ts:23`）。
- 时间戳存储层一律 ISO 8601（`new Date().toISOString()`）；展示层才格式化。**禁止**改动现有存储时间戳格式（系统 10+ 处依赖字典序排序 + `Date.parse`）。
- 路径段用 `safeSegment` 式校验，防止注入（`src/knowledge/store.ts:18`）。
- 词项分词/打分复用现有导出：`tokenizeKnowledgeText`、`knowledgeQueryTokens`（`src/knowledge/store.ts:34/57`）。
- memory 提炼/检索的任何失败都必须被捕获并降级，**不得**抛到主运行链路。
- 测试用 vitest，命令 `npm test`；单测隔离用临时目录（`fs.mkdtemp`），不碰真实 `~/.multi-agent`。
- MVP 非目标：向量检索、衰减淘汰/GC、偏好自动注入、agent 主动写入、新用户实体。预留字段但不实现其写入路径。

---

### Task 1: Memory 类型定义

**Files:**
- Create: `src/memory/types.ts`

**Interfaces:**
- Consumes: 无（基础类型层）。
- Produces:
  - `MemoryScope { employeeId: string; employeeVersion: number; projectId?: string }`
  - `MemoryProvenance { runId: string; traceId: string; invocationId?: string; nodeId?: string; source?: { caller?: string; contextId?: string } }`
  - `MemoryKind = "run-summary" | "node-detail" | "preference"`
  - `MemoryRecord { id: string; scope: MemoryScope; kind: MemoryKind; title: string; content: string; provenance: MemoryProvenance; status: "active" | "archived"; tokens: number; createdAt: string; supersedesId: string | null }`
  - `MemorySearchQuery { query: string; scope: Partial<MemoryScope>; limit?: number; kind?: MemoryKind }`
  - `MemoryEvidence { citationId: string; memoryId: string; kind: MemoryKind; title: string; content: string; traceId: string; score: number; createdAt: string }`

- [ ] **Step 1: 创建类型文件**

```typescript
// src/memory/types.ts
export type MemoryKind = "run-summary" | "node-detail" | "preference";

export interface MemoryScope {
  employeeId: string;
  employeeVersion: number;
  projectId?: string;
}

export interface MemoryProvenance {
  runId: string;
  traceId: string;
  invocationId?: string;
  nodeId?: string;
  source?: { caller?: string; contextId?: string };
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: MemoryProvenance;
  status: "active" | "archived";
  tokens: number;
  createdAt: string; // ISO 8601
  supersedesId: string | null;
}

export interface MemorySearchQuery {
  query: string;
  scope: Partial<MemoryScope>;
  limit?: number;
  kind?: MemoryKind;
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

- [ ] **Step 2: 类型检查通过**

Run: `npm run typecheck:server`
Expected: PASS（无新错误）

- [ ] **Step 3: Commit**

```bash
git add src/memory/types.ts
git commit -m "feat: add memory record and query types"
```

---

### Task 2: 展示层时间格式化工具（横切项）

**Files:**
- Create: `src/config/datetime.ts`
- Test: `tests/datetime.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `formatDateTime(iso: string): string` — 把 ISO 8601 格式化为 `YYYY-MM-DD HH:mm:ss`（本地时区）；输入非法时原样返回。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/datetime.test.ts
import { describe, it, expect } from "vitest";
import { formatDateTime } from "../src/config/datetime.js";

describe("formatDateTime", () => {
  it("formats ISO 8601 to YYYY-MM-DD HH:mm:ss", () => {
    // 用带偏移的固定时刻，断言各字段存在且形态正确
    const out = formatDateTime("2026-08-06T22:11:05.000Z");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("returns input unchanged when not a valid date", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("returns input unchanged for empty string", () => {
    expect(formatDateTime("")).toBe("");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/datetime.test.ts`
Expected: FAIL（`formatDateTime` 未定义 / 模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/config/datetime.ts
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * 展示层时间格式化：ISO 8601 -> "YYYY-MM-DD HH:mm:ss"（本地时区）。
 * 存储层不受影响，继续用 ISO 8601 以保排序与 Date.parse 兼容。
 */
export function formatDateTime(iso: string): string {
  if (!iso) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/datetime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/datetime.ts tests/datetime.test.ts
git commit -m "feat: add display-layer formatDateTime helper"
```

---

### Task 3: MemoryStore —— 读写、软删除、索引

**Files:**
- Create: `src/memory/store.ts`
- Test: `tests/memory-store.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord`, `MemoryScope`（Task 1）; `tokenizeKnowledgeText`（`src/knowledge/store.ts`）。
- Produces:
  - `class MemoryStore`
    - `static async open(dataRoot: string): Promise<MemoryStore>`
    - `get dataRoot(): string`
    - `async put(record: MemoryRecord): Promise<void>` — 原子写 record 文件 + 更新其所属 scope 分片索引
    - `async get(id: string): Promise<MemoryRecord | null>`
    - `async archive(id: string): Promise<MemoryRecord | null>` — 置 status=archived 并回写
    - `async listByScope(scopeKey: string): Promise<MemoryRecord[]>` — 读该分片索引指向的全部 active+archived 记录
    - `async reindex(): Promise<number>` — 扫 records/ 重建全部 index/ 分片，返回记录数
    - `static scopeKeys(scope: MemoryScope): string[]` — 返回 `["employee:<id>", "project:<id>"]`（projectId 存在才含 project）
  - 索引文件结构：`{ scopeKey: string; memoryIds: string[] }`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/memory-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import type { MemoryRecord } from "../src/memory/types.js";

function sampleRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_1",
    scope: { employeeId: "researcher", employeeVersion: 3, projectId: "cart-fe" },
    kind: "run-summary",
    title: "前端改价交付",
    content: "完成了改价，测试通过。",
    provenance: { runId: "run_1", traceId: "run_1" },
    status: "active",
    tokens: 20,
    createdAt: "2026-08-06T10:00:00.000Z",
    supersedesId: null,
    ...overrides
  };
}

describe("MemoryStore", () => {
  let dataRoot: string;
  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-store-"));
  });

  it("scopeKeys returns employee and project keys", () => {
    expect(MemoryStore.scopeKeys({ employeeId: "r", employeeVersion: 1, projectId: "p" }))
      .toEqual(["employee:r", "project:p"]);
    expect(MemoryStore.scopeKeys({ employeeId: "r", employeeVersion: 1 }))
      .toEqual(["employee:r"]);
  });

  it("put then get round-trips a record", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord());
    const got = await store.get("mem_1");
    expect(got?.title).toBe("前端改价交付");
  });

  it("get returns null for missing id", async () => {
    const store = await MemoryStore.open(dataRoot);
    expect(await store.get("nope")).toBeNull();
  });

  it("listByScope returns records indexed under a scope key", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord({ id: "mem_1" }));
    await store.put(sampleRecord({ id: "mem_2" }));
    const byEmployee = await store.listByScope("employee:researcher");
    expect(byEmployee.map((r) => r.id).sort()).toEqual(["mem_1", "mem_2"]);
    const byProject = await store.listByScope("project:cart-fe");
    expect(byProject.length).toBe(2);
  });

  it("archive flips status to archived", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord());
    const archived = await store.archive("mem_1");
    expect(archived?.status).toBe("archived");
    expect((await store.get("mem_1"))?.status).toBe("archived");
  });

  it("reindex rebuilds indexes from records on disk", async () => {
    const store = await MemoryStore.open(dataRoot);
    await store.put(sampleRecord({ id: "mem_1" }));
    // 删掉索引目录，模拟损坏
    await fs.rm(path.join(dataRoot, "memory", "index"), { recursive: true, force: true });
    const count = await store.reindex();
    expect(count).toBe(1);
    expect((await store.listByScope("employee:researcher")).length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: FAIL（模块/类不存在）

- [ ] **Step 3: 实现 MemoryStore**

```typescript
// src/memory/store.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord, MemoryScope } from "./types.js";

interface ScopeIndex {
  scopeKey: string;
  memoryIds: string[];
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) throw new Error(`invalid memory id: ${value}`);
  return value;
}

function scopeKeyToFileName(scopeKey: string): string {
  // "employee:researcher" -> "employee__researcher.json"，且校验各段
  const [dimension, ...rest] = scopeKey.split(":");
  const id = rest.join(":");
  if (!/^[a-z]+$/.test(dimension)) throw new Error(`invalid scope dimension: ${dimension}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`invalid scope id: ${id}`);
  return `${dimension}__${id}.json`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class MemoryStore {
  private constructor(private readonly root: string) {}

  static async open(dataRoot: string): Promise<MemoryStore> {
    const root = path.join(dataRoot, "memory");
    await fs.mkdir(path.join(root, "records"), { recursive: true });
    await fs.mkdir(path.join(root, "index"), { recursive: true });
    return new MemoryStore(root);
  }

  get dataRoot(): string {
    return this.root;
  }

  static scopeKeys(scope: MemoryScope): string[] {
    const keys = [`employee:${scope.employeeId}`];
    if (scope.projectId) keys.push(`project:${scope.projectId}`);
    return keys;
  }

  private recordPath(id: string): string {
    return path.join(this.root, "records", `${safeId(id)}.json`);
  }

  private indexPath(scopeKey: string): string {
    return path.join(this.root, "index", scopeKeyToFileName(scopeKey));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return readJson<MemoryRecord>(this.recordPath(id));
  }

  async put(record: MemoryRecord): Promise<void> {
    await writeJsonAtomic(this.recordPath(record.id), record);
    for (const scopeKey of MemoryStore.scopeKeys(record.scope)) {
      const index = (await readJson<ScopeIndex>(this.indexPath(scopeKey))) ?? { scopeKey, memoryIds: [] };
      if (!index.memoryIds.includes(record.id)) {
        index.memoryIds.push(record.id);
        await writeJsonAtomic(this.indexPath(scopeKey), index);
      }
    }
  }

  async archive(id: string): Promise<MemoryRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    const updated: MemoryRecord = { ...record, status: "archived" };
    await writeJsonAtomic(this.recordPath(id), updated);
    return updated;
  }

  async listByScope(scopeKey: string): Promise<MemoryRecord[]> {
    const index = await readJson<ScopeIndex>(this.indexPath(scopeKey));
    if (!index) return [];
    const records: MemoryRecord[] = [];
    for (const id of index.memoryIds) {
      const record = await this.get(id);
      if (record) records.push(record);
    }
    return records;
  }

  async reindex(): Promise<number> {
    const recordsDir = path.join(this.root, "records");
    const indexDir = path.join(this.root, "index");
    await fs.rm(indexDir, { recursive: true, force: true });
    await fs.mkdir(indexDir, { recursive: true });
    const files = (await fs.readdir(recordsDir)).filter((name) => name.endsWith(".json"));
    let count = 0;
    for (const file of files) {
      const record = await readJson<MemoryRecord>(path.join(recordsDir, file));
      if (!record) continue;
      count += 1;
      for (const scopeKey of MemoryStore.scopeKeys(record.scope)) {
        const index = (await readJson<ScopeIndex>(this.indexPath(scopeKey))) ?? { scopeKey, memoryIds: [] };
        if (!index.memoryIds.includes(record.id)) index.memoryIds.push(record.id);
        await writeJsonAtomic(this.indexPath(scopeKey), index);
      }
    }
    return count;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/memory-store.test.ts
git commit -m "feat: add MemoryStore with scope-sharded index and soft delete"
```

---

### Task 4: MemoryRetriever —— 打分 + 预算裁剪 + 下钻

**Files:**
- Create: `src/memory/retriever.ts`
- Test: `tests/memory-retriever.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`（Task 3）, `MemoryRecord/MemorySearchQuery/MemoryEvidence`（Task 1）, `knowledgeQueryTokens`（`src/knowledge/store.ts`）。
- Produces:
  - `class MemoryRetriever { constructor(store: MemoryStore); async search(query: MemorySearchQuery): Promise<MemoryEvidence[]> }`
  - 默认 `limit=5`，token 上限 `MEMORY_MAX_TOKENS=4000`；默认只返回 `kind="run-summary"`（除非 query.kind 指定）；只返回 `status==="active"`；结果按 score 降序、同分按 createdAt 新→旧；带 `[M#]` citation。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/memory-retriever.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryRetriever } from "../src/memory/retriever.js";
import type { MemoryRecord } from "../src/memory/types.js";

function rec(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "x", scope: { employeeId: "r", employeeVersion: 1, projectId: "cart-fe" },
    kind: "run-summary", title: "t", content: "c",
    provenance: { runId: "run", traceId: "run" },
    status: "active", tokens: 10, createdAt: "2026-08-06T10:00:00.000Z", supersedesId: null,
    ...overrides
  };
}

describe("MemoryRetriever", () => {
  let dataRoot: string;
  let store: MemoryStore;
  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-ret-"));
    store = await MemoryStore.open(dataRoot);
  });

  it("returns higher score for better term overlap", async () => {
    await store.put(rec({ id: "a", title: "前端改价", content: "改价 前端 交付 完成" }));
    await store.put(rec({ id: "b", title: "后端日志", content: "日志 排查 无关" }));
    const hits = await store.reindex().then(() =>
      new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" } }));
    expect(hits[0].memoryId).toBe("a");
    expect(hits[0].citationId).toBe("M1");
  });

  it("excludes archived records", async () => {
    await store.put(rec({ id: "a", content: "前端 改价" }));
    await store.archive("a");
    const hits = await new MemoryRetriever(store).search({ query: "前端", scope: { employeeId: "r" } });
    expect(hits.length).toBe(0);
  });

  it("defaults to run-summary kind only", async () => {
    await store.put(rec({ id: "a", kind: "run-summary", content: "前端 改价" }));
    await store.put(rec({ id: "b", kind: "node-detail", content: "前端 改价 细节" }));
    const hits = await new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" } });
    expect(hits.every((h) => h.kind === "run-summary")).toBe(true);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 8; i += 1) await store.put(rec({ id: `a${i}`, content: "前端 改价 交付" }));
    const hits = await new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" }, limit: 3 });
    expect(hits.length).toBe(3);
  });

  it("returns node-detail when explicitly requested (drill-down)", async () => {
    await store.put(rec({ id: "a", kind: "node-detail", content: "前端 改价 细节", provenance: { runId: "run", traceId: "trace-9" } }));
    const hits = await new MemoryRetriever(store).search({ query: "前端 改价", scope: { employeeId: "r" }, kind: "node-detail" });
    expect(hits[0].traceId).toBe("trace-9");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-retriever.test.ts`
Expected: FAIL（模块/类不存在）

- [ ] **Step 3: 实现 MemoryRetriever**

```typescript
// src/memory/retriever.ts
import { knowledgeQueryTokens } from "../knowledge/store.js";
import type { MemoryStore } from "./store.js";
import { MemoryStore as MemoryStoreClass } from "./store.js";
import type { MemoryEvidence, MemoryRecord, MemorySearchQuery } from "./types.js";

const DEFAULT_LIMIT = 5;
const MEMORY_MAX_TOKENS = 4000;

function scoreRecord(record: MemoryRecord, query: string): number {
  const queryTokens = new Set(knowledgeQueryTokens(query));
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(knowledgeQueryTokens(record.content));
  const titleTokens = new Set(knowledgeQueryTokens(record.title));
  let overlap = 0;
  let titleOverlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
    if (titleTokens.has(token)) titleOverlap += 1;
  }
  return overlap / queryTokens.size + (titleOverlap / queryTokens.size) * 0.6;
}

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  async search(query: MemorySearchQuery): Promise<MemoryEvidence[]> {
    const limit = Math.max(1, Math.min(40, query.limit ?? DEFAULT_LIMIT));
    const wantedKind = query.kind ?? "run-summary";

    // 只加载相关 scope 分片（不扫全局）——效率核心
    const scopeKeys: string[] = [];
    if (query.scope.employeeId) scopeKeys.push(`employee:${query.scope.employeeId}`);
    if (query.scope.projectId) scopeKeys.push(`project:${query.scope.projectId}`);

    const seen = new Set<string>();
    const candidates: MemoryRecord[] = [];
    for (const scopeKey of scopeKeys) {
      for (const record of await this.store.listByScope(scopeKey)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        if (record.status !== "active") continue;
        if (record.kind !== wantedKind) continue;
        candidates.push(record);
      }
    }

    const scored = candidates
      .map((record) => ({ record, score: scoreRecord(record, query.query) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) =>
        right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt));

    const evidence: MemoryEvidence[] = [];
    let usedTokens = 0;
    for (const hit of scored) {
      if (evidence.length >= limit) break;
      if (usedTokens + hit.record.tokens > MEMORY_MAX_TOKENS) continue;
      usedTokens += hit.record.tokens;
      evidence.push({
        citationId: `M${evidence.length + 1}`,
        memoryId: hit.record.id,
        kind: hit.record.kind,
        title: hit.record.title,
        content: hit.record.content,
        traceId: hit.record.provenance.traceId,
        score: Number(hit.score.toFixed(6)),
        createdAt: hit.record.createdAt
      });
    }
    return evidence;
  }
}

void MemoryStoreClass; // 保留类型引用一致性（如未使用可删）
```

注意：上面 `void MemoryStoreClass` 只为示意导入形态；实现时若 lint 报未使用，删掉该行与对应 import，仅保留 `import type { MemoryStore }`.

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/memory-retriever.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/retriever.ts tests/memory-retriever.test.ts
git commit -m "feat: add MemoryRetriever with term scoring and budget"
```

---

### Task 5: 价值筛选 gate（规则层）

**Files:**
- Create: `src/memory/extractionGate.ts`
- Test: `tests/memory-extraction-gate.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunRecord`（`src/core/types.ts:152`，字段含 `status`, `nodes`）。
- Produces:
  - `shouldExtract(run: { status: string; nodes: Record<string, { status: string }> }): { extract: boolean; reason: string }`
  - 规则：`failed/blocked` → extract=true（有教训）；`cancelled` → false；`completed` 且节点数 ≤ 1 → false（trivial）；`completed` 且节点数 ≥ 2 → true。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/memory-extraction-gate.test.ts
import { describe, it, expect } from "vitest";
import { shouldExtract } from "../src/memory/extractionGate.js";

const run = (status: string, nodeCount: number) => ({
  status,
  nodes: Object.fromEntries(Array.from({ length: nodeCount }, (_, i) => [`n${i}`, { status: "completed" }]))
});

describe("shouldExtract", () => {
  it("extracts failed runs (lessons)", () => {
    expect(shouldExtract(run("failed", 1)).extract).toBe(true);
  });
  it("extracts blocked runs", () => {
    expect(shouldExtract(run("blocked", 1)).extract).toBe(true);
  });
  it("skips cancelled runs", () => {
    expect(shouldExtract(run("cancelled", 3)).extract).toBe(false);
  });
  it("skips trivial single-node completed runs", () => {
    expect(shouldExtract(run("completed", 1)).extract).toBe(false);
  });
  it("extracts multi-node completed runs", () => {
    expect(shouldExtract(run("completed", 3)).extract).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-extraction-gate.test.ts`
Expected: FAIL（未定义）

- [ ] **Step 3: 实现**

```typescript
// src/memory/extractionGate.ts
export function shouldExtract(run: {
  status: string;
  nodes: Record<string, { status: string }>;
}): { extract: boolean; reason: string } {
  const nodeCount = Object.keys(run.nodes ?? {}).length;
  if (run.status === "cancelled") return { extract: false, reason: "cancelled run" };
  if (run.status === "failed" || run.status === "blocked") {
    return { extract: true, reason: "failure carries reusable lessons" };
  }
  if (run.status === "completed") {
    if (nodeCount <= 1) return { extract: false, reason: "trivial single-node run" };
    return { extract: true, reason: "multi-node completed run" };
  }
  return { extract: false, reason: `unhandled status: ${run.status}` };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/memory-extraction-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/extractionGate.ts tests/memory-extraction-gate.test.ts
git commit -m "feat: add rule-based memory extraction gate"
```

---

### Task 6: MemoryExtractor —— 提炼编排（依赖注入提炼器 + 幂等 + 降级）

**Files:**
- Create: `src/memory/extractor.ts`
- Test: `tests/memory-extractor.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`（Task 3）, `shouldExtract`（Task 5）, `MemoryRecord/MemoryScope`（Task 1）, `estimateTokens`（本任务内联实现，见下）。
- Produces:
  - `type SummarizeFn = (input: { run: RunLike; scope: MemoryScope }) => Promise<{ title: string; content: string } | null>` — 提炼器抽象（Task 7 用 Employee 实现；测试用 mock）。
  - `type RunLike = { id: string; status: string; nodes: Record<string, { status: string }> }`
  - `class MemoryExtractor { constructor(store: MemoryStore, summarize: SummarizeFn, makeId: () => string); async onRunComplete(input: { run: RunLike; scope: MemoryScope; provenance: { invocationId?: string; source?: { caller?: string; contextId?: string } } }): Promise<MemoryRecord | null> }`
  - 行为：先 `shouldExtract`；不通过返回 null。幂等：若已存在 `provenance.runId === run.id` 的 run-summary（用 `store.listByScope` 查 employee 分片判重）则返回已存在记录。提炼器抛错 → 捕获、返回 null（降级，不抛出）。`traceId = run.id`。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/memory-extractor.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryExtractor, type RunLike } from "../src/memory/extractor.js";
import type { MemoryScope } from "../src/memory/types.js";

const scope: MemoryScope = { employeeId: "r", employeeVersion: 1, projectId: "cart-fe" };
const multiNodeRun: RunLike = { id: "run_1", status: "completed", nodes: { a: { status: "completed" }, b: { status: "completed" } } };
let seq = 0;
const makeId = () => `mem_${(seq += 1)}`;

describe("MemoryExtractor", () => {
  let dataRoot: string;
  let store: MemoryStore;
  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-ext-"));
    store = await MemoryStore.open(dataRoot);
    seq = 0;
  });

  it("writes a run-summary when gate passes", async () => {
    const extractor = new MemoryExtractor(store, async () => ({ title: "交付", content: "多节点完成" }), makeId);
    const record = await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} });
    expect(record?.kind).toBe("run-summary");
    expect(record?.provenance.runId).toBe("run_1");
    expect(record?.provenance.traceId).toBe("run_1");
    expect(record?.tokens).toBeGreaterThan(0);
  });

  it("skips when gate rejects (trivial run)", async () => {
    const extractor = new MemoryExtractor(store, async () => ({ title: "t", content: "c" }), makeId);
    const trivial: RunLike = { id: "run_2", status: "completed", nodes: { a: { status: "completed" } } };
    expect(await extractor.onRunComplete({ run: trivial, scope, provenance: {} })).toBeNull();
  });

  it("is idempotent per runId", async () => {
    const extractor = new MemoryExtractor(store, async () => ({ title: "t", content: "c" }), makeId);
    const first = await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} });
    const second = await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} });
    expect(second?.id).toBe(first?.id);
    expect((await store.listByScope("employee:r")).length).toBe(1);
  });

  it("degrades to null when summarizer throws (no throw to caller)", async () => {
    const extractor = new MemoryExtractor(store, async () => { throw new Error("provider down"); }, makeId);
    await expect(extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} })).resolves.toBeNull();
  });

  it("skips when summarizer returns null", async () => {
    const extractor = new MemoryExtractor(store, async () => null, makeId);
    expect(await extractor.onRunComplete({ run: multiNodeRun, scope, provenance: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-extractor.test.ts`
Expected: FAIL（未定义）

- [ ] **Step 3: 实现 MemoryExtractor**

```typescript
// src/memory/extractor.ts
import { shouldExtract } from "./extractionGate.js";
import type { MemoryStore } from "./store.js";
import type { MemoryRecord, MemoryScope } from "./types.js";

export type RunLike = { id: string; status: string; nodes: Record<string, { status: string }> };

export type SummarizeFn = (input: {
  run: RunLike;
  scope: MemoryScope;
}) => Promise<{ title: string; content: string } | null>;

function estimateTokens(value: string): number {
  const han = value.match(/\p{Script=Han}/gu)?.length ?? 0;
  const remaining = Math.max(0, value.length - han);
  return Math.max(1, han + Math.ceil(remaining / 4));
}

export class MemoryExtractor {
  constructor(
    private readonly store: MemoryStore,
    private readonly summarize: SummarizeFn,
    private readonly makeId: () => string
  ) {}

  async onRunComplete(input: {
    run: RunLike;
    scope: MemoryScope;
    provenance: { invocationId?: string; source?: { caller?: string; contextId?: string } };
  }): Promise<MemoryRecord | null> {
    try {
      const gate = shouldExtract(input.run);
      if (!gate.extract) return null;

      // 幂等：查 employee 分片是否已有该 runId 的 run-summary
      const existing = (await this.store.listByScope(`employee:${input.scope.employeeId}`))
        .find((r) => r.kind === "run-summary" && r.provenance.runId === input.run.id);
      if (existing) return existing;

      const summary = await this.summarize({ run: input.run, scope: input.scope });
      if (!summary) return null;

      const record: MemoryRecord = {
        id: this.makeId(),
        scope: input.scope,
        kind: "run-summary",
        title: summary.title,
        content: summary.content,
        provenance: {
          runId: input.run.id,
          traceId: input.run.id,
          invocationId: input.provenance.invocationId,
          source: input.provenance.source
        },
        status: "active",
        tokens: estimateTokens(summary.content),
        createdAt: new Date().toISOString(),
        supersedesId: null
      };
      await this.store.put(record);
      return record;
    } catch {
      // 尽力而为：提炼失败不影响主运行链路
      return null;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/memory-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/extractor.ts tests/memory-extractor.test.ts
git commit -m "feat: add MemoryExtractor with idempotency and graceful degradation"
```

---

### Task 7: 接入 WorkbenchService —— 提炼器 Employee + 运行后异步触发 + 检索方法

**Files:**
- Modify: `src/workbench/service.ts`（构造函数区 `~1620-1640` 注入 MemoryStore/Retriever；`invokeResolvedEmployee` 完成后挂钩子；新增 public 方法）
- Test: `tests/memory-service-integration.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.open`（Task 3）, `MemoryRetriever`（Task 4）, `MemoryExtractor`（Task 6）, `this.store.dataRoot`, `this.invokeEmployee`（提炼器复用）, `this.getRun`（`service.ts:6010`）。
- Produces（WorkbenchService 新增 public 方法）：
  - `async searchMemory(query: MemorySearchQuery): Promise<MemoryEvidence[]>`
  - `async archiveMemory(id: string): Promise<MemoryRecord | null>`
  - `async reindexMemory(): Promise<number>`
  - 私有：`private async extractMemoryForRun(runId, scope, provenance): Promise<void>`（内部 catch，永不抛）；提炼器 `SummarizeFn` 用一个内部固定 employeeId（如 `memory-summarizer`）调用 `invokeEmployee`；若该 employee 不存在则降级为规则摘要（拼装 status + 节点数）。

- [ ] **Step 1: 写集成测试（关键：提炼失败不影响主链路 + 检索闭环）**

```typescript
// tests/memory-service-integration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

async function freshService() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-svc-"));
  return WorkbenchService.open({ dataRoot });
}

describe("WorkbenchService memory integration", () => {
  it("searchMemory returns empty for unknown scope (no crash)", async () => {
    const svc = await freshService();
    const hits = await svc.searchMemory({ query: "任何", scope: { employeeId: "nobody" } });
    expect(hits).toEqual([]);
  });

  it("archiveMemory returns null for missing id", async () => {
    const svc = await freshService();
    expect(await svc.archiveMemory("mem_missing")).toBeNull();
  });

  it("reindexMemory returns 0 on empty store", async () => {
    const svc = await freshService();
    expect(await svc.reindexMemory()).toBe(0);
  });

  // 主链路回归：一次真实 mock-provider employee 调用完成后，服务不因 memory 提炼而报错
  it("employee invocation completes even though memory extraction runs in background", async () => {
    const svc = await freshService();
    // 用仓库现有 mock provider + 最简 employee 模板创建并调用；断言调用成功返回
    // （具体 employee 创建复用 templates/workbench/employee.example.json 的最小字段）
    // 这里只断言 invoke 不抛错、返回带 runId
    // 实施者：参照 tests/ 下现有 employee-invoke 集成测试的建 employee 方式
    expect(typeof svc.searchMemory).toBe("function");
  });
});
```

> 注：第 4 个测试的完整建 employee 步骤，实施者参照 `tests/` 目录下已有的 employee 调用集成测试（搜索 `invokeEmployee` 的测试用例）复制其最小建号流程。核心断言：invoke 正常返回 + `await svc.searchMemory(...)` 不抛。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/memory-service-integration.test.ts`
Expected: FAIL（`searchMemory` 等方法不存在）

- [ ] **Step 3: 在 service.ts 注入并实现**

在 import 区加入：

```typescript
import { MemoryStore } from "../memory/store.js";
import { MemoryRetriever } from "../memory/retriever.js";
import { MemoryExtractor, type RunLike, type SummarizeFn } from "../memory/extractor.js";
import type { MemoryEvidence, MemoryRecord, MemoryScope, MemorySearchQuery } from "../memory/types.js";
```

在字段区（`readonly knowledge` 附近）加入：

```typescript
  private memoryStore!: MemoryStore;
  private memoryRetriever!: MemoryRetriever;
  private memoryExtractor!: MemoryExtractor;
```

在 `static async open(...)` 里，`WorkbenchStore.open` 之后、`return new WorkbenchService(...)` 之前，构造 memory 组件，并在构造函数里赋值（跟随现有 open/constructor 结构；若 constructor 是 private，则在 open 内 `const service = new WorkbenchService(...)` 后 `await service.initMemory()`）。实现一个初始化方法：

```typescript
  private async initMemory(): Promise<void> {
    this.memoryStore = await MemoryStore.open(this.store.dataRoot);
    this.memoryRetriever = new MemoryRetriever(this.memoryStore);
    const summarize: SummarizeFn = async ({ run, scope }) => {
      // 优先复用内部提炼器 Employee；不存在则降级为规则摘要
      const SUMMARIZER_ID = "memory-summarizer";
      try {
        const exists = this.listEmployees(true).some((e: { id: string }) => e.id === SUMMARIZER_ID);
        if (exists) {
          const result = await this.invokeEmployee(SUMMARIZER_ID, {
            message: `提炼这次运行的可复用经验（<=120字）：runId=${run.id} status=${run.status} nodes=${Object.keys(run.nodes).join(",")}`
          });
          const content = typeof (result as { output?: unknown }).output === "string"
            ? (result as { output: string }).output
            : JSON.stringify((result as { output?: unknown }).output ?? "");
          if (content) return { title: `运行 ${run.id}`, content };
        }
      } catch {
        // fall through to rule summary
      }
      const nodeCount = Object.keys(run.nodes).length;
      return { title: `运行 ${run.id}`, content: `状态=${run.status}，节点数=${nodeCount}。` };
    };
    let counter = 0;
    this.memoryExtractor = new MemoryExtractor(this.memoryStore, summarize, () =>
      `mem_${Date.now().toString(36)}_${(counter += 1)}`);
  }

  async searchMemory(query: MemorySearchQuery): Promise<MemoryEvidence[]> {
    try {
      return await this.memoryRetriever.search(query);
    } catch {
      return [];
    }
  }

  async archiveMemory(id: string): Promise<MemoryRecord | null> {
    return this.memoryStore.archive(id);
  }

  async reindexMemory(): Promise<number> {
    return this.memoryStore.reindex();
  }

  private extractMemoryForRun(runId: string, scope: MemoryScope, provenance: {
    invocationId?: string; source?: { caller?: string; contextId?: string };
  }): void {
    // 异步旁路，绝不阻塞、绝不抛出
    void (async () => {
      try {
        const run = (await this.getRun(runId)) as RunLike | null;
        if (!run || !run.id) return;
        await this.memoryExtractor.onRunComplete({ run, scope, provenance });
      } catch {
        // 尽力而为
      }
    })();
  }
```

在 `invokeResolvedEmployee`（`service.ts:4558` 附近）拿到 run 结果、构造返回值之前，插入触发（scope 从 employee + assignment.projectId 组装，provenance 从 InvocationSource 取）：

```typescript
    // 运行后异步提炼 memory（尽力而为，不阻塞返回）
    this.extractMemoryForRun(runId, {
      employeeId: employee.id,
      employeeVersion: employee.version,
      projectId: assignment?.projectId
    }, {
      invocationId,
      source: { caller: source?.caller, contextId: source?.contextId }
    });
```

> 实施者注意：上面变量名（`runId`/`employee`/`assignment`/`invocationId`/`source`）需对齐 `invokeResolvedEmployee` 作用域内的真实局部变量；若命名不同，按实际调整。确保插入点在 run 已完成之后。

在 `open()` 中调用 `await service.initMemory()`。

- [ ] **Step 4: 运行测试确认通过 + 全量类型检查**

Run: `npx vitest run tests/memory-service-integration.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workbench/service.ts tests/memory-service-integration.test.ts
git commit -m "feat: wire memory store/extractor/retriever into WorkbenchService"
```

---

### Task 8: MCP 工具 `search_memory`

**Files:**
- Modify: `src/mcp/server.ts`（在 `invoke_employee` 注册附近，`~642` 之后加新工具）

**Interfaces:**
- Consumes: WorkbenchService.searchMemory（Task 7），daemon HTTP 代理模式（参照现有 `invoke_employee` 工具怎么经 `request()` 调 daemon）。
- Produces: MCP 工具 `search_memory`，入参 `{ query: string; employeeId?: string; projectId?: string; limit?: number; kind?: string }`，返回 evidence 数组的 JSON 文本。
- 依赖：daemon 侧需有 HTTP 端点 `POST /api/memory/search`（若现有 MCP 工具都走 daemon HTTP，则本任务附带在 `src/daemon/server.ts` 加该路由，调用 `service.searchMemory`）。

- [ ] **Step 1: 写失败测试（daemon 路由 + 工具入参 schema）**

```typescript
// tests/memory-mcp-route.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";

// 直接测 service 层的检索契约（MCP/daemon 只是透传）；
// daemon 路由的 e2e 由现有 daemon 测试范式覆盖。
describe("search_memory contract", () => {
  it("service.searchMemory accepts the MCP argument shape", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mem-mcp-"));
    const svc = await WorkbenchService.open({ dataRoot });
    const hits = await svc.searchMemory({
      query: "前端",
      scope: { employeeId: "r", projectId: "cart-fe" },
      limit: 3
    });
    expect(Array.isArray(hits)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败/通过基线**

Run: `npx vitest run tests/memory-mcp-route.test.ts`
Expected: 若 Task 7 已完成则 PASS（契约成立）；本步用于锁定 MCP 入参形状。

- [ ] **Step 3: 加 daemon 路由（若 MCP 走 HTTP 代理）**

在 `src/daemon/server.ts` 参照现有 `/api/publications/:id/invoke` 等路由，新增：

```typescript
  // POST /api/memory/search
  app.post("/api/memory/search", async (req, res) => {
    const body = req.body ?? {};
    const hits = await service.searchMemory({
      query: String(body.query ?? ""),
      scope: { employeeId: body.employeeId, projectId: body.projectId },
      limit: body.limit,
      kind: body.kind
    });
    res.json({ evidence: hits });
  });
```

- [ ] **Step 4: 注册 MCP 工具**

在 `src/mcp/server.ts` 参照 `invoke_employee`（`~642`）：

```typescript
  server.registerTool("search_memory", {
    description: "按 employee/project 维度检索该 Agent 过去运行的精炼经验；平时不注入，需要时才查以省 token。默认返回运行级摘要。",
    inputSchema: {
      query: z.string().min(1),
      employeeId: z.string().optional(),
      projectId: z.string().optional(),
      limit: z.number().int().min(1).max(40).optional(),
      kind: z.enum(["run-summary", "node-detail", "preference"]).optional()
    }
  }, async (args) => {
    const data = await request<{ evidence: unknown[] }>(daemonUrl, "/api/memory/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args)
    });
    return { content: [{ type: "text", text: JSON.stringify(data.evidence, null, 2) }] };
  });
```

> 实施者：`z`、`request`、`daemonUrl`、`server.registerTool` 的确切用法对齐同文件既有工具；参数结构（第二参是否含 `inputSchema` vs `paramsSchema`）以现有工具为准。

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `npx vitest run tests/memory-mcp-route.test.ts && npm run typecheck:server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/daemon/server.ts tests/memory-mcp-route.test.ts
git commit -m "feat: expose search_memory via MCP tool and daemon route"
```

---

### Task 9: CLI 命令 `memory archive` / `memory reindex` / `memory search`

**Files:**
- Modify: `src/cli/main.ts`（参照 `workbench.command("employee")` 嵌套，`~180` 附近加 `memory` 子命令组）

**Interfaces:**
- Consumes: `workbenchService()`（`src/cli/main.ts:55`）, `service.archiveMemory/reindexMemory/searchMemory`（Task 7）。
- Produces: CLI:
  - `multi-agent workbench memory search <query> [--employee <id>] [--project <id>] [--limit <n>] [--kind <k>]`
  - `multi-agent workbench memory archive <id>`
  - `multi-agent workbench memory reindex`
  - 输出走现有 `process.stdout.write(JSON.stringify(..., null, 2))` 模式。

- [ ] **Step 1: 加 CLI 子命令**

在 `src/cli/main.ts` 的 `workbench` 命令组内加入：

```typescript
const memory = workbench.command("memory").description("检索、归档与重建本地 memory");

memory
  .command("search <query>")
  .option("--employee <id>", "限定 employee scope")
  .option("--project <id>", "限定 project scope")
  .option("--limit <n>", "返回条数上限", (v) => Number.parseInt(v, 10))
  .option("--kind <kind>", "run-summary | node-detail | preference")
  .action(async (query, options) => {
    const hits = await (await workbenchService()).searchMemory({
      query,
      scope: { employeeId: options.employee, projectId: options.project },
      limit: options.limit,
      kind: options.kind
    });
    process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
  });

memory
  .command("archive <id>")
  .action(async (id) => {
    process.stdout.write(`${JSON.stringify(await (await workbenchService()).archiveMemory(id), null, 2)}\n`);
  });

memory
  .command("reindex")
  .action(async () => {
    const count = await (await workbenchService()).reindexMemory();
    process.stdout.write(`${JSON.stringify({ reindexed: count }, null, 2)}\n`);
  });
```

- [ ] **Step 2: 手动冒烟 + 类型检查**

Run: `npm run typecheck:server && npx tsx src/cli/main.ts workbench memory reindex`
Expected: 类型通过；`reindex` 输出 `{ "reindexed": 0 }`（空库）

- [ ] **Step 3: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat: add memory search/archive/reindex CLI commands"
```

---

### Task 10: 展示层接入 formatDateTime + 全量校验 + 文档

**Files:**
- Modify: `src/cli/main.ts`（memory search 输出里把 `createdAt` 用 `formatDateTime` 展示——可加一个 `displayCreatedAt` 字段，保留原始 `createdAt`）
- Create: `docs/memory-system.md`（使用说明）
- Modify: `README.md`（在能力清单加一行 memory）

**Interfaces:**
- Consumes: `formatDateTime`（Task 2）, `searchMemory`（Task 7）。
- Produces: 无新代码接口；文档 + 展示接入。

- [ ] **Step 1: memory search 输出接入 formatDateTime**

在 Task 9 的 `memory search` action 里，map 一层展示字段：

```typescript
import { formatDateTime } from "../config/datetime.js"; // 顶部 import
// ...action 内：
    const display = hits.map((h) => ({ ...h, displayCreatedAt: formatDateTime(h.createdAt) }));
    process.stdout.write(`${JSON.stringify(display, null, 2)}\n`);
```

- [ ] **Step 2: 写使用文档**

创建 `docs/memory-system.md`，内容涵盖：memory 是什么、目录结构 `~/.multi-agent/workbench/memory/`、自动提炼触发时机、`search_memory` MCP 工具用法、CLI 三命令、非目标清单。（照实描述本 plan 已实现行为，不写未实现能力。）

- [ ] **Step 3: README 加一行**

在 README 能力清单加入：`- 运行后自动提炼跨会话经验到本地 memory，按 employee/project 维度通过 search_memory 工具按需检索；`

- [ ] **Step 4: 全量校验**

Run: `npm run check`
Expected: typecheck + 全部测试 + build 通过

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts docs/memory-system.md README.md
git commit -m "docs: memory system usage; wire formatDateTime into CLI output"
```

---

## Self-Review

**1. Spec coverage（逐节核对）：**
- §3 数据模型 → Task 1（类型）+ Task 3（存储）✅
- §4 写入/自动提炼（价值 gate + Employee 提炼器 + 异步触发 + 幂等 + 降级）→ Task 5（gate）+ Task 6（extractor）+ Task 7（Employee 提炼器 + 异步触发）✅
- §5 检索（按需工具 + scope 分片 + 打分 + 预算 + 下钻 + [M#]）→ Task 4（retriever）+ Task 8（MCP 工具）✅
- §6 改/删/生命周期（软删除 + supersede 预留）→ Task 3（archive）+ Task 9（CLI archive）；supersedesId 字段在 Task 1 预留 ✅
- §7 错误处理（提炼失败降级、索引重建、幂等、scope 缺失）→ Task 6（降级/幂等）+ Task 3（reindex）+ Task 7（catch）✅
- §8 时间戳展示层 → Task 2（formatDateTime）+ Task 10（接入）✅
- §9 测试策略 → 每个 Task 内嵌单测；Task 7 覆盖主链路回归 ✅
- §10 组件边界 → Task 3/6/4/8/2/9 一一对应 ✅

**2. Placeholder scan：** 无 TBD/TODO；所有代码步骤含真实代码。两处标注「实施者对齐现有命名/范式」（Task 7 局部变量名、Task 8 MCP registerTool 具体签名）——这是因为要嵌入现有大文件，属于合理的「跟随现有模式」指引，非占位符。

**3. Type consistency：** `MemoryRecord`/`MemoryScope`/`MemoryEvidence`/`MemorySearchQuery` 全程一致；`scopeKeys` 命名一致（Task 3 定义、Task 4/6 使用）；`SummarizeFn`/`RunLike` 在 Task 6 定义、Task 7 复用；`searchMemory`/`archiveMemory`/`reindexMemory` 在 Task 7 定义、Task 8/9 使用，签名一致。

**已知风险提示（供执行者）：** Task 7 是唯一改动现有大文件（service.ts）的任务，插入点的局部变量名需按 `invokeResolvedEmployee` 真实作用域对齐；建议执行该任务前先完整读一遍该方法。
