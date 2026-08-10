# Workbench UI Functional Brief

This brief intentionally contains product constraints only. Visual direction, layout, component composition, typography, color, motion, and interaction details must be designed by the configured Codex-backed project designer.

## Product

A local-first desktop-oriented workbench for creating and operating AI employees. An Employee has a structured identity, role instructions, reusable Skill bindings, Provider, permissions, version, independent Sessions, and inspectable effective context. Employees can be called directly, assembled into a fixed Graph workflow, or bound to a dynamic Supervisor workflow. An Employee or Workflow can be published through an A2A endpoint.

## Required surfaces

1. Employee list with active/archive status, search, create, edit, clone, and archive.
2. Employee detail with identity, responsibilities, goals, constraints, prompts, Skill bindings, Provider, tools, context policy, presentation, and version.
3. Direct-call Session view with transcript, session creation/switching, request composer, result state, and Run link.
4. Context inspector separating identity, role prompt, Skill instructions/config, Session history, and latest effective system/request/combined prompt.
5. Workflow control plane with separate Graph, Supervisor, and Management Policy views. Graph authoring owns fixed nodes/dependencies; Supervisor authoring pins a manager Employee, Policy version, and member role-to-Employee versions; Policy is explicitly a reusable resource rather than an Architecture.
6. Run list with workflow, architecture, status, timestamp, nodes, artifact location, and a time-expanded dynamic topology plus final output for Supervisor runs.
7. Exchange/publication surface that publishes an Employee or Workflow and shows Agent Card plus JSON-RPC endpoint URLs.

## Behavioral constraints

- Clone excludes Sessions, secrets, and Run history by default.
- Delete is archive; history remains available.
- Employee edits create a new version.
- Sessions remain pinned to their starting Employee version.
- Supervisor Workflows remain pinned to their manager, Management Policy, and member Employee versions until explicitly revised.
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
- component inventory plus a state matrix for every interactive component; selectors and overlays must explicitly show closed/open, selected, hover, keyboard focus, disabled, empty, error, long-content, viewport-edge and clipped-ancestor cases;
- exact design tokens: colors, typography, spacing, radii, borders, shadows, motion;
- the Employee card/dossier design;
- direct-call and context-inspector interaction design;
- Graph and Supervisor authoring interaction design plus the Management Policy resource lifecycle;
- publication and safety messaging;
- empty/loading/success/blocked/error states;
- accessibility requirements;
- real-browser acceptance evidence for both closed and expanded states, including a 20+ option list, active-option auto-scroll, instant high-contrast focus, empty/all-disabled/error states, two-stage dialog Escape, keyboard navigation, focus return, overlay stacking and viewport collision handling;
- representative UI copy;
- an ASCII wireframe for the primary Employee workspace;
- implementation notes suitable for React and plain CSS.
