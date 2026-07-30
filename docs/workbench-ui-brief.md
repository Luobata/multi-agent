# Workbench UI Functional Brief

This brief intentionally contains product constraints only. Visual direction, layout, component composition, typography, color, motion, and interaction details must be designed by the configured `claude-kimi` designer.

## Product

A local-first desktop-oriented workbench for creating and operating AI employees. An Employee has a structured identity, role instructions, reusable Skill bindings, Provider, permissions, version, independent Sessions, and inspectable effective context. Employees can be called directly or assembled into a Graph workflow. An Employee or Workflow can be published through an A2A endpoint.

## Required surfaces

1. Employee list with active/archive status, search, create, edit, clone, and archive.
2. Employee detail with identity, responsibilities, goals, constraints, prompts, Skill bindings, Provider, tools, context policy, presentation, and version.
3. Direct-call Session view with transcript, session creation/switching, request composer, result state, and Run link.
4. Context inspector separating identity, role prompt, Skill instructions/config, Session history, and latest effective system/request/combined prompt.
5. Workflow list and Graph authoring form: add Employee nodes, edit node ids, declare dependencies, set concurrency/fail-fast, preview topology, run with JSON input.
6. Run list with workflow, status, timestamp, nodes, and artifact location.
7. Exchange/publication surface that publishes an Employee or Workflow and shows Agent Card plus JSON-RPC endpoint URLs.

## Behavioral constraints

- Clone excludes Sessions, secrets, and Run history by default.
- Delete is archive; history remains available.
- Employee edits create a new version.
- Sessions remain pinned to their starting Employee version.
- Domain Block and technical failure must look and read differently.
- Effective prompt evidence is read-only.
- The daemon is loopback-only in v1, and publication UI must not imply public security.
- All primary actions must be keyboard accessible and usable without hover.
- Primary target is desktop, with a functional stacked layout at smaller widths.

## Deliverable requested from the designer

Produce a complete implementable UI specification containing:

- one clear visual concept and rationale;
- information architecture and navigation;
- desktop layout and responsive transformation;
- component inventory and states;
- exact design tokens: colors, typography, spacing, radii, borders, shadows, motion;
- the Employee card/dossier design;
- direct-call and context-inspector interaction design;
- Graph authoring interaction design;
- publication and safety messaging;
- empty/loading/success/blocked/error states;
- accessibility requirements;
- representative UI copy;
- an ASCII wireframe for the primary Employee workspace;
- implementation notes suitable for React and plain CSS.
