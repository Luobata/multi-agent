# Workbench UX Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine three areas of the local multi-agent Workbench UI — default the 协作编排 nav to its supervisor sub-tab, classify the 运行卷宗 by type and project with filters + colored tags, and add an animated supervisor "studio" live board to 员工大厅.

**Architecture:** All three are additive/localized. Change 1 flips one `useState` default and updates its tests. Change 2 enriches the backend `listRuns` response by joining in-memory invocations (no disk change), then adds frontend filters + tags. Change 3 adds a studio section to the existing SSE-backed office floor, polling the existing `/api/invocations/:id/progress` endpoint, with a CSS-animated progress bar.

**Tech Stack:** TypeScript, React (no framework — hand-rolled `createRoot` render + hash routing), Vitest + jsdom, Node HTTP daemon, CSS custom-property design tokens in `client/src/styles.css`.

## Global Constraints

- `run.json` on disk is immutable and must never be rewritten; enrichment happens only in the `listRuns` response.
- UI copy is Simplified Chinese, matching existing tone (e.g. 单任务 / Graph 编排 / 领队协作 / 无项目).
- Reuse existing design tokens (`--dur-fast`, `--dur-base`, `--ease-out`) and the existing `@keyframes` + `@media (prefers-reduced-motion: reduce)` conventions in `styles.css`; do not introduce a CSS framework.
- No new navigation entries or routes; no changes to run execution/persistence; the supervisor authoring sub-tab stays the config/editor.
- Frontend tests use the established harness: `/** @vitest-environment jsdom */`, `createRoot`, `act`, `vi.stubGlobal("fetch", fetchMock)`, `IS_REACT_ACT_ENVIRONMENT = true`.
- Backend tests use `WorkbenchService.open({ dataRoot: temporaryRoot() })` with the `mock` provider.
- Run `npm test` and `npm run build` green before considering the work complete.

---

## File Structure

- `client/src/WorkflowPage.tsx` — flip default sub-tab (Change 1).
- `client/src/WorkflowPage.test.tsx` — update tests for the new default (Change 1).
- `src/workbench/service.ts` — enrich `listRuns` with `category`/`project`/`trigger` via invocation join (Change 2).
- `tests/workbench.test.ts` — cover `listRuns` enrichment + fallback (Change 2).
- `client/src/types.ts` — add optional `category`/`project`/`trigger` to `Run` (Change 2).
- `client/src/RunsPage.tsx` — type + project filters, colored category tags, project chips (Change 2).
- `client/src/RunsPage.test.tsx` — NEW: filter + tag rendering tests (Change 2).
- `client/src/officeStudio.ts` — NEW: pure helpers (completion ratio from tally, active-supervisor selection) (Change 3).
- `client/src/officeStudio.test.ts` — NEW: unit tests for those helpers (Change 3).
- `client/src/OfficePage.tsx` — studio section + `/progress` polling hook + animated bar markup (Change 3).
- `client/src/OfficePage.test.tsx` — NEW: studio card render + polling-selection test (Change 3).
- `client/src/styles.css` — studio card + animated progress bar styles + keyframes (Change 3).

---

## Task 1: Default 协作编排 to the supervisor sub-tab

**Files:**
- Modify: `client/src/WorkflowPage.tsx:255`
- Test: `client/src/WorkflowPage.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new (behavioral default change only).

Context: `WorkflowPage` tracks the active sub-tab in local state. The four tabs are entrance / graph / supervisor / policies. Currently the default is `"graph"`. The async-run tests in `WorkflowPage.test.tsx` render `WorkflowPage` in `beforeEach` and immediately operate on `#run-workflow` — the **graph** page's run section — so flipping the default requires those tests to first click the "Graph 编排" tab.

- [ ] **Step 1: Update the failing test's harness to select the Graph tab**

In `client/src/WorkflowPage.test.tsx`, inside the `describe("WorkflowPage async run order", ...)` block's `beforeEach` (around line 286-287), after the initial render + first `flush()`, add a click into the Graph tab so the existing `#run-workflow` assertions still find the graph run section:

```tsx
act(() => root.render(<WorkflowPage data={data} refresh={refresh} notify={notify} />));
await flush(); // lets the version-history read settle inside act
const graphTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".orchestration-switcher nav button"))
  .find((button) => button.textContent?.includes("Graph 编排"));
if (!graphTab) throw new Error("Graph 编排 标签未找到");
click(graphTab);
await flush();
```

- [ ] **Step 2: Add a test asserting the supervisor tab is the default landing**

Add a new `it` in the same file (a fresh render, not using the graph-selecting `beforeEach` mutation — place it in a describe with its own minimal render, or assert before the graph click). Simplest: add a standalone test that renders `WorkflowPage` and checks the supervisor page is active without any click:

```tsx
it("lands on the supervisor sub-tab by default", async () => {
  const localContainer = document.createElement("div");
  document.body.append(localContainer);
  const localRoot = createRoot(localContainer);
  const data = bootstrapWith({
    employees: [employee("mihuhu-frontend-engineer", "米糊糊 · 前端"), employee("xiaomixiang-tester", "小米象 · 测试")]
  });
  act(() => localRoot.render(<WorkflowPage data={data} refresh={vi.fn(async () => undefined)} notify={vi.fn()} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const supervisorTab = Array.from(localContainer.querySelectorAll<HTMLButtonElement>(".orchestration-switcher nav button"))
    .find((button) => button.textContent?.includes("协作编排"));
  expect(supervisorTab?.getAttribute("aria-pressed")).toBe("true");
  act(() => localRoot.unmount());
  localContainer.remove();
});
```

- [ ] **Step 3: Run the tests to verify the new default test fails**

Run: `npx vitest run client/src/WorkflowPage.test.tsx`
Expected: the new "lands on the supervisor sub-tab by default" test FAILS (aria-pressed is "false" because default is still `"graph"`). Pre-existing async-run tests should now PASS thanks to the Step 1 graph-tab click.

- [ ] **Step 4: Flip the default in the component**

In `client/src/WorkflowPage.tsx:255`, change:

```tsx
const [section, setSection] = useState<"entrance" | "graph" | "supervisor" | "policies">("graph");
```
to:
```tsx
const [section, setSection] = useState<"entrance" | "graph" | "supervisor" | "policies">("supervisor");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run client/src/WorkflowPage.test.tsx`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/WorkflowPage.tsx client/src/WorkflowPage.test.tsx
git commit -m "feat: default orchestration workspace to the supervisor sub-tab"
```

---

## Task 2: Enrich `listRuns` with category / project / trigger (backend)

**Files:**
- Modify: `src/workbench/service.ts:5948-5970` (`listRuns`)
- Test: `tests/workbench.test.ts`

**Interfaces:**
- Consumes: `this.snapshot().invocations` (a `Record<string, InvocationRecord>`; each has `runId`, `target.kind`, `source.project`, `source.kind`, `executionSnapshot?.workflow.architecture`).
- Produces: each element of the `listRuns()` array gains three fields:
  - `category: "single" | "graph" | "supervisor"`
  - `project?: string`
  - `trigger?: "workbench" | "http" | "mcp" | "a2a"`

Context: `listRuns` reads `artifacts/runs/*/run.json`, sorts by `createdAt` desc, slices. `invokeEmployee` records an invocation with `target.kind: "employee"` (single task); `runWorkbenchWorkflow` records `target.kind: "workflow"`. Both set `runId`. Runs with no correlated invocation (e.g. older data) fall back to the run's own `architecture` + workflow-id prefix (`direct-` ⇒ single).

- [ ] **Step 1: Write the failing test**

Add to `tests/workbench.test.ts` a test that creates an employee, runs both a direct invocation and a graph workflow, then asserts `listRuns` classification. Follow the existing `mock`-provider setup used elsewhere in the file:

```ts
it("classifies runs by category and project in listRuns", async () => {
  const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
  await service.createSkill({ id: "noop", description: "noop", instructions: "Respond." });
  const employee = await service.createEmployee({
    id: "classify-worker",
    identity: { displayName: "Classify Worker", background: "Test", responsibilities: ["Respond"] },
    skills: [{ id: "noop", config: {} }],
    providerId: "mock"
  });

  await service.invokeEmployee(
    employee.id,
    { message: "single task" },
    { kind: "mcp", project: "demo-project" }
  );

  await service.createWorkflow({
    id: "graph-flow",
    description: "Graph flow.",
    nodes: [{ id: "review", employeeId: employee.id, needs: [], with: {} }]
  });
  await service.runWorkbenchWorkflow("graph-flow", {}, { kind: "workbench" });

  const runs = await service.listRuns() as Array<{ category: string; project?: string; trigger?: string; workflow: string }>;
  const single = runs.find((run) => run.workflow.startsWith("direct-"));
  const graph = runs.find((run) => run.workflow === "graph-flow");

  expect(single?.category).toBe("single");
  expect(single?.project).toBe("demo-project");
  expect(single?.trigger).toBe("mcp");
  expect(graph?.category).toBe("graph");
  expect(graph?.trigger).toBe("workbench");
});
```

Note: confirm the `runWorkbenchWorkflow` signature accepts a source argument (`service.ts:5727`); if its source parameter is at a different position, pass the source in the correct position. If `invokeEmployee`/`runWorkbenchWorkflow` require an input schema, add a minimal one as the surrounding tests do.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workbench.test.ts -t "classifies runs by category"`
Expected: FAIL — `category`/`project`/`trigger` are `undefined`.

- [ ] **Step 3: Implement the enrichment in `listRuns`**

In `src/workbench/service.ts`, replace the return of `listRuns` (currently the filter/sort/slice at lines 5966-5969) with an enriched version. Add a private helper for classification and apply it after loading + sorting:

```ts
async listRuns(limit = 50): Promise<unknown[]> {
  const runsRoot = path.join(this.store.dataRoot, "artifacts", "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    entries.map(async (entry) => {
      try {
        return JSON.parse(await fs.readFile(path.join(runsRoot, entry, "run.json"), "utf8")) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
  );
  const invocationsByRunId = new Map<string, InvocationRecord>();
  for (const invocation of Object.values(this.snapshot().invocations)) {
    invocationsByRunId.set(invocation.runId, invocation);
  }
  return records
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map((record) => this.classifyRunSummary(record, invocationsByRunId.get(String(record.id ?? ""))));
}

private classifyRunSummary(
  record: Record<string, unknown>,
  invocation: InvocationRecord | undefined
): Record<string, unknown> {
  const workflow = String(record.workflow ?? "");
  const runArchitecture = String(record.architecture ?? "");
  let category: "single" | "graph" | "supervisor";
  if (invocation) {
    category = invocation.target.kind === "employee"
      ? "single"
      : invocation.executionSnapshot?.workflow.architecture === "supervisor"
        ? "supervisor"
        : "graph";
  } else {
    category = runArchitecture === "supervisor"
      ? "supervisor"
      : workflow.startsWith("direct-")
        ? "single"
        : "graph";
  }
  return {
    ...record,
    category,
    ...(invocation?.source.project ? { project: invocation.source.project } : {}),
    ...(invocation ? { trigger: invocation.source.kind } : {})
  };
}
```

Ensure `InvocationRecord` is imported in `service.ts` (check existing imports; the type is defined in `./types`). If it is not already imported, add it to the existing type import from `./types.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/workbench.test.ts -t "classifies runs by category"`
Expected: PASS.

- [ ] **Step 5: Add the no-invocation fallback test**

Add a second test that writes a `run.json` directly to disk with no matching invocation and asserts the fallback classification:

```ts
it("falls back to run architecture when no invocation is correlated", async () => {
  const root = temporaryRoot();
  const service = await WorkbenchService.open({ dataRoot: root });
  const runDir = path.join(root, "artifacts", "runs", "run-orphan-1");
  await fs.promises.mkdir(runDir, { recursive: true });
  await fs.promises.writeFile(path.join(runDir, "run.json"), JSON.stringify({
    id: "run-orphan-1",
    workflow: "direct-ghost",
    architecture: "graph",
    artifactDir: runDir,
    status: "passed",
    createdAt: "2026-08-06T00:00:00.000Z",
    nodes: {}
  }));
  const runs = await service.listRuns() as Array<{ category: string; project?: string; trigger?: string; id: string }>;
  const orphan = runs.find((run) => run.id === "run-orphan-1");
  expect(orphan?.category).toBe("single");
  expect(orphan?.project).toBeUndefined();
  expect(orphan?.trigger).toBeUndefined();
});
```

Confirm the file uses `fs.promises` or a `fs` import compatible with these calls (match the file's existing `fs` usage; `tests/workbench.test.ts` already imports `fs`).

- [ ] **Step 6: Run both backend tests**

Run: `npx vitest run tests/workbench.test.ts -t "listRuns" && npx vitest run tests/workbench.test.ts -t "falls back to run architecture"`
Expected: PASS. (If the `-t` name filter misses, run the whole file: `npx vitest run tests/workbench.test.ts`.)

- [ ] **Step 7: Commit**

```bash
git add src/workbench/service.ts tests/workbench.test.ts
git commit -m "feat: classify runs by category, project, and trigger in listRuns"
```

---

## Task 3: Run dossier type — extend the `Run` type

**Files:**
- Modify: `client/src/types.ts:484-496` (`Run` interface)

**Interfaces:**
- Consumes: nothing.
- Produces: `Run.category?: "single" | "graph" | "supervisor"`, `Run.project?: string`, `Run.trigger?: "workbench" | "http" | "mcp" | "a2a"`.

Context: these are optional because `getRun` (detail) does not attach them; only `listRuns` (summary) does. Optional keeps both response shapes assignable to `Run`.

- [ ] **Step 1: Add the fields to the `Run` interface**

In `client/src/types.ts`, inside `export interface Run { ... }`, add after `error?: string;`:

```ts
  /** Present on listRuns summaries (not on getRun detail): coarse run classification. */
  category?: "single" | "graph" | "supervisor";
  /** Present on listRuns summaries when the correlated invocation carried a project. */
  project?: string;
  /** Present on listRuns summaries: the trigger source of the correlated invocation. */
  trigger?: "workbench" | "http" | "mcp" | "a2a";
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit` (or `npm run build`'s typecheck step)
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/types.ts
git commit -m "feat: add category/project/trigger fields to Run summary type"
```

---

## Task 4: Run dossier — filters + colored tags (frontend)

**Files:**
- Modify: `client/src/RunsPage.tsx`
- Test: `client/src/RunsPage.test.tsx` (NEW)
- Modify: `client/src/styles.css` (category tag + project chip + filter bar styles)

**Interfaces:**
- Consumes: `Run.category`, `Run.project`, `Run.trigger` (Task 3); `api<Run[]>("/api/runs?limit=100")` (existing); `SelectControl` from `./components` (signature: `{ ariaLabel, value, options: Array<{ value; label; description? }>, onChange }`).
- Produces: filter UI + tags; no exported API.

Context: `RunsPage` fetches runs into `runs`, tracks `selectedId`, renders a left `record-list` of `run-card` buttons and a right detail pane. Add two filter selects above the list, filter `runs` before mapping, keep the footer count and empty state honest, and add a category tag + project chip to each card.

- [ ] **Step 1: Write the failing test**

Create `client/src/RunsPage.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsPage } from "./RunsPage";
import type { Run } from "./types";

const runs: Run[] = [
  { id: "run-single-1", workflow: "direct-alice", architecture: "graph", artifactDir: "/a", status: "passed", createdAt: "2026-08-06T03:00:00.000Z", nodes: {}, category: "single", project: "demo-project", trigger: "mcp" },
  { id: "run-graph-1", workflow: "graph-flow", architecture: "graph", artifactDir: "/b", status: "passed", createdAt: "2026-08-06T02:00:00.000Z", nodes: {}, category: "graph", trigger: "workbench" },
  { id: "run-sup-1", workflow: "team-flow", architecture: "supervisor", artifactDir: "/c", status: "blocked", createdAt: "2026-08-06T01:00:00.000Z", nodes: {}, category: "supervisor", project: "other-project", trigger: "http" }
];

describe("RunsPage classification filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith("/api/runs?")) return Promise.resolve({ ok: true, status: 200, json: async () => runs });
      if (url.startsWith("/api/runs/")) return Promise.resolve({ ok: true, status: 200, json: async () => runs.find((run) => url.endsWith(run.id)) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<RunsPage notify={vi.fn()} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
  });

  it("renders all runs with category tags by default", () => {
    const cards = container.querySelectorAll(".run-card");
    expect(cards).toHaveLength(3);
    expect(container.querySelector(".run-category-tag--single")).toBeTruthy();
    expect(container.querySelector(".run-category-tag--graph")).toBeTruthy();
    expect(container.querySelector(".run-category-tag--supervisor")).toBeTruthy();
  });

  it("filters the list by category", async () => {
    const typeSelect = container.querySelector<HTMLElement>('[data-testid="run-type-filter"]');
    expect(typeSelect).toBeTruthy();
    // The type filter is a SelectControl; simulate its onChange by dispatching through its option.
    // Assert the pure filter behavior via the rendered result after selecting "single".
    // (Implementation detail: SelectControl exposes a native control; see components.tsx.)
  });
});
```

Note: `SelectControl` is a custom control, not a native `<select>`. In Step 3 you will render the two filters. Adjust the "filters by category" test to drive whatever interactive element `SelectControl` renders (inspect `components.tsx:69` `SelectControl` — it renders a button that opens a listbox). Simpler and robust: assert the default render (tag classes + card count) and add a data-driven filtering assertion by calling the pure filter helper you extract in Step 2. If `SelectControl` interaction is awkward in jsdom, extract the filter predicate into a small pure function and unit-test that directly (preferred — see Step 2).

- [ ] **Step 2: Extract a pure filter helper and unit-test it**

To keep filtering testable without driving the custom select in jsdom, add a pure helper at the top of `RunsPage.tsx` and export it:

```tsx
export function filterRuns(
  runs: Run[],
  filters: { category: "all" | "single" | "graph" | "supervisor"; project: "all" | "none" | string }
): Run[] {
  return runs.filter((run) => {
    if (filters.category !== "all" && (run.category ?? "graph") !== filters.category) return false;
    if (filters.project === "none") return !run.project;
    if (filters.project !== "all" && run.project !== filters.project) return false;
    return true;
  });
}
```

Add to `RunsPage.test.tsx`:

```tsx
import { filterRuns } from "./RunsPage";

describe("filterRuns", () => {
  it("filters by category and project", () => {
    expect(filterRuns(runs, { category: "single", project: "all" }).map((run) => run.id)).toEqual(["run-single-1"]);
    expect(filterRuns(runs, { category: "all", project: "other-project" }).map((run) => run.id)).toEqual(["run-sup-1"]);
    expect(filterRuns(runs, { category: "all", project: "none" }).map((run) => run.id)).toEqual(["run-graph-1"]);
    expect(filterRuns(runs, { category: "all", project: "all" })).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run client/src/RunsPage.test.tsx`
Expected: FAIL — `filterRuns` not exported; `.run-category-tag--*` and `[data-testid="run-type-filter"]` not rendered.

- [ ] **Step 4: Implement filters, tags, and chips in `RunsPage`**

In `client/src/RunsPage.tsx`:

1. Add the `filterRuns` export from Step 2.
2. Add filter state and derived project options in the component:

```tsx
const [categoryFilter, setCategoryFilter] = useState<"all" | "single" | "graph" | "supervisor">("all");
const [projectFilter, setProjectFilter] = useState<"all" | "none" | string>("all");
const projectOptions = useMemo(
  () => [...new Set(runs.map((run) => run.project).filter((project): project is string => Boolean(project)))].sort(),
  [runs]
);
const visibleRuns = useMemo(
  () => filterRuns(runs, { category: categoryFilter, project: projectFilter }),
  [runs, categoryFilter, projectFilter]
);
```

Import `useMemo` from `react` (currently the file imports `useEffect, useState`).

3. When the selected run is filtered out, fall back to the first visible run. Replace the `summary`/`selected` derivation:

```tsx
const summary = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0];
const selected = detail?.id === summary?.id ? detail : summary;
```

4. Add a filter bar and category labels. Add near the top of the module:

```tsx
const CATEGORY_LABELS: Record<"single" | "graph" | "supervisor", string> = {
  single: "单任务",
  graph: "Graph 编排",
  supervisor: "领队协作"
};
```

Render the filter bar inside the `record-list` header area (below `<h1>运行卷宗</h1>`), using `SelectControl`:

```tsx
<div className="run-filter-bar">
  <div data-testid="run-type-filter">
    <SelectControl
      ariaLabel="按类型筛选运行卷宗"
      value={categoryFilter}
      options={[
        { value: "all", label: "全部类型" },
        { value: "single", label: "单任务" },
        { value: "graph", label: "Graph 编排" },
        { value: "supervisor", label: "领队协作" }
      ]}
      onChange={(value) => setCategoryFilter(value as typeof categoryFilter)}
    />
  </div>
  <div data-testid="run-project-filter">
    <SelectControl
      ariaLabel="按项目筛选运行卷宗"
      value={projectFilter}
      options={[
        { value: "all", label: "全部项目" },
        { value: "none", label: "无项目" },
        ...projectOptions.map((project) => ({ value: project, label: project }))
      ]}
      onChange={(value) => setProjectFilter(value)}
    />
  </div>
</div>
```

Import `SelectControl` from `./components` (add to the existing import).

5. Map `visibleRuns` (not `runs`) in the list, and add a tag + project chip to each `run-card`:

```tsx
{visibleRuns.map((run) => <button key={run.id} className={`run-card ${selected?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedId(run.id)}>
  <div>
    <code>{run.id}</code>
    <strong>{run.workflow}</strong>
    <small>{formatTime(run.createdAt)} · {run.architecture} · {Object.keys(run.nodes).length} 节点</small>
    <div className="run-card-tags">
      {run.category && <span className={`run-category-tag run-category-tag--${run.category}`}>{CATEGORY_LABELS[run.category]}</span>}
      {run.project && <span className="run-project-chip">{run.project}</span>}
    </div>
  </div>
  <Stamp status={run.status} />
</button>)}
```

6. Update the empty-state and footer count to reflect filtering:

```tsx
{!loading && visibleRuns.length === 0 && <div className="mini-empty">{runs.length === 0 ? "还没有 Run 证据。" : "没有符合筛选条件的卷宗。"}</div>}
```
and footer:
```tsx
<footer className="list-footer"><span>{visibleRuns.length}/{runs.length} 份卷宗</span><span>READ ONLY</span></footer>
```

- [ ] **Step 5: Add styles for the filter bar, tags, and chip**

In `client/src/styles.css`, add (near the existing `.run-card` / `.run-list` rules):

```css
.run-filter-bar { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); padding: var(--space-2) var(--space-3); }
.run-card-tags { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); }
.run-category-tag { display: inline-flex; align-items: center; padding: 1px var(--space-2); border-radius: var(--radius-1); border: 1px solid var(--line-strong); font-size: var(--text-xs); font-weight: 700; }
.run-category-tag--single { color: var(--ink); background: color-mix(in srgb, var(--accent-sky, #4a7fb5) 18%, transparent); border-color: color-mix(in srgb, var(--accent-sky, #4a7fb5) 55%, transparent); }
.run-category-tag--graph { color: var(--ink); background: color-mix(in srgb, var(--accent-moss, #5a8a5a) 18%, transparent); border-color: color-mix(in srgb, var(--accent-moss, #5a8a5a) 55%, transparent); }
.run-category-tag--supervisor { color: var(--ink); background: color-mix(in srgb, var(--accent-plum, #8a5aa0) 18%, transparent); border-color: color-mix(in srgb, var(--accent-plum, #8a5aa0) 55%, transparent); }
.run-project-chip { display: inline-flex; align-items: center; padding: 1px var(--space-2); border-radius: var(--radius-1); border: 1px dashed var(--line-strong); font-size: var(--text-xs); color: var(--ink-2); }
```

Before writing, grep `styles.css` for existing accent token names (e.g. `--accent`, `--seat-accent`, color vars) and reuse real ones; the `color-mix(... var(--x, #fallback) ...)` fallbacks above keep it safe if a token is absent. Confirm `--text-xs` / `--radius-1` / `--space-*` exist (they're used throughout); if `--text-xs` does not exist, use the smallest existing text token.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run client/src/RunsPage.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/RunsPage.tsx client/src/RunsPage.test.tsx client/src/styles.css
git commit -m "feat: filter and tag runs by type and project in the run dossier"
```

---

## Task 5: Office studio — pure helpers

**Files:**
- Create: `client/src/officeStudio.ts`
- Test: `client/src/officeStudio.test.ts` (NEW)

**Interfaces:**
- Consumes: `InvocationRecord`, `WorkInstanceStatus` from `./types`.
- Produces:
  - `completionRatio(tally: Record<WorkInstanceStatus, number>): number` — 0..1, `completed / total`, `0` when total is 0.
  - `progressTone(status: InvocationRecord["status"]): "running" | "completed" | "blocked" | "failed"` — maps invocation status to a bar tone (`queued`/`running` ⇒ `"running"`; `completed` ⇒ `"completed"`; `blocked` ⇒ `"blocked"`; `failed`/`cancelled` ⇒ `"failed"`).
  - `activeSupervisorInvocations(invocations: InvocationRecord[]): InvocationRecord[]` — supervisor architecture AND non-terminal status.

Context: keep all classification/derivation logic pure and unit-tested, so `OfficePage` only wires state.

- [ ] **Step 1: Write the failing test**

Create `client/src/officeStudio.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeSupervisorInvocations, completionRatio, progressTone } from "./officeStudio";
import type { InvocationRecord, WorkInstanceStatus } from "./types";

function tally(overrides: Partial<Record<WorkInstanceStatus, number>>): Record<WorkInstanceStatus, number> {
  return { queued: 0, waiting: 0, running: 0, completed: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0, ...overrides };
}

const base: InvocationRecord = {
  id: "inv-1",
  target: { kind: "workflow", id: "team-flow", version: 1 },
  source: { kind: "workbench" },
  status: "running",
  phase: "provider",
  requestSummary: "team task",
  runId: "run-1",
  instanceIds: [],
  executionSnapshot: { workflow: { id: "team-flow", version: 1, architecture: "supervisor" }, employees: [] },
  createdAt: "t",
  updatedAt: "t",
  transitions: []
};

describe("completionRatio", () => {
  it("returns completed over total, 0 when empty", () => {
    expect(completionRatio(tally({ completed: 2, running: 2 }))).toBe(0.5);
    expect(completionRatio(tally({}))).toBe(0);
    expect(completionRatio(tally({ completed: 3 }))).toBe(1);
  });
});

describe("progressTone", () => {
  it("maps status to a tone", () => {
    expect(progressTone("running")).toBe("running");
    expect(progressTone("queued")).toBe("running");
    expect(progressTone("completed")).toBe("completed");
    expect(progressTone("blocked")).toBe("blocked");
    expect(progressTone("failed")).toBe("failed");
    expect(progressTone("cancelled")).toBe("failed");
  });
});

describe("activeSupervisorInvocations", () => {
  it("keeps only supervisor, non-terminal invocations", () => {
    const graph: InvocationRecord = { ...base, id: "inv-2", executionSnapshot: { workflow: { id: "g", version: 1, architecture: "graph" }, employees: [] } };
    const doneSupervisor: InvocationRecord = { ...base, id: "inv-3", status: "completed" };
    expect(activeSupervisorInvocations([base, graph, doneSupervisor]).map((invocation) => invocation.id)).toEqual(["inv-1"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run client/src/officeStudio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `officeStudio.ts`**

Create `client/src/officeStudio.ts`:

```ts
import type { InvocationRecord, WorkInstanceStatus } from "./types";

const TERMINAL_INVOCATION_STATUSES = new Set(["completed", "blocked", "failed", "cancelled"]);

export function completionRatio(tally: Record<WorkInstanceStatus, number>): number {
  const total = Object.values(tally).reduce((sum, count) => sum + count, 0);
  return total === 0 ? 0 : tally.completed / total;
}

export function progressTone(status: InvocationRecord["status"]): "running" | "completed" | "blocked" | "failed" {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed" || status === "cancelled") return "failed";
  return "running";
}

export function activeSupervisorInvocations(invocations: InvocationRecord[]): InvocationRecord[] {
  return invocations.filter((invocation) =>
    invocation.executionSnapshot?.workflow.architecture === "supervisor"
    && !TERMINAL_INVOCATION_STATUSES.has(invocation.status));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run client/src/officeStudio.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/officeStudio.ts client/src/officeStudio.test.ts
git commit -m "feat: add pure helpers for the office supervisor studio board"
```

---

## Task 6: Office studio — polling hook, studio cards, animated bar

**Files:**
- Modify: `client/src/OfficePage.tsx`
- Test: `client/src/OfficePage.test.tsx` (NEW)
- Modify: `client/src/styles.css` (studio card + animated progress bar + keyframes)

**Interfaces:**
- Consumes: `activeSupervisorInvocations`, `completionRatio`, `progressTone` (Task 5); `InvocationProgress` shape from `GET /api/invocations/:id/progress` (fields used: `round`, `tally`, `leaderReport.entries[]` with `round`/`action`/`summary`/`assignments[]`, `gates[]`); `api` from `./api`; `EmployeeAvatar`, `RuntimeStatusChip` from `./components`.
- Produces: a studio section rendered on the office floor; no new exports.

Context: `OfficePage` already streams instances via props (`data.activity`) and ticks a 1s `clock`. Add a coarser poll (~2s) that fetches `/progress` for each active supervisor invocation and stores results in state keyed by invocation id. Render one studio card per active supervisor invocation.

- [ ] **Step 1: Write the failing test**

Create `client/src/OfficePage.test.tsx` (model the harness on `WorkflowPage.test.tsx`). It renders `OfficePage` with a bootstrap containing one active supervisor invocation and mocks `/api/invocations/:id/progress`:

```tsx
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficePage } from "./OfficePage";
import type { Bootstrap, InvocationRecord } from "./types";

const timestamp = "2026-08-06T00:00:00.000Z";

const supervisorInvocation: InvocationRecord = {
  id: "inv-team-1",
  target: { kind: "workflow", id: "team-flow", version: 1 },
  source: { kind: "workbench" },
  status: "running",
  phase: "provider",
  requestSummary: "组织团队完成任务",
  runId: "run-team-1",
  instanceIds: [],
  executionSnapshot: { workflow: { id: "team-flow", version: 1, architecture: "supervisor" }, employees: [] },
  createdAt: timestamp,
  updatedAt: timestamp,
  transitions: []
};

const bootstrap = {
  providers: [], skills: [], knowledgeBases: [], knowledgeProfiles: [], architectureTemplates: [],
  employees: [], managementPolicies: [], entrancePolicies: [], workflows: [], sessions: [], publications: [],
  projects: [], projectBindings: [],
  activity: { invocations: [supervisorInvocation], instances: [] }
} as unknown as Bootstrap;

const progress = {
  invocationId: "inv-team-1", runId: "run-team-1", workflowId: "team-flow", architecture: "supervisor",
  status: "running", phase: "provider", terminal: false, updatedAt: timestamp, round: 2,
  tally: { queued: 0, waiting: 0, running: 1, completed: 3, blocked: 0, failed: 0, skipped: 0, cancelled: 0 },
  steps: [],
  leaderReport: { available: true, rounds: 2, delegations: 2, entries: [{ round: 2, action: "delegate", summary: "继续推进", assignments: [{ roleId: "researcher", task: "调研" }], status: "running" }], gates: [] }
};

describe("OfficePage supervisor studio", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/progress")) return Promise.resolve({ ok: true, status: 200, json: async () => progress });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<OfficePage data={bootstrap} streamStatus="live" />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    fetchMock.mockReset();
  });

  it("renders a studio card with a progress bar for the active supervisor invocation", async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".studio-card")).toBeTruthy();
    const bar = container.querySelector<HTMLElement>(".studio-progress-fill");
    expect(bar).toBeTruthy();
    // 3 completed of 4 total => 75%
    expect(bar?.style.width).toBe("75%");
    expect(container.textContent).toContain("Round 2");
  });

  it("polls the progress endpoint for the supervisor invocation", async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/invocations/inv-team-1/progress"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run client/src/OfficePage.test.tsx`
Expected: FAIL — no `.studio-card` / `.studio-progress-fill` rendered.

- [ ] **Step 3: Add the progress-polling hook to `OfficePage`**

In `client/src/OfficePage.tsx`, import the helpers and `api`:

```tsx
import { api } from "./api";
import { activeSupervisorInvocations, completionRatio, progressTone } from "./officeStudio";
import type { InvocationProgress } from "./types";
```

`InvocationProgress` must be available to the client. It is defined server-side in `src/workbench/invocationProgress.ts`. Add a matching interface to `client/src/types.ts` (the client keeps its own copy of server response shapes — mirror the fields the studio uses):

```ts
export interface InvocationProgress {
  invocationId: string;
  runId: string;
  workflowId: string;
  architecture: string;
  status: InvocationStatus;
  phase: string;
  terminal: boolean;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  round: number;
  tally: Record<WorkInstanceStatus, number>;
  steps: Array<{ nodeId: string; roleId?: string; kind?: string; round?: number; employeeId: string; status: WorkInstanceStatus; phase: string; error?: string; startedAt?: string; completedAt?: string }>;
  leaderReport: {
    available: boolean;
    rounds: number;
    delegations: number;
    entries: Array<{ round: number; action: string; summary?: string; assignments: Array<{ roleId?: string; task?: string; workKind?: string }>; status: WorkInstanceStatus | "pending" }>;
    gates: Array<{ gateId: string; status: string }>;
  };
  outcome?: { status: string; summary?: string; reason?: string };
}
```

(Do this as the first sub-step of Task 6; it is part of this task's deliverable.)

In the `OfficePage` component body, add polling state + effect:

```tsx
const [progressById, setProgressById] = useState<Record<string, InvocationProgress>>({});
const activeSupervisors = useMemo(
  () => activeSupervisorInvocations(data.activity.invocations),
  [data.activity.invocations]
);
const activeSupervisorKey = activeSupervisors.map((invocation) => invocation.id).join(",");
useEffect(() => {
  if (activeSupervisors.length === 0) return;
  let cancelled = false;
  const poll = async () => {
    await Promise.all(activeSupervisors.map(async (invocation) => {
      try {
        const value = await api<InvocationProgress>(`/api/invocations/${encodeURIComponent(invocation.id)}/progress`);
        if (!cancelled) setProgressById((current) => ({ ...current, [invocation.id]: value }));
      } catch {
        // transient; next tick retries
      }
    }));
  };
  void poll();
  const timer = window.setInterval(() => void poll(), 2000);
  return () => { cancelled = true; window.clearInterval(timer); };
}, [activeSupervisorKey]);
```

Import `useMemo` (already imported in this file per its import line) — confirm `useMemo` is in the `react` import; it is used already at `OfficePage.tsx:198`.

- [ ] **Step 4: Render the studio section**

Add a studio section to the returned JSX, above the `office-floor` section (or as a band at the top of `office-layout`). One card per active supervisor invocation:

```tsx
{activeSupervisors.length > 0 && <section className="office-studio" aria-label="团队作战室">
  <header className="office-studio-heading"><div><span>TEAM WAR ROOM</span><h2>领队工作室</h2></div><p>{activeSupervisors.length} 个团队正在运行</p></header>
  <div className="studio-grid">
    {activeSupervisors.map((invocation) => {
      const progress = progressById[invocation.id];
      const ratio = progress ? completionRatio(progress.tally) : 0;
      const tone = progressTone(invocation.status);
      const latestEntry = progress?.leaderReport.entries.at(-1);
      const leaderEmployeeId = invocation.executionSnapshot?.employees[0]?.employeeId;
      const leader = data.employees.find((employee) => employee.id === leaderEmployeeId);
      return <article key={invocation.id} className={`studio-card studio-card--${tone}`}>
        <header className="studio-card-head">
          <div><span>{invocation.executionSnapshot?.workflow.id ?? invocation.target.id}</span><strong>{invocation.requestSummary}</strong></div>
          <span className="studio-round">Round {progress?.round ?? invocation.executionSnapshot?.workflow.version ?? 1}</span>
        </header>
        <div className={`studio-progress ${tone === "running" ? "studio-progress--live" : ""}`}>
          <i className="studio-progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} aria-hidden="true" />
        </div>
        <div className="studio-progress-legend"><span>{Math.round(ratio * 100)}% 完成</span>{progress && <span>{progress.tally.completed}/{Object.values(progress.tally).reduce((sum, count) => sum + count, 0)} 步</span>}</div>
        {latestEntry && <p className="studio-leader-note"><code>{latestEntry.action.toUpperCase()}</code>{latestEntry.summary ?? "领队正在决策。"}</p>}
        <div className="studio-team">
          <div className="studio-leader"><EmployeeAvatar displayName={leader?.identity.displayName ?? leaderEmployeeId ?? "领队"} presentation={leader?.presentation} /><span>领队</span></div>
          <div className="studio-members">
            {(latestEntry?.assignments ?? []).map((assignment, index) => {
              const member = data.employees.find((employee) => employee.identity.displayName === assignment.roleId) ?? undefined;
              return <div className="studio-member" key={`${assignment.roleId ?? "role"}-${index}`}><EmployeeAvatar className="small" displayName={assignment.roleId ?? "成员"} presentation={member?.presentation} /><small>{assignment.roleId}</small><span>{assignment.task ?? "待指派"}</span></div>;
            })}
            {(latestEntry?.assignments ?? []).length === 0 && <span className="studio-empty">领队尚未在本轮分派成员。</span>}
          </div>
        </div>
        {progress && progress.leaderReport.gates.length > 0 && <div className="studio-gates">{progress.leaderReport.gates.map((gate) => <span key={gate.gateId} className={`studio-gate studio-gate--${gate.status}`}>{gate.gateId} · {gate.status}</span>)}</div>}
      </article>;
    })}
  </div>
</section>}
```

Note: member-employee resolution by `roleId` is best-effort (roles bind to employees in the supervisor definition, which is not in this props scope); the avatar falls back to the role label. This matches the spec's "members around" intent without over-fetching.

- [ ] **Step 5: Add studio + animated progress styles**

In `client/src/styles.css`, add:

```css
.office-studio { padding: var(--space-4); border-bottom: 1px solid var(--line-strong); background: var(--paper); }
.office-studio-heading { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--space-3); }
.studio-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--space-3); }
.studio-card { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--line-strong); border-left: 4px solid var(--ink-3); border-radius: var(--radius-1); background: var(--paper-raised); box-shadow: var(--shadow-paper-small); }
.studio-card--completed { border-left-color: var(--ok, #4c8c4a); }
.studio-card--blocked { border-left-color: var(--warn, #c98a2b); }
.studio-card--failed { border-left-color: var(--danger, #b5453c); }
.studio-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.studio-round { font-size: var(--text-xs); font-weight: 700; color: var(--ink-2); }
.studio-progress { position: relative; height: 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper-sunken); overflow: hidden; }
.studio-progress-fill { position: absolute; inset: 0 auto 0 0; height: 100%; background: var(--ink-3); transition: width var(--dur-base) var(--ease-out); }
.studio-card--completed .studio-progress-fill { background: var(--ok, #4c8c4a); }
.studio-card--blocked .studio-progress-fill { background: var(--warn, #c98a2b); }
.studio-card--failed .studio-progress-fill { background: var(--danger, #b5453c); }
.studio-progress--live .studio-progress-fill { background-image: linear-gradient(115deg, transparent 0 25%, color-mix(in srgb, #fff 30%, transparent) 25% 50%, transparent 50% 75%, color-mix(in srgb, #fff 30%, transparent) 75% 100%); background-size: 28px 28px; animation: studio-progress-flow 900ms linear infinite; }
.studio-progress-legend { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--ink-2); }
.studio-leader-note { display: flex; gap: var(--space-2); align-items: baseline; font-size: var(--text-sm); }
.studio-leader-note code { font-weight: 700; }
.studio-team { display: grid; grid-template-columns: auto 1fr; gap: var(--space-3); align-items: start; }
.studio-leader { display: grid; justify-items: center; gap: 2px; font-size: var(--text-xs); }
.studio-members { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.studio-member { display: grid; justify-items: center; gap: 2px; max-width: 88px; text-align: center; font-size: var(--text-xs); }
.studio-gates { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.studio-gate { padding: 1px var(--space-2); border: 1px solid var(--line-strong); border-radius: var(--radius-1); font-size: var(--text-xs); }

@keyframes studio-progress-flow { to { background-position: 28px 0; } }

@media (prefers-reduced-motion: reduce) {
  .studio-progress--live .studio-progress-fill { animation: none; }
  .studio-progress-fill { transition: none; }
}
```

Before writing, grep `styles.css` for the real status color token names (`--ok`, `--warn`, `--danger`, or whatever the project uses — the `stamp`/`inline-error` rules will reveal them) and replace the fallbacks with the actual tokens. Confirm `--shadow-paper-small`, `--paper-sunken`, `--ink-3` exist (they're used elsewhere).

- [ ] **Step 6: Run the studio tests to verify they pass**

Run: `npx vitest run client/src/OfficePage.test.tsx`
Expected: PASS — `.studio-card` renders, `.studio-progress-fill` width is `75%`, `/progress` was fetched for `inv-team-1`, `Round 2` present.

- [ ] **Step 7: Commit**

```bash
git add client/src/OfficePage.tsx client/src/OfficePage.test.tsx client/src/types.ts client/src/styles.css
git commit -m "feat: add animated supervisor studio board to the office floor"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all suites PASS (backend `tests/*.test.ts` and client `client/src/*.test.tsx`).

- [ ] **Step 2: Type-check + build**

Run: `npm run build`
Expected: builds with no type errors.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Start the workbench, open 协作编排 (should land on the supervisor sub-tab), open 运行卷宗 (type/project filters + tags present), trigger a supervisor run and watch 员工大厅 render a studio card with an animated bar.

- [ ] **Step 4: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "chore: verification fixups for workbench UX refinements"
```

---

## Self-Review

**Spec coverage:**
- Change 1 (default supervisor tab) → Task 1. ✓
- Change 2 (run dossier: single vs supervisor vs graph, project dimension, filters + tags; backend join per chosen data source) → Tasks 2 (backend), 3 (type), 4 (frontend). ✓
- Change 3 (员工大厅 studio board: overall progress, current round, leader + members, gates, poll `/progress`, animated progress bar with smooth fill + live flow + reduced-motion) → Tasks 5 (helpers), 6 (UI + animation). ✓
- Out-of-scope items (immutable run.json, no new routes, supervisor authoring untouched) respected — enrichment is response-only; studio is additive to the existing office page. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The two "inspect the real token names / SelectControl interaction" notes are guardrails around verified-but-project-specific names, with safe fallbacks provided — not deferred work.

**Type consistency:** `category` values (`single`/`graph`/`supervisor`) match across Task 2 (backend), Task 3 (type), Task 4 (`filterRuns`, `CATEGORY_LABELS`). `completionRatio`/`progressTone`/`activeSupervisorInvocations` signatures in Task 5 match their use in Task 6. `InvocationProgress` fields used in Task 6's JSX (`round`, `tally`, `leaderReport.entries[].{round,action,summary,assignments}`, `gates`) match the interface added in Task 6 Step 3 and the server type in `invocationProgress.ts`.
