# Enforced E2E Validation Constraint + Pluggable Gate Validators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "all testing must include real e2e validation, never static-only" an enforced constraint spanning the tester employee, the project role, and the gateway — via an e2e-shaped output contract + verdict, a project `quality.test` required gate, and a new pluggable gate-validator registry that closes the "gate only checks node status" hole — then surface it through the employee page, supervisor gate editor, run dossier, and a read-only validator list.

**Architecture:** Three runtime enforcement layers plus a management surface. Layer 1 (employee) and Layer 2 (project role) are data/config changes validated by existing Ajv + verdict machinery. Layer 3 is a new `gateValidators` registry wired into the supervisor gate execution so a `quality.test` gate auto-runs an `e2e-evidence` validator; failure makes the gate unpassed and (if required) drives the run `blocked` via the existing `requiredGateIssues` closure. The management surface adds a validator selector, an employee-page aid, run-dossier evidence display, and a read-only validator list.

**Tech Stack:** TypeScript, Node HTTP daemon, Ajv (already a dep), React (hand-rolled, no testing-library), Vitest + jsdom, CSS tokens in `client/src/styles.css`.

## Global Constraints

- `run.json` and run execution/persistence are unchanged; the existing gate hard-closure (`requiredGateIssues`, `src/architectures/supervisor.ts:900-904`, drives `blocked` at `supervisor.ts:1054-1067`) is reused, not modified.
- `validatorId` is added as an **optional** field everywhere (architecture config, workbench type, client type) so existing gates/workflows keep working unchanged.
- Validator rules are internal to the validator (not config-driven this version). The `e2eEvidence` `method` enum is fixed to `{browser, http-behavior, automation-run}`.
- 小关 / `gate-control-conversation` / WorkflowChangeRequest are OUT OF SCOPE this round (designed in the spec, deferred). Layer 1's conversational path reuses the existing Configuration Control `output-contract.set` operation — no new conversational mechanism is built.
- UI copy is Simplified Chinese matching existing tone.
- Backend tests use `WorkbenchService.open({ dataRoot: temporaryRoot() })` with the `mock` provider; frontend tests use the established jsdom harness (`createRoot`, `act`, `vi.stubGlobal("fetch", fetchMock)`, `IS_REACT_ACT_ENVIRONMENT = true`).
- There are THREE gate types to keep in sync when adding `validatorId`: `SupervisorGateConfig` (`src/architectures/supervisor.ts`, compiled/runtime + its Ajv schema), `SupervisorGate` (`src/workbench/types.ts`, authoring), `SupervisorGate` (`client/src/types.ts`, client). `materialize.ts:343` already spreads gates (`{ ...gate }`), so a validatorId present on the workbench gate flows to the compiled config automatically — but the architecture config Ajv schema (`additionalProperties:false`, `supervisor.ts:295`) must be widened to allow it.
- Run `npm test` and `npm run build` green before completion.

---

## File Structure

- `src/architectures/gateValidators.ts` — NEW. Registry, `GateValidator` type, `resolveGateValidator`, `e2eEvidenceValidator`, capability→validator default map.
- `src/architectures/gateValidators.test.ts` — NEW. Unit tests.
- `src/architectures/supervisor.ts` — add `validatorId?` to `SupervisorGateConfig` + config Ajv schema; fold validator into the gate passed-decision; surface the validator reason.
- `src/workbench/types.ts` — add `validatorId?` to authoring `SupervisorGate`.
- `src/workbench/supervisorFlow.ts` — carry `validatorId` through `normalizeSupervisorFlow`; reject unknown validator ids.
- `src/workbench/service.ts` — expose `listGateValidators()` (id + description) for the endpoint/bootstrap.
- `src/daemon/server.ts` — bootstrap gains `gateValidators`; (optionally a `GET /api/gate-validators`).
- `templates/workbench/xiaomixiang-tester.employee.json` — L1 constraints + outputSchema + verdict.
- Project descriptor(s) for `test-engineer` (e.g. `templates/workbench/cart-fe-workflow-review.project.yaml`) — L2 outputSchema alignment + `quality.test` required gate.
- `client/src/types.ts` — client `SupervisorGate.validatorId?`; `Bootstrap.gateValidators`.
- `client/src/SupervisorWorkflowPage.tsx` — gate editor validator `SelectControl`; include in payload; annotate flow overview.
- `client/src/EmployeePage.tsx` — "要求 e2e 证据" toggle injecting schema + verdict.
- `client/src/RunsPage.tsx` — gate validator verdict + structured `e2eEvidence` display.
- `client/src/styles.css` — minor styles for evidence/verdict display.
- Test files alongside each frontend change.

---

## Task 1: Gate validator registry (pure module)

**Files:**
- Create: `src/architectures/gateValidators.ts`
- Test: `src/architectures/gateValidators.test.ts`

**Interfaces:**
- Consumes: `JsonValue` from `../core/types.js`; a minimal gate shape `{ id: string; requiredCapability: string; validatorId?: string }` (define a local `GateLike` interface so this module does not import the full `SupervisorGateConfig`).
- Produces:
  - `interface GateValidationResult { passed: boolean; reason?: string }`
  - `type GateValidator = (gate: GateLike, output: JsonValue) => GateValidationResult`
  - `const GATE_VALIDATORS: Record<string, GateValidator>` (contains `"e2e-evidence"`)
  - `resolveGateValidator(gate: GateLike): GateValidator | undefined`
  - `listGateValidators(): Array<{ id: string; description: string }>`

- [ ] **Step 1: Write the failing tests**

Create `src/architectures/gateValidators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveGateValidator, listGateValidators, GATE_VALIDATORS } from "./gateValidators.js";

const gate = (over: Partial<{ id: string; requiredCapability: string; validatorId: string }> = {}) =>
  ({ id: "g", requiredCapability: "quality.test", ...over });

describe("resolveGateValidator", () => {
  it("auto-matches quality.test to e2e-evidence", () => {
    expect(resolveGateValidator(gate())).toBe(GATE_VALIDATORS["e2e-evidence"]);
  });
  it("returns undefined for a capability with no default validator", () => {
    expect(resolveGateValidator(gate({ requiredCapability: "code.integration" }))).toBeUndefined();
  });
  it("honors an explicit validatorId override", () => {
    expect(resolveGateValidator(gate({ requiredCapability: "code.integration", validatorId: "e2e-evidence" }))).toBe(GATE_VALIDATORS["e2e-evidence"]);
  });
  it("treats 'none' as disabled", () => {
    expect(resolveGateValidator(gate({ validatorId: "none" }))).toBeUndefined();
  });
  it("throws on an unknown validatorId", () => {
    expect(() => resolveGateValidator(gate({ validatorId: "nope" }))).toThrow(/unknown validator/);
  });
});

describe("e2eEvidenceValidator", () => {
  const v = GATE_VALIDATORS["e2e-evidence"]!;
  const g = gate();
  it("fails when e2eEvidence is missing or empty", () => {
    expect(v(g, { verdict: "pass" }).passed).toBe(false);
    expect(v(g, { verdict: "pass", e2eEvidence: [] }).passed).toBe(false);
  });
  it("fails when any method is not a real behavior method", () => {
    expect(v(g, { e2eEvidence: [{ method: "static", steps: "read", observed: "x" }] }).passed).toBe(false);
  });
  it("passes with at least one real-method evidence entry", () => {
    expect(v(g, { e2eEvidence: [{ method: "browser", steps: "open page", observed: "cta works" }] }).passed).toBe(true);
  });
});

describe("listGateValidators", () => {
  it("lists e2e-evidence with a description", () => {
    const ids = listGateValidators().map((v) => v.id);
    expect(ids).toContain("e2e-evidence");
    expect(listGateValidators().find((v) => v.id === "e2e-evidence")?.description).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/architectures/gateValidators.test.ts` (module not found).

- [ ] **Step 3: Implement `src/architectures/gateValidators.ts`**

```ts
import type { JsonValue } from "../core/types.js";

export interface GateLike {
  id: string;
  requiredCapability: string;
  validatorId?: string;
}

export interface GateValidationResult {
  passed: boolean;
  reason?: string;
}

export type GateValidator = (gate: GateLike, output: JsonValue) => GateValidationResult;

const REAL_E2E_METHODS = new Set(["browser", "http-behavior", "automation-run"]);

function asObject(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

const e2eEvidenceValidator: GateValidator = (_gate, output) => {
  const evidence = asObject(output)?.e2eEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { passed: false, reason: "此门禁要求至少一条真实 e2e 证据；仅静态检查（读源码/类型/lint）不被接受" };
  }
  for (const entry of evidence) {
    const method = asObject(entry as JsonValue)?.method;
    if (typeof method !== "string" || !REAL_E2E_METHODS.has(method)) {
      return { passed: false, reason: `e2e 证据的 method 必须是 ${[...REAL_E2E_METHODS].join(" / ")} 之一` };
    }
  }
  return { passed: true };
};

export const GATE_VALIDATORS: Record<string, GateValidator> = {
  "e2e-evidence": e2eEvidenceValidator
};

const VALIDATOR_DESCRIPTIONS: Record<string, string> = {
  "e2e-evidence": "校验执行者输出携带至少一条真实 e2e 证据（浏览器 / 服务响应 / 自动化用例），拒绝仅静态检查"
};

const CAPABILITY_DEFAULT_VALIDATOR: Record<string, string> = {
  "quality.test": "e2e-evidence"
};

export function resolveGateValidator(gate: GateLike): GateValidator | undefined {
  const id = gate.validatorId ?? CAPABILITY_DEFAULT_VALIDATOR[gate.requiredCapability];
  if (!id || id === "none") return undefined;
  const validator = GATE_VALIDATORS[id];
  if (!validator) throw new Error(`gate ${gate.id} references unknown validator ${id}`);
  return validator;
}

export function listGateValidators(): Array<{ id: string; description: string }> {
  return Object.keys(GATE_VALIDATORS).map((id) => ({ id, description: VALIDATOR_DESCRIPTIONS[id] ?? id }));
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/architectures/gateValidators.test.ts`.

- [ ] **Step 5: Commit** — `git add src/architectures/gateValidators.ts src/architectures/gateValidators.test.ts && git commit -m "feat: add pluggable gate validator registry with e2e-evidence validator"`

---

## Task 2: Wire the validator into supervisor gate execution

**Files:**
- Modify: `src/architectures/supervisor.ts` (`SupervisorGateConfig` interface ~40-47; config Ajv schema ~295-309; `executeGateActivation` passed-decision ~770-786; `gateSnapshot` ~447-467)
- Test: `tests/supervisor-runtime.test.ts` (existing supervisor integration test file)

**Interfaces:**
- Consumes: `resolveGateValidator` from `./gateValidators.js`.
- Produces: gates now fail when their resolved validator rejects the executor output; the validator reason surfaces in the execution record `error` and thus the gate snapshot.

- [ ] **Step 1: Write the failing integration test**

Add to `tests/supervisor-runtime.test.ts` a test that runs a supervisor workflow with a `quality.test` required gate. Model setup on the existing tests in that file (they already build supervisor workflows + policies with the `mock` provider). The mock tester delegate returns output WITHOUT `e2eEvidence`; assert the run ends `blocked` and the gate snapshot carries the e2e reason. Then a second variant where the delegate returns valid `e2eEvidence` → gate passes / run not blocked on that gate.

Because exact mock wiring depends on the file's helpers, first read `tests/supervisor-runtime.test.ts` to reuse its workflow/policy builders and mock provider response hook. The assertion targets:
```ts
// blocked variant
expect(run.status).toBe("blocked");
const gates = (run.output as any).gates as Array<{ gateId: string; status: string; reason: string | null }>;
expect(gates.find((g) => g.gateId === "e2e")?.status).not.toBe("passed");
expect(String(gates.find((g) => g.gateId === "e2e")?.reason)).toMatch(/e2e/i);
```

If the mock provider in that file returns a fixed shape, extend its response map so the gate-executor node returns `{ e2eEvidence: [...] }` in the pass variant and omits it in the block variant (keyed by role/node). Keep both variants in one or two `it` blocks.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/supervisor-runtime.test.ts` (gate passes today regardless of evidence, so the blocked-variant assertion fails).

- [ ] **Step 3: Add `validatorId` to the config interface + Ajv schema**

In `src/architectures/supervisor.ts`, extend `SupervisorGateConfig` (~40):
```ts
interface SupervisorGateConfig {
  id: string;
  requiredCapability: string;
  mode: "after-each-delegation" | "before-completion";
  required: boolean;
  instructions: string;
  fallback: "supervisor" | "block";
  validatorId?: string;
}
```
And in `supervisorConfigSchema` gate item properties (~301-308), add:
```ts
validatorId: { type: "string", minLength: 1 },
```
(Leave `additionalProperties: false` and the `required` list unchanged — validatorId is optional.)

- [ ] **Step 4: Fold the validator into the passed decision**

Import at top of file: `import { resolveGateValidator } from "./gateValidators.js";`

In `executeGateActivation`, after the existing passed computation (~770-774), before `tracker.executions.push`:
```ts
let validatorReason: string | undefined;
if (passed) {
  const validator = resolveGateValidator(tracker.gate);
  if (validator) {
    const verdict = validator(tracker.gate, result.output ?? null);
    if (!verdict.passed) { passed = false; validatorReason = verdict.reason; }
  }
}
```
Then thread `validatorReason` into the execution record `error` (~783):
```ts
error: passed ? null : validatorReason ?? result.error ?? (executor.roleId === "supervisor" ? "supervisor fallback did not return satisfy-gate" : null)
```
And set the tracker reason when unpassed (near ~786):
```ts
else tracker.reason = validatorReason ?? `gate ${tracker.gate.id} activation ${activation.key} has not passed`;
```

The `gateSnapshot` already emits `reason` and per-execution `error`, so the reason surfaces without further change.

- [ ] **Step 5: Run to verify it passes** — `npx vitest run tests/supervisor-runtime.test.ts`.

- [ ] **Step 6: Commit** — `git add src/architectures/supervisor.ts tests/supervisor-runtime.test.ts && git commit -m "feat: enforce gate validators in supervisor gate execution"`

---

## Task 3: Carry validatorId through workbench authoring + compilation

**Files:**
- Modify: `src/workbench/types.ts` (`SupervisorGate` ~206-213)
- Modify: `src/workbench/supervisorFlow.ts` (`normalizeSupervisorFlow` gate mapping ~193-213)
- Test: `tests/workbench.test.ts`

**Interfaces:**
- Consumes: `GATE_VALIDATORS` from `../architectures/gateValidators.js` (to reject unknown ids at authoring time).
- Produces: a saved supervisor workflow persists `validatorId` on its gates; `materialize.ts:343` (`{ ...gate }`) already forwards it to the compiled config (allowed by Task 2's schema).

- [ ] **Step 1: Write the failing test**

Add to `tests/workbench.test.ts` a test that creates a supervisor workflow with a gate carrying `validatorId: "e2e-evidence"` and asserts it round-trips on read; and a test that an unknown `validatorId` is rejected on save. Reuse the file's existing supervisor-workflow creation helpers (search the file for `createSupervisorWorkflow` usage and mirror it).

```ts
// round-trip
const wf = await service.createSupervisorWorkflow(/* ...existing shape..., flow with a gate { ..., validatorId: "e2e-evidence" } */);
const gate = wf.flow.gates.find((g) => g.id === "e2e");
expect(gate?.validatorId).toBe("e2e-evidence");

// unknown id rejected
await expect(service.createSupervisorWorkflow(/* gate with validatorId: "nope" */)).rejects.toThrow(/unknown validator/);
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/workbench.test.ts -t "validator"`.

- [ ] **Step 3: Add `validatorId` to the authoring type**

`src/workbench/types.ts` `SupervisorGate` (~206):
```ts
export interface SupervisorGate {
  id: string;
  requiredCapability: string;
  mode: "after-each-delegation" | "before-completion";
  required: boolean;
  instructions: string;
  fallback: "supervisor" | "block";
  validatorId?: string;
}
```

- [ ] **Step 4: Carry + validate it in normalizeSupervisorFlow**

In `src/workbench/supervisorFlow.ts`, import the registry:
```ts
import { GATE_VALIDATORS } from "../architectures/gateValidators.js";
```
In the gate mapping (~205-212), after computing `requiredCapability`/mode/etc., handle the optional id:
```ts
let validatorId: string | undefined;
if (candidate.validatorId !== undefined && candidate.validatorId !== null) {
  const value = text(candidate.validatorId, `supervisor gate ${gateId} validatorId`);
  if (value !== "none" && !(value in GATE_VALIDATORS)) {
    throw new Error(`supervisor gate ${gateId} references unknown validator ${value}`);
  }
  validatorId = value;
}
return {
  id: gateId,
  requiredCapability,
  mode: candidate.mode,
  required: candidate.required,
  instructions: text(candidate.instructions, `supervisor gate ${gateId} instructions`),
  fallback: candidate.fallback,
  ...(validatorId ? { validatorId } : {})
};
```
Note: `SupervisorFlowInput`'s gate shape (in `src/workbench/types.ts`) may need `validatorId?: string` added to its input gate type so `candidate.validatorId` type-checks — add it there if the input type is distinct from `SupervisorGate`.

- [ ] **Step 5: Run to verify it passes** — `npx vitest run tests/workbench.test.ts -t "validator"`. Also confirm `npx tsc --noEmit -p tsconfig.json` is clean (materialize spread now forwards validatorId; compiled schema from Task 2 accepts it).

- [ ] **Step 6: Commit** — `git add src/workbench/types.ts src/workbench/supervisorFlow.ts tests/workbench.test.ts && git commit -m "feat: persist and validate gate validatorId in workbench authoring"`

---

## Task 4: Layer 1 — 小米象 employee template (constraints + e2e output contract + verdict)

**Files:**
- Modify: `templates/workbench/xiaomixiang-tester.employee.json`
- Test: `tests/workbench.test.ts`

**Interfaces:**
- Consumes: existing Ajv output validation (`src/runtime/output.ts`) + verdict machinery.
- Produces: a tester whose output must carry `e2eEvidence` and whose `verdict: "block"` blocks the run.

- [ ] **Step 1: Write the failing test**

Add to `tests/workbench.test.ts` a test that creates an employee from the 小米象 template shape (or loads the template) and invokes it via the `mock` provider:
- When the mock returns output WITHOUT `e2eEvidence` → the run fails output-schema validation (assert the run/node error mentions schema validation).
- When the mock returns `{ verdict: "block", summary: "...", e2eEvidence: [{method:"browser",...}] }` → run status is `blocked` (verdict maps block).
- When it returns `verdict: "pass"` with valid evidence → run `passed`.

Reuse the file's mock-provider response mechanism (the same one Task 2 used). Keep assertions concrete on `run.status` and the validation error text.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/workbench.test.ts -t "小米象"` (or an English test name you choose). Today's `{ message }` schema doesn't require evidence, so the "missing evidence fails" assertion fails.

- [ ] **Step 3: Edit the template**

In `templates/workbench/xiaomixiang-tester.employee.json`:
- Append to `identity.constraints`: `"任何验收必须包含真实 e2e/行为验证，禁止仅凭静态检查（读源码/类型/lint）判定通过"`.
- Append to `systemPrompt` a sentence: `严禁仅凭静态检查判定通过；每条结论必须有真实 e2e/行为证据。`
- Replace `outputSchema` with the e2e-shaped schema (verbatim from the spec §Layer 1b): required `verdict`/`summary`/`e2eEvidence`; `e2eEvidence` `minItems:1` with items requiring `method ∈ {browser,http-behavior,automation-run}`, `steps`, `observed`; optional `risks`.
- Add `verdict`: `{ "path": "/verdict", "pass": ["pass"], "block": ["block"] }`.
- Update `requestPrompt` to instruct returning `verdict/summary/e2eEvidence/risks` (it already mentions e2eCoverage; align the wording to the new fields).

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/workbench.test.ts -t "小米象"`.

- [ ] **Step 5: Commit** — `git add templates/workbench/xiaomixiang-tester.employee.json tests/workbench.test.ts && git commit -m "feat: require e2e evidence in the 小米象 tester output contract"`

---

## Task 5: Layer 2 — test-engineer project role (aligned contract + quality.test gate)

**Files:**
- Modify: the project descriptor(s) that define the `test-engineer` role and its supervisor review workflow (e.g. `templates/workbench/cart-fe-workflow-review.project.yaml`; check peers under `templates/workbench/`).
- Test: `tests/project-descriptor.test.ts` (existing) and/or `tests/workbench.test.ts`.

**Interfaces:**
- Consumes: the descriptor → role contract → materialize path; Task 2/3 validator wiring.
- Produces: the review workflow declares a `quality.test` `required` gate (validator auto-resolves to `e2e-evidence`); the test-engineer role output contract matches Layer 1.

- [ ] **Step 1: Read the current descriptor(s)** to learn the exact shape (`tests/project-descriptor.test.ts:92` maps `["test-engineer","xiaomixiang-tester"]`). Identify where role contracts and the supervisor flow/gates are declared.

- [ ] **Step 2: Write the failing test**

Add a test (project-descriptor or workbench) asserting: after loading the descriptor, the `test-engineer` role's effective output contract requires `e2eEvidence`, and the review workflow has a `required` gate with `requiredCapability: "quality.test"` (validatorId absent → auto-resolves). Assertion example:
```ts
const gate = workflow.flow.gates.find((g) => g.requiredCapability === "quality.test");
expect(gate?.required).toBe(true);
```

- [ ] **Step 3: Run to verify it fails** — targeted vitest run.

- [ ] **Step 4: Edit the descriptor(s)**

- Ensure the `test-engineer` role's `outputSchema` matches the Layer-1 e2e schema (or references the same contract).
- Add/confirm a `quality.test` gate (`required: true`, `mode: "before-completion"`) in the review workflow's flow, referenced by a gate stage between delegation-loop and delivery. Do not set `validatorId` — auto-resolution attaches `e2e-evidence`.

- [ ] **Step 5: Run to verify it passes**; also run `tests/project-descriptor.test.ts` fully to catch descriptor regressions.

- [ ] **Step 6: Commit** — `git commit -m "feat: enforce quality.test e2e gate on the test-engineer project role"`

---

## Task 6: M4 — read-only gate validator list (service + endpoint + bootstrap)

**Files:**
- Modify: `src/workbench/service.ts` (add `listGateValidators()` delegating to the registry)
- Modify: `src/daemon/server.ts` (bootstrap `gateValidators`; optional `GET /api/gate-validators`)
- Modify: `client/src/types.ts` (`Bootstrap.gateValidators?: Array<{ id: string; description: string }>`)
- Test: `tests/workbench.test.ts` and/or a daemon test

**Interfaces:**
- Consumes: `listGateValidators` from `../architectures/gateValidators.js`.
- Produces: `Bootstrap.gateValidators` for the UI's validator select (Task 7).

- [ ] **Step 1: Write the failing test** — assert `service.listGateValidators()` returns an entry with `id: "e2e-evidence"` and a non-empty description. (If adding the endpoint, assert bootstrap includes `gateValidators`.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — in `service.ts` add:
```ts
listGateValidators(): Array<{ id: string; description: string }> {
  return listGateValidators();
}
```
(import the registry function; alias to avoid the name clash, e.g. `import { listGateValidators as listRegisteredGateValidators } from "../architectures/gateValidators.js";` and call that inside). In `server.ts` bootstrap object (~148), add `gateValidators: service.listGateValidators(),`. Add `gateValidators?` to the client `Bootstrap` type and to `emptyBootstrap` in `client/src/App.tsx`.

- [ ] **Step 4: Run to verify it passes**; `npx tsc --noEmit -p tsconfig.json` and `-p client/tsconfig.json` clean.

- [ ] **Step 5: Commit** — `git commit -m "feat: expose registered gate validators via bootstrap"`

---

## Task 7: M2 — supervisor gate editor validator selector

**Files:**
- Modify: `client/src/types.ts` (client `SupervisorGate.validatorId?`)
- Modify: `client/src/SupervisorWorkflowPage.tsx` (gate draft ~74/114; gate editor rows ~388-393; flow overview ~127-129; save payload)
- Test: `client/src/SupervisorWorkflowPage.test.tsx`

**Interfaces:**
- Consumes: `Bootstrap.gateValidators` (Task 6); existing `SelectControl`.
- Produces: gates saved with `validatorId` when not "auto".

- [ ] **Step 1: Write the failing test** — extend `SupervisorWorkflowPage.test.tsx` to assert a gate row renders a validator select and that saving a workflow with a chosen validator includes `validatorId` in the PATCH/POST payload (inspect `fetchMock` call body, mirroring the existing save-assertion pattern in that file). Also assert default "自动（按能力）" sends no `validatorId`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

- `client/src/types.ts`: add `validatorId?: string` to `SupervisorGate` (~411).
- Gate draft (`SupervisorWorkflowPage.tsx:114`): carry `validatorId` when spreading gates.
- Gate editor row (~391, in the three-field grid): add a `SelectControl` labeled "证据校验" with options `[{value:"", label:"自动（按能力）", description:"quality.test 自动校验 e2e 证据"}, {value:"none", label:"不校验"}, ...data.gateValidators.map((v)=>({value:v.id,label:v.id,description:v.description}))]`, value `gate.validatorId ?? ""`, onChange setting `validatorId` (empty string → delete the field).
- Flow overview (~129): when the gate's effective validator is `e2e-evidence`, append "· 将校验 e2e 证据" to the small text.
- `buildSupervisorFlowPayload` path already spreads gates; ensure the draft→payload keeps `validatorId` (omit when empty).

- [ ] **Step 4: Run to verify it passes** — `npx vitest run client/src/SupervisorWorkflowPage.test.tsx`.

- [ ] **Step 5: Commit** — `git commit -m "feat: choose a gate evidence validator in the supervisor editor"`

---

## Task 8: M1 — EmployeePage "require e2e evidence" toggle

**Files:**
- Modify: `client/src/EmployeePage.tsx` (output-contract area; draft fields at ~72-75/122-125)
- Test: `client/src/EmployeePage.test.tsx`

**Interfaces:**
- Consumes: existing `outputSchema`/`verdict*` draft fields.
- Produces: a toggle that injects the e2e schema + prefilled verdict into those fields.

- [ ] **Step 1: Write the failing test** — extend `EmployeePage.test.tsx`: toggling "要求 e2e 证据" on sets the `outputSchema` textarea to a schema containing `e2eEvidence` and sets `verdictPath` to `/verdict`, `verdictPass` to `pass`, `verdictBlock` to `block`. Assert the textarea value includes `"e2eEvidence"` and the verdict inputs update.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — add a checkbox/switch near the outputSchema field. Define a module constant `E2E_OUTPUT_SCHEMA` (the Layer-1b schema, stringified) and on enable, `setDraft` with `outputSchema: E2E_OUTPUT_SCHEMA`, `verdictPath: "/verdict"`, `verdictPass: "pass"`, `verdictBlock: "block"`. The toggle's checked state derives from whether the current `outputSchema` already parses to a schema whose `properties.e2eEvidence` exists (best-effort; wrap parse in try/catch). Disabling the toggle does not auto-clear (avoid destroying manual edits) — document with a one-line comment. Keep raw fields as the source of truth.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run client/src/EmployeePage.test.tsx`.

- [ ] **Step 5: Commit** — `git commit -m "feat: add an e2e-evidence output-contract toggle to the employee editor"`

---

## Task 9: M3 — run dossier validator verdict + structured e2e evidence

**Files:**
- Modify: `client/src/RunsPage.tsx` (gate/node rendering)
- Modify: `client/src/styles.css` (minor)
- Test: `client/src/RunsPage.test.tsx` (created earlier this branch history; extend it)

**Interfaces:**
- Consumes: run `nodes[*].output` (may contain `e2eEvidence`) and the supervisor gate snapshot (`run.output.gates[*]` with `status`/`reason`).
- Produces: readable validator verdict + structured evidence.

- [ ] **Step 1: Write the failing test** — extend `RunsPage.test.tsx` with a mock run whose selected detail has a gate snapshot entry `{ gateId:"e2e", status:"blocked", reason:"...e2e..." }` and a node output containing `e2eEvidence: [{method,steps,observed}]`. Assert the dossier renders the gate reason text and a structured evidence block (e.g. a `.run-e2e-evidence` element with the method), not just raw JSON. (The existing `RunsPage.test.tsx` mocks `/api/runs` + `/api/runs/:id` with the `{ data }` envelope — reuse that.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — where gate snapshot / node output is rendered:
  - If a node/gate output has an array `e2eEvidence`, render each entry as `method · steps → observed` in a small structured list (`.run-e2e-evidence`) above the raw JSON.
  - For gate snapshot entries with `status !== "passed"` and a `reason`, show the reason as an inline note.
  Add minimal styles in `styles.css` following existing token conventions.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run client/src/RunsPage.test.tsx`.

- [ ] **Step 5: Commit** — `git commit -m "feat: show gate validator verdict and structured e2e evidence in the run dossier"`

---

## Task 10: Full verification

**Files:** none.

- [ ] **Step 1: Full suite** — `npm test`. Expected: all pass.
- [ ] **Step 2: Build** — `npm run build`. Expected: exit 0.
- [ ] **Step 3: Fixups if needed**, then commit.

---

## Self-Review

**Spec coverage:**
- Layer 1 (constraints + e2e outputSchema + verdict) → Task 4. ✓
- Layer 2 (test-engineer aligned contract + quality.test required gate) → Task 5. ✓
- Layer 3 (pluggable validator registry; auto-match + override + none; internal rules; failure = gate unpassed → blocked) → Task 1 (registry) + Task 2 (wiring) + Task 3 (authoring propagation). ✓
- M1 employee toggle → Task 8. M2 gate editor validator select → Task 7. M3 run dossier evidence → Task 9. M4 read-only validator list → Task 6. ✓
- Conversational: Layer 1 reuses `output-contract.set` (no build) — noted in Global Constraints; 小关/WorkflowChangeRequest deferred (out of scope). ✓

**Placeholder scan:** Tasks 2/5 intentionally say "read the existing test file first to reuse its builders/mock hook" — that is a real instruction (the mock shape is file-specific), with concrete assertion targets given, not deferred work. All new modules (Task 1) and edits (Tasks 3,4,6,7,8) carry exact code.

**Type consistency:** `validatorId?: string` optional across all three gate types (architecture `SupervisorGateConfig` + its Ajv schema in Task 2; workbench `SupervisorGate` + `SupervisorFlowInput` gate in Task 3; client `SupervisorGate` in Task 7). `resolveGateValidator`/`GATE_VALIDATORS`/`listGateValidators` names consistent across Tasks 1, 2, 3, 6. The `e2eEvidence` schema shape (required `method`/`steps`/`observed`, method enum) is identical in Task 4 (employee), Task 5 (role), Task 8 (toggle constant) — all reference the spec §Layer 1b. `"none"` sentinel handled in both `resolveGateValidator` (Task 1) and `normalizeSupervisorFlow` (Task 3).
