import { describe, expect, it } from "vitest";
import { resolveGateValidator, listGateValidators, GATE_VALIDATORS } from "./gateValidators.js";

const gate = (over: Partial<{ id: string; requiredCapability: string; validatorId: string }> = {}) =>
  ({ id: "g", requiredCapability: "quality.test", ...over });

describe("resolveGateValidator", () => {
  it("auto-matches quality.test to e2e-evidence", () => {
    expect(resolveGateValidator(gate())).toBe(GATE_VALIDATORS["e2e-evidence"]);
  });
  it("returns undefined for a capability with no default validator", () => {
    expect(resolveGateValidator(gate({ requiredCapability: "code.integration" }))).toBeUndefined();
  });
  it("honors an explicit validatorId override", () => {
    expect(resolveGateValidator(gate({ requiredCapability: "code.integration", validatorId: "e2e-evidence" }))).toBe(GATE_VALIDATORS["e2e-evidence"]);
  });
  it("treats 'none' as disabled", () => {
    expect(resolveGateValidator(gate({ validatorId: "none" }))).toBeUndefined();
  });
  it("throws on an unknown validatorId", () => {
    expect(() => resolveGateValidator(gate({ validatorId: "nope" }))).toThrow(/unknown validator/);
  });
  it("throws on a prototype-key validatorId (fail-closed)", () => {
    expect(() => resolveGateValidator(gate({ validatorId: "toString" }))).toThrow(/unknown validator/);
    expect(() => resolveGateValidator(gate({ validatorId: "constructor" }))).toThrow(/unknown validator/);
  });
});

describe("e2eEvidenceValidator", () => {
  const v = GATE_VALIDATORS["e2e-evidence"]!;
  const g = gate();
  it("fails when e2eEvidence is missing or empty", () => {
    expect(v(g, { verdict: "pass" }).passed).toBe(false);
    expect(v(g, { verdict: "pass", e2eEvidence: [] }).passed).toBe(false);
  });
  it("fails when any method is not a real behavior method", () => {
    expect(v(g, { e2eEvidence: [{ method: "static", steps: "read", observed: "x" }] }).passed).toBe(false);
  });
  it("passes with at least one real-method evidence entry", () => {
    expect(v(g, { e2eEvidence: [{ method: "browser", steps: "open page", observed: "cta works" }] }).passed).toBe(true);
  });
});

describe("listGateValidators", () => {
  it("lists e2e-evidence with a description", () => {
    const ids = listGateValidators().map((v) => v.id);
    expect(ids).toContain("e2e-evidence");
    expect(listGateValidators().find((v) => v.id === "e2e-evidence")?.description).toBeTruthy();
  });
});
