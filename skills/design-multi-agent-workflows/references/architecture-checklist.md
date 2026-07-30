# Multi-Agent Architecture Checklist

## Role test

A Role should have all three:

- a responsibility that can be judged independently;
- an evidence source or tool profile distinct from another Role;
- a structured output that another node or human can consume.

If only the prompt wording changes, use one Role with different Node `with` values. If work is purely deterministic, use code or a tool rather than an Agent.

Define each accepted Role as a composable profile:

- structured background, responsibilities, goals, constraints, and metadata;
- reusable Skill bindings with per-role configuration;
- role-specific instructions only for behavior that does not belong in a shared Skill;
- replaceable Provider assignment, request template, output contract, and permission policy.

## Skill test

- Register a Skill when capability instructions or tool requirements are reusable across roles.
- Give configurable Skills a JSON Schema and validate every binding.
- Merge Skill tools with Role-specific tools for inspection and Provider enforcement.
- Keep identity and accountability in the Role; a Skill is a capability, not a persona.

## Architecture test

- Add an Architecture Adapter only when a pattern changes validation, plan shape, state transitions, or execution semantics.
- Require every Adapter to validate, compile, format, and execute its own plan.
- Treat fan-out/gather, critic, voting, debate, gates, and reflection as graph templates or policies when a graph already expresses them.
- Treat role-playing as Role Profiles plus Skills; treat blackboards/event buses as state or transport backends; treat MCP/A2A as protocol adapters.
- Keep only the adapters required now. A stable registry is more valuable than speculative implementations.

## Graph test

- Add an edge only when the downstream node needs upstream information.
- Keep independent reviewers in the same parallel wave.
- Add a synthesis node when disagreements must be preserved and reconciled.
- Do not let synthesis run after a technical dependency failure unless it can explicitly represent missing evidence.
- Set a bounded concurrency limit even when the graph is fully parallel.

## Contract test

- Give every Role a JSON Schema with `additionalProperties: false` where practical.
- Keep verdict fields finite and explicit.
- Distinguish domain Block from parse, timeout, permission, and Provider failures.
- Put stable identity in structured Role fields, reusable capability instructions in Skills, role-only behavior in `instructions`, and per-run context/output instructions in `requestTemplate`.
- Keep template placeholders strict so missing context fails before Provider invocation.

## Provider test

- Keep command, arguments, environment, timeout, output envelope, and sandbox flags in Provider configuration or its adapter.
- Make Role-to-Provider assignment replaceable without changing Role prompts or DAG topology.
- Use direct argv execution; avoid shell interpolation unless alias resolution is a deliberate, validated adapter.
- Preserve raw Provider output before normalization.

## Evidence test

Persist at least:

- workflow input and compiled plan;
- rendered prompt per attempt;
- stdout, stderr, and normalized output;
- attempt metadata and terminal status;
- append-only status events.

Keep temporary screenshots, scripts, and downloads inside the node attempt directory.

## Packaging test

- Core library: deterministic behavior used by more than one entrypoint.
- CLI: local authoring, CI, debugging, and one-shot runs.
- Skill: design procedure and judgment support.
- MCP: shared remote service, centralized secrets, long-running jobs, or multi-client access.
- Plugin: distribution bundle after the underlying interfaces are stable.
