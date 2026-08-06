# Enforced E2E Validation Constraint + Pluggable Gate Validators — Design

Date: 2026-08-06

## Problem

The tester role 小米象 (`xiaomixiang-tester`) is meant to validate work through real behavior / e2e, never through static inspection alone. Today that requirement is **advisory only**:

- `identity.constraints`, `systemPrompt`, and the `browser-e2e-validation` skill all say "don't judge Pass from source reading" — but nothing enforces it.
- The employee `outputSchema` only requires `{ message: string }` — it carries no e2e evidence.
- The supervisor **gate** system exists and is hard (a `required` gate that does not pass drives the whole run to `blocked` via `requiredGateIssues`, `src/architectures/supervisor.ts:1054-1067`), BUT a gate counts as passed purely on the executor node's status (`passed = result.status === "passed"`, `supervisor.ts:770`). The gate never checks whether e2e was actually performed. A tester that only read source and returned "pass" sails through.

Goal: make "all testing must include real e2e validation, never static-only" an enforced constraint that spans the employee identity, the project role, and the gateway — and expose it through the system's existing management and conversational-configuration surfaces.

## Approach overview

Three enforcement layers plus a management/interaction surface:

1. **Employee identity** (小米象) — constraints + an `outputSchema` that structurally requires e2e evidence + a `verdict` mapping.
2. **Project role** (`test-engineer`) — the same output contract, plus a `quality.test` required gate in the project workflow.
3. **Pluggable gate validator registry** (new) — closes the gate hole: a `quality.test` gate auto-attaches a built-in `e2e-evidence` validator that inspects the executor's output; validator failure = gate not passed = run blocked.

Then the management surface: employee-page editing aid, supervisor gate-editor validator selection, run-dossier evidence display, and a read-only validator list. Plus the conversational path: layer 1 reuses the existing Configuration Control proposal flow; the gateway side is designed here as a new "小关" (Gate Steward) conversational proposal范式 whose **implementation is deferred**.

---

## Layer 1 — Employee identity (小米象)

File: `templates/workbench/xiaomixiang-tester.employee.json`

### 1a. Constraint (soft, intent)

Add to `identity.constraints`:

> "任何验收必须包含真实 e2e/行为验证，禁止仅凭静态检查（读源码/类型/lint）判定通过"

And a matching sentence in `systemPrompt`.

### 1b. Output contract (structural, forces evidence)

Replace the `{ message }` `outputSchema` with a schema that makes e2e evidence a required structure. This is Ajv-validated at runtime (`src/runtime/output.ts` `validateStructuredOutput`), so a tester that omits evidence fails validation:

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "summary", "e2eEvidence"],
  "properties": {
    "verdict": { "enum": ["pass", "block"] },
    "summary": { "type": "string", "minLength": 1 },
    "e2eEvidence": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["method", "steps", "observed"],
        "properties": {
          "method": { "enum": ["browser", "http-behavior", "automation-run"] },
          "steps": { "type": "string", "minLength": 1 },
          "observed": { "type": "string", "minLength": 1 }
        }
      }
    },
    "risks": { "type": "array", "items": { "type": "string" } }
  }
}
```

The `method` enum intentionally excludes static kinds. The three allowed values are: `browser` (real page behavior), `http-behavior` (real service responses), `automation-run` (executed automated tests). This set is fixed for this version; extending it is a later change.

### 1c. Verdict (turns the verdict field into run status)

Add employee-level `verdict` (already supported for non-supervisor roles, `materialize.ts:285`; validated at `service.ts:216`):

```jsonc
"verdict": { "path": "/verdict", "pass": ["pass"], "block": ["block"] }
```

Now `statusFromVerdict` (`output.ts:85`) maps `block` → run `blocked`, not just prose.

---

## Layer 2 — Project role (`test-engineer`)

Files: the project descriptor / role contract consumed by `ProjectPage` (e.g. `templates/workbench/cart-fe-workflow-review.project.yaml` and peers) and materialization (`src/workbench/materialize.ts`).

- The `test-engineer` role contract's `outputSchema` mirrors Layer 1b (materialization already prefers the role's outputSchema).
- The project's supervisor workflow declares a `quality.test` gate with `required: true`, `mode: "before-completion"`. Gate config is authored in the descriptor / supervisor page (see Layer 3 + management surface).

No UI edits are required for the project role's schema — it flows through the descriptor, matching the existing "项目只提交一张需求卡" model (`ProjectPage.tsx:383`).

---

## Layer 3 — Pluggable gate validator registry (closes the hole)

This is the core new runtime mechanism. Files: new module under `src/architectures/` (e.g. `gateValidators.ts`), wired into `src/architectures/supervisor.ts`.

### Registry & validator shape

A validator inspects a gate executor's output and returns a verdict:

```ts
export interface GateValidationResult { passed: boolean; reason?: string }

export type GateValidator = (
  gate: SupervisorGateConfig,
  executorOutput: JsonValue
) => GateValidationResult;

// keyed by validator id
export const GATE_VALIDATORS: Record<string, GateValidator> = {
  "e2e-evidence": e2eEvidenceValidator
};
```

### Binding: auto-match by capability, with explicit override

- **Default (auto):** a gate's validator is resolved from its `requiredCapability`. `quality.test` → `"e2e-evidence"`. A capability with no mapped validator resolves to none (current behavior).
- **Override:** `SupervisorGateConfig` gains an optional `validatorId?: string`. When present it wins: a specific validator id, or the sentinel `"none"` to disable validation for that gate. This is additive and optional, so existing gates keep working unchanged.

Resolution helper:

```ts
const CAPABILITY_DEFAULT_VALIDATOR: Record<string, string> = { "quality.test": "e2e-evidence" };

function resolveGateValidator(gate: SupervisorGateConfig): GateValidator | undefined {
  const id = gate.validatorId ?? CAPABILITY_DEFAULT_VALIDATOR[gate.requiredCapability];
  if (!id || id === "none") return undefined;
  const validator = GATE_VALIDATORS[id];
  if (!validator) throw new Error(`gate ${gate.id} references unknown validator ${id}`);
  return validator;
}
```

### Built-in `e2e-evidence` validator (rules internal)

The validator's rules are hardcoded (not config-driven for this version):

```ts
const REAL_METHODS = new Set(["browser", "http-behavior", "automation-run"]);

function e2eEvidenceValidator(_gate: SupervisorGateConfig, output: JsonValue): GateValidationResult {
  const obj = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, JsonValue> : undefined;
  const evidence = obj?.e2eEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { passed: false, reason: "gate requires at least one e2e evidence entry; none provided (static-only checks are not accepted)" };
  }
  for (const entry of evidence) {
    const method = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, JsonValue>).method : undefined;
    if (typeof method !== "string" || !REAL_METHODS.has(method)) {
      return { passed: false, reason: `e2e evidence method must be one of ${[...REAL_METHODS].join(", ")}` };
    }
  }
  return { passed: true };
}
```

### Wiring into gate execution

In `executeGateActivation` (`supervisor.ts` ~770), after the node runs, fold the validator into the passed decision:

```ts
let passed = result.status === "passed";
if (passed && executor.roleId === "supervisor") {
  const gateDecision = decision(result.output);
  passed = gateDecision?.action === "satisfy-gate" && gateDecision.gateId === tracker.gate.id;
}
// NEW: evidence validation
if (passed) {
  const validator = resolveGateValidator(tracker.gate);
  if (validator) {
    const verdict = validator(tracker.gate, result.output ?? null);
    if (!verdict.passed) { passed = false; validatorReason = verdict.reason; }
  }
}
```

The existing execution record already captures `status`/`error`; store `validatorReason` in the `error`/reason path so it surfaces in the gate snapshot and run dossier. A `required` gate that fails validation is unpassed, so `requiredGateIssues` (`supervisor.ts:900-904`) drives the run to `blocked` — the hard closure already exists; we only made "passed" honest.

### Config schema + validation

- `supervisorConfigSchema` (`supervisor.ts:295`) gate item gains optional `validatorId: { type: "string" }`.
- The workflow `validateSupervisorWorkflow` pass rejects an unknown `validatorId` (mirrors the unknown-gate checks around `supervisor.ts:380-412`).

---

## Management surface (this round)

### M1. Employee page — "require e2e evidence" aid

File: `client/src/EmployeePage.tsx` (already edits `constraints`, `outputSchema`, `verdict` fields — lines 58/72-75/122-125).

Add a lightweight toggle "要求 e2e 证据" in the output-contract area. When enabled it injects the Layer-1b `e2eEvidence` structure into the `outputSchema` textarea and pre-fills the `verdict` fields (`path=/verdict`, `pass=pass`, `block=block`). This spares users hand-writing error-prone JSON Schema. The toggle is a convenience over the existing raw fields; the raw JSON remains the source of truth (toggle reflects whether the current schema already matches the e2e shape).

### M2. Supervisor page — validator selection per gate

File: `client/src/SupervisorWorkflowPage.tsx` (gate editor at lines 388-393; `SupervisorGate` type in `client/src/types.ts`).

- `SupervisorGate` client type gains optional `validatorId?: string`.
- Each gate row gets a `SelectControl`: `自动（按能力）` (default, value absent) / a specific validator id / `none`. Options come from the read-only validator list (M4). The flow-overview line (`SupervisorWorkflowPage.tsx:129`) annotates "将校验 e2e 证据" when the effective validator is `e2e-evidence`.
- The save payload includes `validatorId` when not "auto".

### M3. Run dossier — validator verdict + evidence display

File: `client/src/RunsPage.tsx` (already renders supervisor topology + gate snapshot + node output).

- Gate nodes show the validator verdict: passed, or "未通过 · 缺少 e2e 证据" with the reason.
- `e2eEvidence` in a node's output renders structured (method / steps / observed) rather than only raw JSON.

### M4. Read-only validator list

Files: `src/daemon/server.ts` (+ bootstrap types in `client/src/types.ts`).

Expose the registered validator ids (id + short description) so M2's select can list them. Either add to `/api/bootstrap` or a small `GET /api/gate-validators`. Read-only.

---

## Conversational interaction

The system already has two "converse → typed proposal → human reviews item-by-item → explicit apply; chat text is never authorization" control planes:

- **Configuration Control** — edits an Employee. Semantic operations include **`output-contract.set`** with payload `{ outputSchema, verdict }` (`src/configuration/types.ts:42-45`). Held by the configuration-control conversation skill.
- **Knowledge Control** — edits knowledge via `KnowledgeChangeRequest`, held by 小知 (`knowledge-steward`).

### Layer 1 reuses Configuration Control (no new mechanism)

小米象's e2e `outputSchema` + `verdict` can be added conversationally today: the configuration steward emits an `output-contract.set` proposal; the user accepts the review item and applies it. Nothing new is needed for the employee layer's conversational path — the spec only needs to note this is the intended flow and confirm `output-contract.set` carries exactly `{ outputSchema, verdict }` (it does).

### Gateway side — 小关 (Gate Steward), design now / implement later

There is no conversational channel for workflow/gate configuration today — gates are hand-authored in the supervisor page form. Since adding a gateway is expected to be an LLM-interactive action, this spec designs (implementation deferred) a new project-internal control employee mirroring 小知:

- **Employee 小关 (Gate Steward)** — `scope: project`, project-internal control agent, cannot be invoked externally. Holds a new `gate-control-conversation` skill whose tools are read-only workflow snapshot + a `workflow_change_propose` that emits a **WorkflowChangeRequest** (add/modify a gate, set its `validatorId`, set `required`/`mode`). It may NOT directly write the workflow.
- **WorkflowChangeRequest proposal flow** — a new typed proposal analogous to `ConfigurationProposal` / `KnowledgeChangeRequest`: freezes the workflow version, lists each gate change as a review item with rationale + risk, requires per-item human accept/reject and an explicit apply. Chat text is not authorization.
- User says "给测试门禁加上 e2e 证据校验" → 小关 proposes a WorkflowChangeRequest that adds/updates the `quality.test` gate with `validatorId: "e2e-evidence"` → human reviews and applies.

This keeps gateway creation LLM-interactive and identical in safety model to the existing control planes.

**Scope split:** 小关 + `gate-control-conversation` + WorkflowChangeRequest is designed here but its implementation is a later phase. This round ships: Layers 1-3 (runtime enforcement), the management surface M1-M4, and the note that Layer 1's conversational path reuses Configuration Control as-is.

---

## Out of scope

- Extending the `method` enum beyond `{browser, http-behavior, automation-run}`.
- Config-driven per-gate evidence contracts (validator rules stay internal this version).
- Implementing 小关 / WorkflowChangeRequest (designed, deferred).
- Changing how runs are executed/persisted, or the existing gate hard-closure (`requiredGateIssues`).

## Testing strategy

- **Layer 1/2:** backend test that an employee/role output missing `e2eEvidence` fails schema validation; that `verdict: "block"` yields run `blocked`.
- **Layer 3 (unit):** `resolveGateValidator` — auto-match `quality.test`→`e2e-evidence`, explicit override, `"none"` disables, unknown id throws. `e2eEvidenceValidator` — empty/missing evidence → fail with reason; a static-ish `method` → fail; valid evidence → pass.
- **Layer 3 (integration):** supervisor run where the `quality.test` gate executor returns evidence → gate passes; returns static-only / no evidence → gate unpassed → required gate drives run `blocked`. Assert the validator reason surfaces in the gate snapshot.
- **Config schema:** unknown `validatorId` in a workflow is rejected by `validateSupervisorWorkflow`.
- **Frontend:** EmployeePage toggle injects the e2e schema + verdict; SupervisorWorkflowPage gate row renders the validator select and includes `validatorId` in the payload; RunsPage renders a validator verdict + structured e2eEvidence.
- Full `npm test` + `npm run build` green.
