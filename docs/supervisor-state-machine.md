# Supervisor runtime state machine

This document records the executable contract of the existing `supervisor` Architecture Adapter.
It is intentionally product-neutral: workflow roles remain manifest data, Skills remain reusable
capabilities, and MCP remains an adapter boundary.

## Sources of truth

| Concern | Authoritative source | Projection only |
| --- | --- | --- |
| Workflow and DAG | Materialized `plan.json` | Canvas and topology UI |
| Node execution | `run.json.nodes` plus attempt evidence | Work Instance cards |
| Supervisor live state | `run.json.architectureState` | `/progress` and `/progress/wait` |
| Safe restart point | `supervisor-state.json` Run artifact | Live DAG status |
| Human approval | Durable Human Decision Request | Run control bar |
| Gate evidence | Gate nodes and `gate-governance.json` | Gate badges |
| Candidate impact | Candidate snapshot plus runtime impact manifest | Leader-authored impact text |

The live projection is updated during a round. The resume checkpoint advances only immediately
before a Supervisor decision node is scheduled. A crash therefore replays at most the current
round with stable node IDs; durable terminal nodes are reused by the Runner.

## Run states and owner actions

| State | Runtime may do | Owner may do | Exit |
| --- | --- | --- | --- |
| `queued` | Materialize pinned execution inputs | Cancel | Start or cancel |
| `running` | Decide, delegate, validate Gates, persist evidence | Monitor or cancel | Complete, block, fail, request a decision |
| `awaiting-human-decision` | No proposed high-risk worker may start | Approve, reject, or cancel | Resume the same Run or replan |
| `cancellation-requested` | Fence new starts and late Provider results | Monitor | `cancelled` |
| `blocked` / `failed` | No automatic mutation | Inspect root cause and start an authorized follow-up | New Invocation |
| `completed` | No further execution | Accept, merge, keep, discard, or open evidence | Delivery lifecycle |

Terminal Runs are immutable evidence. Follow-up work creates a new Invocation instead of rewriting
the old result.

## DAG node states

`pending` is dispatchable only when the shared readiness predicate proves every declared dependency.
`running` has a live owner. `passed`, `blocked`, `failed`, and `skipped` are terminal executions.
A passed validation can become ready for revalidation when fresh dependency or candidate evidence
exists. A blocked or failed node is never projected ready merely because it has no dependencies;
the Supervisor must first prove explicit recovery evidence.

Every non-ready pending node exposes structured `whyNotRunning` dependency evidence. Terminal
blocked/failed nodes expose a terminal recovery reason. This projection is explanatory and does not
grant dispatch authority.

## Scheduling and parallelism

The currently pinned scheduler is:

- `mode: iterative`
- `schedulerVersion: 1`
- `compiledDispatchEnabled: false`

The runtime publishes `shadowReadyNodeIds` to compare a deterministic ready set with the leader's
decision, but only the validated leader decision can dispatch. Independent read/test/audit nodes
may run concurrently up to policy and runtime-resource limits. `code` and `integration` nodes that
share a physical checkout/worktree acquire one `workspace-mutation:<path>` lease and execute
serially. A `changeSet` label is never treated as physical isolation.

Completion-driven compiled dispatch remains disabled until it has durable dispatch/reservation
reconciliation, stable Gate activation IDs, cancellation fencing, a deterministic human-risk
barrier, and differential crash tests. Disabling future compiled admission must affect new Runs
only; an active Run must keep its pinned scheduler version or stop at a durable barrier.

## Impact and Gate rules

The leader may widen impact but cannot narrow the deterministic runtime floor. Before a quality
Gate, the runtime reconciles declared impact with the candidate workspace snapshot:

- missing candidate evidence fails closed to high/full;
- repository-wide boundary files force high/full;
- an actual diff not covered by declared impacted paths widens to at least medium/package;
- supported package checks are added for the widened scope;
- the manifest records that dependency closure is not yet proven.

Gate shards may be reused only for the same candidate identity and revision. Exact path
non-overlap is not dependency-closure proof, so cross-candidate reuse is disabled.

## Restart invariant

`supervisor-state.json` contains the state at the start of a safe round: round and delegation
counters, accepted dynamic TODOs, DAG trackers, Gate activation/pass sets, member Sessions,
delegation evidence, impact, and remaining duration. Recovery validates the checkpoint against the
pinned workflow before using it. Unknown schemas, mismatched DAG/Gates, or malformed counters fail
closed before a Provider call.

The separate live projection may be newer than the resume checkpoint. On recovery the current
round is replayed from the safe checkpoint; persisted terminal node results are reused, so the
round transition is applied once without resetting policy limits.

## Verification contract

Any change to readiness, persistence, Gate reuse, impact, resource leases, human decisions, or
scheduling must add current-run tests. Handoff requires `npm run check`; UI changes additionally
require desktop/mobile evidence or an equivalent isolated E2E path. Service code changes require a
daemon restart and health/progress smoke test before owner handoff.
