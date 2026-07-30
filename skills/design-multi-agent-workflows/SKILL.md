---
name: design-multi-agent-workflows
description: Design, review, and scaffold reusable multi-agent architectures with explicit provider, reusable skill, composable role profile, architecture adapter, workflow, output-contract, permission, and evidence boundaries. Use when creating a new multi-agent workflow, extracting hard-coded agents from an application, deciding whether a capability belongs in a CLI, Skill, MCP server, or plugin, classifying multi-agent patterns, or diagnosing unclear role ownership, unnecessary serialization, weak handoffs, and untraceable agent runs.
---

# Design Multi-Agent Workflows

Keep deterministic orchestration in the TypeScript core and CLI. Use this Skill to make architecture decisions and author the declarative files that the CLI validates and runs.

## Workflow

1. Inspect the task, existing agent code, prompts, persistence, and execution entrypoints. Do not modify a source project when the user asked for a separate extraction.
2. Read [architecture-checklist.md](references/architecture-checklist.md) before choosing role boundaries or packaging.
3. Classify each concern as Provider, reusable Skill, Role Profile, Architecture Adapter, Workflow/Node, Runtime Policy, or Run Store. Reject roles that are only renamed sequential steps without independent judgment or evidence.
4. Define Role identity as structured background, responsibilities, goals, constraints, and metadata. Attach reusable Skills with per-role configuration instead of copying capability instructions between roles.
5. Promote a pattern to an Architecture Adapter only when it changes control-flow state or execution semantics. Keep fan-out/gather, critic, voting, debate, gates, and similar compositions inside an existing architecture when it can express them.
6. Prefer a manifest plus instruction, request, and JSON Schema files. Keep vendor commands out of Role definitions and keep product role IDs out of runtime code.
7. Scaffold a starter with `multi-agent init <empty-directory>` when the CLI is installed. Inside this repository, use `npm run cli -- init <empty-directory>`.
8. Run `multi-agent validate`, then `multi-agent inspect role <role>`, then `multi-agent plan <workflow> --format mermaid`. Resolve every missing file, unknown reference, invalid Skill config, duplicate node, and cycle before invoking a Provider.
9. Use the mock Provider for the first end-to-end run. Inspect `run.json`, `events.jsonl`, system/request prompts, raw output, and normalized results under the run directory.
10. Add a real Provider only after the architecture and contracts are stable. Make its sandbox/tool flags enforce the effective Role/Skill tool declaration; do not claim that metadata alone is a sandbox.
11. Report the chosen shape, rejected alternatives, collaboration pattern, failure semantics, artifact layout, and next extension threshold.

## Shape Rules

- Use the core library for registries, architecture compilation/execution, output validation, and persistence.
- Use the CLI as the primary human and CI entrypoint.
- Use a Skill for architecture guidance and repeatable authoring procedures only.
- Add MCP when multiple clients need a shared long-running service, centralized credentials, or remote run resources.
- Use a Plugin later to distribute the CLI, Skill, and optional MCP adapter as one installable bundle.
- Treat MCP/A2A as protocol adapters and blackboards/event buses as state or transport backends unless they truly define the control loop.

## Required Design Properties

- Separate technical `failed` from valid domain `blocked`.
- Preserve independent raw evidence before synthesis.
- Allow parallel execution only when nodes have no information dependency.
- Let synthesis consume Block results but never silently consume failed or missing results.
- Validate every role output with JSON Schema.
- Persist prompts and raw output even when parsing or validation fails.
- Bound retries and retry technical failures only.
- Keep all temporary Agent files inside the declared artifact directory.

Do not embed a new orchestration engine in `SKILL.md`. If the CLI cannot express a required behavior, extend and test the core instead.
