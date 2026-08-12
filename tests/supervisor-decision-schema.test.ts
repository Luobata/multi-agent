import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  supervisorValidationCheckGroups,
  supervisorValidationShardIssues
} from "../src/architectures/supervisor.js";
import { supervisorDecisionSchema } from "../src/workbench/materialize.js";

/**
 * Regression guard: the supervisor decision schema must be a single root object.
 * A root-level `oneOf`/`anyOf` is rejected by structured-output providers (e.g. claude-relay)
 * with an HTTP 400 before any tokens are processed, which crashed the supervisor node while a
 * direct employee invoke — using a plain-object schema — kept working.
 */
describe("supervisorDecisionSchema", () => {
  const roleIds = ["frontend-developer", "backend-developer", "test-engineer"];

  it("is a single root object with an action discriminator, never a root-level union", () => {
    const schema = supervisorDecisionSchema(roleIds, [], 3) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    const properties = schema.properties as { action: { enum?: string[] } };
    expect(properties.action.enum).toEqual(["plan-todos", "delegate", "request-human-decision", "finish"]);
  });

  it("includes satisfy-gate in the action enum and a gateId only when gates exist", () => {
    const withGates = supervisorDecisionSchema(roleIds, ["audit"], 3) as Record<string, unknown>;
    const properties = withGates.properties as { action: { enum?: string[] }; gateId: { enum?: string[] } };
    expect(properties.action.enum).toEqual(["plan-todos", "delegate", "request-human-decision", "satisfy-gate", "finish"]);
    expect(properties.gateId.enum).toEqual(["audit"]);
  });

  it("accepts TODO planning, delegate, satisfy-gate, and finish payloads and rejects an unknown action", () => {
    const schema = supervisorDecisionSchema(roleIds, ["audit"], 2);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

    expect(validate({
      action: "plan-todos",
      summary: "Split the change.",
      impact: {
        level: "low",
        regressionScope: "targeted",
        affectedAreas: ["src/local.ts"],
        reasons: ["local contract"],
        requiredChecks: ["focused test"]
      },
      todos: [
        { id: "implement", roleId: "frontend-developer", task: "Implement", needs: [], workKind: "code", sessionKey: "frontend-lane" },
        { id: "verify", roleId: "test-engineer", task: "Verify", needs: ["implement"], workKind: "test" }
      ]
    })).toBe(true);
    expect(validate({ action: "delegate", assignments: [{ roleId: "frontend-developer", task: "build UI" }] })).toBe(true);
    expect(validate({
      action: "request-human-decision",
      riskCategory: "dependency-install",
      summary: "Install a native dependency",
      assignments: [{ roleId: "backend-developer", task: "Install it" }]
    })).toBe(true);
    expect(validate({ action: "satisfy-gate", gateId: "audit", summary: "audited", evidence: {} })).toBe(true);
    expect(validate({ action: "finish", summary: "done", result: { delivered: true } })).toBe(true);
    expect(validate({ action: "wander-off" })).toBe(false);
  });

  it("constrains delegate assignment roleId to the declared roles unless in DAG mode", () => {
    const schema = supervisorDecisionSchema(roleIds, [], 2);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate({ action: "delegate", assignments: [{ roleId: "ghost-role", task: "x" }] })).toBe(false);

    const dagSchema = supervisorDecisionSchema(roleIds, [], 2, ["frontend-build"]);
    const validateDag = new Ajv({ allErrors: true, strict: false }).compile(dagSchema);
    const dagActions = (dagSchema.properties as { action: { enum: string[] } }).action.enum;
    expect(dagActions).not.toContain("plan-todos");
    // In DAG mode a delegate assignment names a nodeId + free-form roleId.
    expect(validateDag({ action: "delegate", assignments: [{ nodeId: "frontend-build", roleId: "frontend-developer" }] })).toBe(true);
  });

  it("rejects action payloads missing their required fields so the runtime repair path fires", () => {
    const schema = supervisorDecisionSchema(roleIds, ["audit"], 2);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    // finish without summary/result — the exact malformed shape the repair test relies on.
    expect(validate({ action: "finish" })).toBe(false);
    expect(validate({ action: "plan-todos", summary: "missing impact and todos" })).toBe(false);
    expect(validate({ action: "delegate" })).toBe(false);
    expect(validate({ action: "request-human-decision", summary: "missing risk and assignments" })).toBe(false);
    expect(validate({ action: "satisfy-gate", gateId: "audit" })).toBe(false);
  });
});

describe("supervisorValidationShardIssues", () => {
  const broadImpact = {
    level: "medium" as const,
    regressionScope: "package" as const,
    affectedAreas: ["shared component", "six routes", "offline state", "keyboard behavior"],
    reasons: ["shared package behavior"],
    requiredChecks: ["component test", "browser path", "keyboard path", "offline path", "package build"]
  };

  it("rejects one oversized test Work Instance so the leader must repair the TODO plan", () => {
    expect(supervisorValidationShardIssues(broadImpact, [
      { id: "implement", roleId: "engineer", task: "Implement the shared change.", needs: [], workKind: "code" },
      { id: "test-all", roleId: "tester", task: "Test every route and state.", needs: ["implement"], workKind: "test" }
    ])).toEqual([
      expect.stringContaining("groups sized from the actual check list")
    ]);
  });

  it("accepts explicit validation shards and preserves Gate-only plans", () => {
    expect(supervisorValidationShardIssues(broadImpact, [
      { id: "implement", roleId: "engineer", task: "Implement the shared change.", needs: [], workKind: "code" },
      { id: "test-browser", roleId: "tester", task: "Test the main browser path.", needs: ["implement"], workKind: "test" },
      { id: "test-offline", roleId: "tester", task: "Test offline and build behavior.", needs: ["implement"], workKind: "test" }
    ])).toEqual([]);
    expect(supervisorValidationShardIssues(broadImpact, [
      { id: "implement", roleId: "engineer", task: "Implement and leave validation to configured Gates.", needs: [], workKind: "code" }
    ])).toEqual([]);
  });
});

describe("supervisorValidationCheckGroups", () => {
  const impact = (requiredChecks: string[], validationGroups?: Array<{ id: string; requiredChecks: string[] }>) => ({
    level: "high" as const,
    regressionScope: "full" as const,
    affectedAreas: ["workspace"],
    reasons: ["cross-package change"],
    requiredChecks,
    ...(validationGroups ? { validationGroups } : {})
  });

  it("derives as many bounded groups as the checklist needs instead of capping the total at three", () => {
    const requiredChecks = Array.from({ length: 10 }, (_, index) => `check-${index + 1}`);
    expect(supervisorValidationCheckGroups(impact(requiredChecks))).toEqual([
      { id: "auto-1", requiredChecks: requiredChecks.slice(0, 2) },
      { id: "auto-2", requiredChecks: requiredChecks.slice(2, 4) },
      { id: "auto-3", requiredChecks: requiredChecks.slice(4, 6) },
      { id: "auto-4", requiredChecks: requiredChecks.slice(6, 8) },
      { id: "auto-5", requiredChecks: requiredChecks.slice(8, 10) }
    ]);
  });

  it("prefers semantic groups chosen by the leader when they cover every check exactly once", () => {
    const requiredChecks = ["unit-a", "unit-b", "browser-main", "browser-failure", "build"];
    const validationGroups = [
      { id: "unit", requiredChecks: ["unit-a", "unit-b"] },
      { id: "browser", requiredChecks: ["browser-main", "browser-failure"] },
      { id: "build", requiredChecks: ["build"] }
    ];
    expect(supervisorValidationCheckGroups(impact(requiredChecks, validationGroups))).toEqual(validationGroups);
  });

  it("falls back to dynamic grouping when a leader group misses or duplicates a required check", () => {
    const requiredChecks = ["unit-a", "unit-b", "browser-main", "build"];
    expect(supervisorValidationCheckGroups(impact(requiredChecks, [
      { id: "unit", requiredChecks: ["unit-a", "unit-b"] },
      { id: "incomplete", requiredChecks: ["unit-b", "browser-main"] }
    ]))).toEqual([
      { id: "auto-1", requiredChecks: ["unit-a", "unit-b"] },
      { id: "auto-2", requiredChecks: ["browser-main", "build"] }
    ]);
  });
});
