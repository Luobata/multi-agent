# Workbench UX Refinements — Design

Date: 2026-08-06

Three related refinements to the local multi-agent Workbench UI:

1. Make the 协作编排 navigation default to its supervisor sub-tab.
2. Classify the 运行卷宗 (run dossier) by type (single task vs supervisor vs graph) and by project.
3. Upgrade 员工大厅 (office floor) into a supervisor "studio / war room" live board with an animated progress bar.

Changes 1 and 2 are self-contained. Change 3 is additive to an existing live page.

---

## Change 1 — 协作编排 defaults to the supervisor sub-tab

### Current behaviour

`client/src/WorkflowPage.tsx` renders an `orchestration-switcher` header with four sub-tabs, tracked by local state:

```ts
const [section, setSection] = useState<"entrance" | "graph" | "supervisor" | "policies">("graph");
```

The four tabs are: `开始一项工作` (entrance), `Graph 编排` (graph), `协作编排` (supervisor), `管理策略库` (policies). The default is `"graph"`, so entering the 协作编排 nav item lands on `Graph 编排`.

### Change

Flip the initial `section` to `"supervisor"`, so entering the nav item lands on the sub-tab whose label is 协作编排 (the supervisor page).

```ts
const [section, setSection] = useState<"entrance" | "graph" | "supervisor" | "policies">("supervisor");
```

No other logic changes. This is intentionally the whole change — the switcher, counts, and per-section rendering already work for any starting value.

### Test impact

`client/src/WorkflowPage.test.tsx` — any test that asserts the default landing renders the Graph page must be updated to assert the supervisor page renders by default. Tests that explicitly click into a sub-tab are unaffected.

---

## Change 2 — 运行卷宗 classification (type + project filters + colored tags)

### Goal

In the run dossier, let a user distinguish:

- **Single task** — a direct employee invocation.
- **Graph 编排** — a real authored graph workflow.
- **领队协作 (supervisor)** — a supervisor/lead-team run.

…and filter by **project**. Organization style: a single list with two filter groups plus colored tags on each card (no grouping/sub-tabs).

### Data model — how classification is derived

The immutable `run.json` on disk carries `architecture` (`"graph"` | `"supervisor"`) and `workflow` (id) but **not** `projectId`. Project and trigger source live on the correlated `InvocationRecord`:

- `InvocationRecord.runId` — join key back to a run.
- `InvocationRecord.target.kind` — `"employee"` (single task) vs `"workflow"`.
- `InvocationRecord.source.project` — project id (optional).
- `InvocationRecord.source.kind` — `workbench | http | mcp | a2a` (trigger).
- `InvocationRecord.executionSnapshot.workflow.architecture` — `graph | supervisor`.

Single-task runs also have a recognizable shape on disk: `architecture: "graph"`, workflow id `direct-<employeeId>`, a single `respond` node (`service.ts` `directWorkflow`).

### Backend — enrich `listRuns` (chosen approach)

`WorkbenchService.listRuns` (`src/workbench/service.ts`) currently reads each `artifacts/runs/*/run.json`, sorts by `createdAt`, and slices. Change: after loading the run records, correlate each against in-memory invocations (`this.snapshot().invocations`, keyed by `runId`, the pattern already used at `service.ts:1225`) and attach three derived fields to each returned summary:

- `category`: `"single" | "graph" | "supervisor"`
- `project`: `string | undefined` (from `invocation.source.project`)
- `trigger`: `"workbench" | "http" | "mcp" | "a2a" | undefined` (from `invocation.source.kind`)

Classification precedence for `category`:

1. If a matching invocation exists: `target.kind === "employee"` → `"single"`; else use `executionSnapshot.workflow.architecture` (`"supervisor"` → `"supervisor"`, otherwise `"graph"`).
2. Fallback when no invocation is found (older runs): `run.architecture === "supervisor"` → `"supervisor"`; else workflow id starts with `direct-` → `"single"`; else `"graph"`.
3. `project`/`trigger` are left `undefined` when no invocation is found.

`run.json` is never rewritten — enrichment happens only in the `listRuns` response. `getRun` (detail) is unchanged; the list already carries enough to render the detail header, and the detail pane's existing `selected.architecture` still drives its supervisor topology section.

### Frontend — `RunsPage.tsx`

- Extend the `Run` type (`client/src/types.ts`) with optional `category?: "single" | "graph" | "supervisor"`, `project?: string`, `trigger?: string`. Optional so `getRun` detail (which omits them) still type-checks.
- Add two filter controls above the list:
  - **类型**: 全部 / 单任务 / Graph 编排 / 领队协作
  - **项目**: 全部 / <each distinct project present in the loaded runs> / 无项目
- Filter the `runs` array by the active filters before rendering the list; the footer count reflects the filtered length; the empty state distinguishes "no runs" from "no runs match the filter".
- Each run card gains a colored **category tag** (single / graph / supervisor, distinct accent colors) and, when present, a **project chip**. Tag styling reuses existing `Stamp`/chip conventions in `styles.css`.
- Selection behaviour: if the currently selected run is filtered out, selection falls back to the first visible run (mirrors existing `runs[0]` fallback).

### Test impact

- `tests/workbench.test.ts` — add coverage that `listRuns` attaches `category`/`project`/`trigger`, including the no-invocation fallback path.
- A `RunsPage` filter test (new or extended) asserting the type/project filters narrow the list and the tags render.

---

## Change 3 — 员工大厅 supervisor "studio" live board

### Placement (decided)

Enhance the existing `client/src/OfficePage.tsx` (员工大厅). It is already the live floor: SSE-streamed work instances, per-employee runtime status, and an inbound dispatch board. Reuse that live plumbing — do **not** create a new page or route.

### What's missing today

The office floor shows individual employees and individual invocations, but not the "one supervisor run = one team working together" view: overall progress, current round, the leader's latest decision, and what each member is doing right now.

### New: 团队作战室 (studio) section

Add a section to the office floor that renders one **studio card** per **active supervisor invocation**. "Active supervisor invocation" =
`invocation.executionSnapshot?.workflow.architecture === "supervisor"` and `invocation.status` is not terminal (not completed/blocked/failed/cancelled).

Each studio card shows:

- **Overall progress bar** (animated — see below), computed from the `/progress` `tally` (completed vs total instances).
- **Current round**: `round` plus the leader's most recent `leaderReport` entry — its `action` (delegate / satisfy-gate / finish) and `summary`.
- **Leader centered, members around**: the supervisor employee avatar centered; the members assigned in the current round arranged around it. Each member shows its live status (工作中 / 完成 / 阻塞) and the task it was assigned (`assignments[].task`).
- **Gates**: if the run has gates, show each gate's pass/pending status.

When there are no active supervisor invocations, the section is either hidden or shows a short standby line (consistent with the existing `dispatch-empty` / `office-empty` patterns).

### Data source — poll `/progress`

The endpoint `GET /api/invocations/:id/progress` already exists (`src/daemon/server.ts:170`) and returns exactly the structured shape needed: `round`, `tally` (per-status counts), `leaderReport` (rounds, delegations, per-round `entries` with `action`/`summary`/`assignments`), `steps` (per-instance), `gates`, and `outcome`. See `src/workbench/invocationProgress.ts` (`InvocationProgress`).

- SSE (already connected in `App.tsx`) determines **which** invocations are active supervisor runs — no new stream needed.
- A new lightweight hook in `OfficePage` polls `/api/invocations/:id/progress` for each active supervisor invocation on an interval (e.g. ~2s), stopping when the invocation reaches terminal status. Only supervisor, non-terminal invocations are polled, so we never fan out `/progress` calls across all runs.
- The office already has a 1s `clock` tick for elapsed time; the progress poll is a separate, coarser interval keyed by the set of active supervisor invocation ids.

### Animated progress bar

- **Smooth fill**: the fill element's `width` uses a CSS `transition` (~400ms, existing `--ease-out` token) so each poll that raises the completion ratio glides rather than jumps. Reuse token conventions (`--dur-base`, `--ease-out`) already in `styles.css`.
- **Live "flowing" state**: while the supervisor invocation is still running (non-terminal), the bar carries a subtle moving stripe / shimmer via a new `@keyframes` (following the existing keyframes style in `styles.css`, e.g. `live-pulse`, `token-spin`), conveying active progress. On terminal status the animation stops and the bar settles to its final color: completed → success/green, blocked → amber, failed → red.
- **Reduced motion**: the flowing animation is disabled under `@media (prefers-reduced-motion: reduce)`; the smooth width transition may also be reduced. Follows the accessibility pattern already present.

### Test impact

- Unit-test the completion-ratio computation from a `tally` (pure function), including all-terminal and empty cases.
- Test that only supervisor, non-terminal invocations are selected for polling.
- A render test for the studio card (leader + members + progress + round + gates) given a mock `/progress` payload.

---

## Out of scope

- No changes to how runs are executed or persisted (`run.json` stays immutable and unchanged on disk).
- No new navigation entries or routes.
- No changes to the supervisor authoring page (the supervisor sub-tab remains the config/editor; live monitoring lives in 员工大厅).
- No historical backfill of project ids onto old runs beyond what the invocation join provides.

## Testing strategy

- Backend: extend `tests/workbench.test.ts` for `listRuns` enrichment (with-invocation and fallback paths) and any supervisor progress helper.
- Frontend: update `WorkflowPage.test.tsx` (default sub-tab), extend/add `RunsPage` filter+tag tests, add `OfficePage` studio-card and progress-ratio tests.
- Run the full `npm test` and `npm run build` before completion.
