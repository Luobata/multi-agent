# Runtime architecture upgrade status (U2-U7, S1-S12)

This document records implemented compatibility contracts and the remaining integration boundary. It is intentionally evidence-based: unchecked items are not implemented by type declarations or placeholders.

## Workbench user-path upgrade

- U2: the manifest CLI and registry-backed Workbench now share a versioned portable bundle contract. Employee, Project binding, Workflow, Publication, and Run-evidence modes support redacted export, checksum validation, preview-first import, deterministic conflict handling, and explicit confirmation for sensitive replacement.
- U3: CLI, HTTP, and Settings reuse one machine-readable doctor report for Node, Git, Provider declarations, data directory, project bindings, daemon binding, sandbox ownership, Run-index integrity, output-schema compatibility, and runtime security controls. Checks that require a live Provider or host proof remain warning/skipped instead of being reported as ready.
- U4: every Run can be rendered as a stable Run Receipt with status/failure category, retryability, budget, next action, and evidence links. `#runs/<run-id>?view=receipt` survives reload and degrades explicitly for legacy evidence.
- U5: Settings exposes retention estimate/preview/apply, active-Run protection, local backup with SHA-256 receipt, restore preview/apply, and backup-gated typed reset. Backup IDs are safe filenames and server-side path checks reject traversal, symlink, and overwrite hazards.
- U6: the default dashboard is task-first: continue-work priority, four-step onboarding, and direct routes precede statistics and domain-object navigation.
- U7: major pages are route-lazy-loaded and the production manifest is checked against entry, route, and CSS raw/gzip budgets on every client build.

## Implemented foundation

- S1: `SideEffectIntent` and `CapabilityBroker` authorize at the real Provider invocation boundary. Allowed, denied, approval-required, and broker technical failures remain distinct. In a Workbench Invocation, approval-required creates a durable `irreversible-other` human-decision request containing the proposed intent; Provider invocation remains at zero until approval, approval emits grant evidence, and rejection blocks the node. A runtime without a human-decision hook blocks explicitly. Runs without a broker retain legacy behavior and persist a compatibility-warning event.
- S2: `ExecutionBudget` provides wall-clock, Provider-call, attempt, gate, delegation, optional token/cost/tool, and depth counters. A Supervisor reserves the complete assignment batch before scheduling any worker, so parallel fan-out cannot partially start or oversell delegation quota. Gate quota is reserved only after replay/no-executor fast paths and immediately before execution; depth is reserved when a new Provider-backed round begins. A restored snapshot carries elapsed wall time forward.
- S3: every Run now persists `checkpoint.json` and `run-manifest.json`. Deterministic runtime boundaries atomically advance revision, lease, fencing token, the Invocation cancellation epoch, and the optional `ExecutionBudget` snapshot. Every checkpoint CAS and Provider-result commit verifies that the epoch still matches; an adapter that ignores Abort cannot commit its late output. Resume restores elapsed wall time, upgrades a legacy Run without a checkpoint, rejects corrupt snapshots, and only takes over an expired lease.
- S4: Provider adapters have optional `describe`/`preflight` contracts. The runtime persists `preflight.json` before authorization or invocation, treats adapters without the extension as legacy, and fails closed when a manifest explicitly requests an unsupported strong capability. Output object schemas are checked as closed, fully-required envelopes; legacy definitions record incompatibility, while providers requesting `strict-output-schema` fail before invocation.
- S5: software-delivery-specific assignment, Gate, worktree, E2E, regression-impact, and validation-group semantics are versioned as `software-delivery@1`; materialization records the compiled digest-bearing effective snapshot. Supervisor manifests without a ref retain the v1 compatibility default, while an explicit non-software binding does not activate delivery constraints.
- S6: dependency outputs up to 64 KiB retain the legacy inline context. Larger outputs are persisted once under `context/dependencies`, injected as digest-bearing ArtifactRefs with bounded summaries, and recorded per attempt in `context-projection.json`; corrupt or mismatched artifacts fail closed.
- S7: `RunStore.writeRun` maintains a rebuildable `artifacts/runs/index.json` while `run.json` remains authoritative. `WorkbenchService.listRuns` reads that index and rebuilds it from truth records when absent or corrupt. Workbench state snapshots reuse an mtime-keyed cache and mutations invalidate it.
- S8: Workflow Invocations persist `cancellation-requested` followed by `cancelled`, including actor/reason/epoch/request/ack timestamps. Background execution is tracked with an AbortController; HTTP, MCP, and durable A2A task mapping delegate cancellation to the same service. Terminal calls are idempotent and late runtime transitions cannot replace cancellation.
- S9: Publications persist `targetVersion` and `releaseChannel` (`locked`, `pinned`, `floating`). Every new Invocation snapshots the Publication and resolved target versions. Workflow definitions may carry a versioned/digested final-output schema; Runtime validates it after Role output validation and writes `workflow-output-validation.json`.
- S10: materialized Supervisor principals carry Employee/principal identity. Preparation rejects producer/approver staffing that resolves to the same Employee, and runtime blocks an approver that shares a forbidden Employee or Session with a producer or lacks independent producer evidence.
- S11: long-poll progress uses a persisted-state `runId:sequence` cursor and returns a bounded event envelope (source/phase/metrics/heartbeat/terminal). Legacy cursors advance to a current snapshot. MCP host contracts keep heartbeat out of model-visible/user-relayed payloads.
- S12 (loopback baseline): daemon requests enforce Host and Origin allowlists, optional capability tokens for side effects, bounded rate limiting, and a fail-closed write audit sink. Non-loopback startup rejects configurations missing TLS, authn/authz, tenant isolation, rate limiting, audit, trusted proxy, or Origin controls; this build still fails closed instead of exposing a non-loopback TLS listener.

## Compatibility contract

- Existing manifests need no new fields. Missing CapabilityBroker configuration is allowed with explicit Run evidence rather than silently granting a new permission model.
- Existing Run records remain readable because governance fields are optional and failure categories are additive.
- Graph remains the execution adapter. These controls are runtime policy and persistence primitives, not a new Architecture Adapter.
- Prompts, raw Provider output, normalized output, and status events continue to use the existing Run Store paths.

## Real-task evidence and accepted boundaries

- `tests/real-supervisor-governance.test.ts` runs `real-supervisor-s1-s12` and `real-supervisor-legacy-mock` only through `WorkbenchService`, version-pinned `Publication`, materialization, the Supervisor adapter, Provider boundary, and `RunStore`. It never calls a Supervisor internal helper.
- The governed task asserts Provider preflight ordering; allow/deny/approval-required/broker-unavailable classification; the shared Provider/attempt/delegation/gate/depth budget ledger and zero outstanding reservations; policy-pack digest; large-context projection; rebuildable index; publication pinning; SoD staffing/evidence; and Run Receipt prompt/raw/result evidence.
- The legacy task omits broker, budget, policy-pack ref, output contract, and SoD declarations, completes through the local deterministic Provider, and asserts the compatibility warning plus prompt/raw/normalized/status evidence.
- Cancellation epoch, late-result fencing, persisted progress/heartbeat, and HTTP/MCP/A2A cancellation convergence remain covered by their protocol-specific fixtures (`workflow-progress-session`, `workflow-progress-mcp`, `daemon`, and `a2a`) so the real task does not duplicate transport implementations.
- Production non-loopback TLS is intentionally not implemented. Startup performs the combined security preflight and fails closed. Loopback tests use the injectable daemon application where socket binding is unnecessary; environments that forbid `127.0.0.1` listen cannot execute the older live-listener fixtures.
- Multi-process crash injection and a production distributed lease backend remain outside this local-first Run Store boundary.

## Validation evidence

- `npm run typecheck:e2e` validates the Web E2E harness independently from product TypeScript projects.
- `npm run test:e2e:web:safe` starts the built Workbench in-process on loopback and uses Playwright without an external visual model. The synthetic journeys cover first-use/settings migration and safety controls, a real Supervisor Run Receipt deep link, and a 390×844 mobile layout; every journey records a full-page screenshot and browser/HTTP diagnostics.
- The browser run found and closed two transport regressions: canonical same-origin assets were rejected when the default Origin set was empty, and same-origin UI POSTs were unusable when no capability-token distribution path existed. The daemon now defaults to its canonical origin, continues to reject cross-origin requests, and enforces a capability token whenever one is explicitly configured.
- Final repository validation on 2026-08-13: `npm run check` passed 93 test files / 710 tests, server and client typechecking, production build, and client bundle budgets.
