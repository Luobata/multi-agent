# Repository guidance

## Architecture boundaries

- Keep Provider invocation, reusable Skills, Role identity, Architecture control flow, Workflow instances, and Run Store persistence as separate layers.
- Do not hard-code product roles in `src/`; roles belong in a manifest plus prompt/schema files.
- Do not put reusable capability instructions directly into every Role; register a Skill and bind it with validated configuration.
- Do not add an Architecture Adapter for a pattern that the current adapter can express as a template or policy.
- Keep the Skill thin. Deterministic validation, planning, and execution belong in the TypeScript core and CLI.
- Treat MCP as an adapter boundary, not as the workflow model.
- Persist prompts, raw provider output, normalized results, and status transitions for every run.

## Change rules

- Add tests for graph validation, template rendering, output validation, provider behavior, or persistence changes.
- Keep example workflows runnable with the local mock provider.
- Never edit `dist/` or runtime data under `.multi-agent/` directly.

## Project employee routing

- Route project work through the connected `local-agent-workbench` roles: `product-manager` → `xiaomiwang-product-manager`, `product-designer` → `lin-mo-product-designer`, `frontend-developer` → `mihuhu-frontend-engineer`, `backend-developer` → `huotuizhu-product-manager`, `fullstack-developer` → `yaoxi-programmer`, and `test-engineer` → `xiaomixiang-tester`.
- Invoke the project role instead of calling the Employee directly so the project policy, Knowledge Profiles, pinned version, and Run evidence are preserved.
- Employee identity is not a single-worker capacity limit: separate calls create isolated Work Instances and can run concurrently; only calls sharing one Session are serialized to preserve context order.
- Keep product, design, frontend, backend, full-stack integration, and independent test work in their own role boundaries; use worktree, branch, or file ownership when concurrent instances can edit overlapping code.
- Treat a missing, archived, stale, or capability-incompatible assignment as an integration or staffing gap and surface it before implementation.

## Validation

Run `npm run check` before handoff.
