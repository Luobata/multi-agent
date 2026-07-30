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

## Validation

Run `npm run check` before handoff.
