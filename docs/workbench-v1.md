# Local Agent Workbench v1

## 1. Outcome

The first release turns the existing workflow kit into a local employee workbench. A user can create, edit, clone, archive, inspect, and directly invoke addressable employees; combine employees into a Graph workflow; call the same registry from MCP-capable conversations; and publish an employee or workflow through an A2A v1 facade.

The release remains local-first. The daemon binds to loopback by default, definitions are exportable JSON/YAML-shaped data, and every invocation still uses the existing validation, Architecture Adapter, Provider Adapter, and Run Store.

## 2. Product boundaries

| Layer | Responsibility | v1 implementation |
| --- | --- | --- |
| Role Profile | Stable identity and accountability | Embedded in each versioned Employee |
| Skill | Reusable capability instructions and tool declarations | Shared Workbench Skill registry |
| Employee | Addressable runnable instance | Versioned, cloneable, archivable record |
| Session | Conversation-scoped context | Append-only messages with a pinned Employee version |
| Architecture | Collaboration control flow | Existing `graph` adapter plus deterministic Graph templates |
| Provider | Model/runtime invocation | Existing command adapter plus deterministic mock adapter |
| Run Store | Immutable execution evidence | Existing filesystem artifacts, prompts, output, and events |
| MCP | Conversation-to-workbench tools | Local stdio proxy to the daemon API |
| A2A | Agent-to-agent publication | A2A v1 JSON-RPC facade for an Employee or Workflow |
| Client | Authoring and operations UI | Local React workbench served by the daemon |

A2A is not an Architecture Adapter. Graph decides how employees collaborate; A2A only exposes or reaches an independently running agentic system.

## 3. Core model

### 3.1 Employee

An Employee is the runnable, user-facing unit. Its immutable version snapshot contains:

- stable id and display name;
- structured identity: background, responsibilities, goals, constraints, metadata;
- role-specific system instructions and request instructions;
- bindings to explicit shared Skill versions and their validated configuration;
- Provider reference;
- effective permissions and context policy;
- output JSON Schema;
- presentation metadata such as accent, initials, and avatar URL.

Editing an Employee creates a new version. Existing Sessions remain pinned to the version with which they were created unless the caller explicitly starts a new Session. A pinned Employee version also pins each bound Skill version, so updating a shared Skill cannot silently change an older Session. Saving a Workflow resolves every node to an explicit Employee version; revising the Workflow is the point at which its nodes can be upgraded.

### 3.2 Clone and delete semantics

Clone copies the current Employee definition into a new id and resets version to one. It does not copy Sessions, secrets, active tasks, or run history. Context-aware branching is intentionally deferred until memory selection and redaction policies exist.

Delete is a soft archive. Archived Employees cannot receive new direct calls and cannot be added to new Workflows. Historical Sessions, Run snapshots, and Workflow versions remain readable.

### 3.3 Context layers

The context inspector presents independent layers instead of one opaque prompt:

1. Identity and role instructions.
2. Resolved Skill instructions, configuration, and tools.
3. Session message history.
4. Current request and Graph dependency results.
5. Effective system, request, and combined prompts from the latest Run.
6. Run metadata and artifact paths.

v1 stores explicit Session history but does not silently infer long-term memory. Memory extraction, approval, forgetting, and compaction are later policies.

### 3.4 Direct invocation

Direct invocation is compiled to a one-node Graph workflow. It therefore shares the same Provider invocation, retries, output validation, technical-failure handling, prompt artifacts, and status events as a multi-employee workflow. No second execution engine or `direct` Architecture Adapter is introduced.

## 4. Persistence

The daemon is the normal long-running writer for mutable Workbench state. Offline CLI mutations use the same cross-process file lock and reload the latest state before commit, so a short CLI operation cannot silently overwrite a daemon update. Running multiple daemons against one data root is still outside the v1 operating model.

```text
<data-root>/
  state.json                  # registries, versions, sessions, publications
  generated/                 # materialized manifests and prompt/schema files
  artifacts/runs/<run-id>/   # existing immutable Run Store layout
```

`state.json` is written by temporary-file rename under a bounded `state.lock`. Every Run persists the materialized plan and effective prompts, so later Employee or Skill edits do not rewrite history. The default global data root is `~/.multi-agent/workbench`; tests and development can override it with `MULTI_AGENT_DATA_DIR` or a CLI flag.

## 5. Invocation surfaces

### 5.1 Local HTTP API

The loopback daemon owns CRUD and execution:

- `/api/employees`, `/api/employees/:id`, clone, archive, context, invoke;
- `/api/skills` plus archive/restore and `/api/providers`;
- `/api/architecture-templates`, `/api/workflows`, plan, and run;
- `/api/sessions` and `/api/runs`;
- `/api/publications` and generated A2A endpoint metadata.

### 5.2 MCP

The stdio MCP server is a thin proxy to the daemon and exposes employee/workflow discovery, context inspection, invocation, and run lookup. It contains no orchestration logic. A daemon must be running so every conversation observes one shared registry and one Session store.

### 5.3 A2A

A Publication targets either one Employee or one Workflow. Its Agent Card advertises only public identity, capabilities, and skills. The internal Architecture and prompts remain opaque.

Mapping:

| Workbench | A2A |
| --- | --- |
| Publication | Agent Card / A2A server endpoint |
| Direct or Workflow Run | Task |
| Request | Message |
| Structured result | Artifact |
| Technical failure | failed Task |
| Domain Block | completed Task with a Block artifact |

The v1 facade binds to loopback without authentication. LAN/public exposure and authentication are explicit future gates and must not be enabled merely by changing an Agent Card URL.

## 6. Security and correctness rules

- Do not persist credentials in Employee, Skill, Session, Agent Card, or Run prompt files.
- Keep the daemon on `127.0.0.1` by default.
- Treat imported or remote content as untrusted input.
- Pin Employee versions in Sessions and capture effective prompts in Runs.
- Keep `blocked` separate from technical `failed`.
- Archive rather than physically delete referenced Employees.
- Do not copy Session history or credentials during a normal clone.
- Enforce actual tools and filesystem access in the Provider/sandbox; UI permission labels are not enforcement.

## 7. v1 non-goals

- Long-term autonomous memory extraction.
- LAN/public deployment and production authentication.
- Durable A2A task recovery across daemon restarts.
- Arbitrary node runtimes beyond Employee-backed Graph nodes.
- Supervisor, handoff, group-chat, or other Architecture Adapters.
- 3D offices, animated avatars, or human-like emotional state.

## 8. Acceptance criteria

1. Create an Employee with identity, prompts, Skills, Provider, and permissions.
2. Clone it without copying Sessions; archive it without destroying history.
3. Invoke it directly and inspect the exact context and prompt artifacts used.
4. Continue an Employee Session across calls and daemon restarts.
5. Build and run a Graph workflow whose nodes reference Employees.
6. Access the same employees and workflows through MCP tools.
7. Publish an Employee or Workflow and retrieve a valid A2A v1 Agent Card.
8. Invoke the publication through the A2A JSON-RPC handler and receive a Task artifact.
9. Run all bundled examples with the deterministic mock Provider.
10. Disable an Employee Skill binding without losing its configuration or pinned version.
11. Generate a workflow from a common architecture template and persist visual positions independently of `needs`.
