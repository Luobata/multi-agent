import type { JsonValue } from "../core/types.js";

export interface GateLike {
  id: string;
  requiredCapability: string;
  validatorId?: string;
}

export interface GateValidationResult {
  passed: boolean;
  reason?: string;
}

export type GateValidator = (gate: GateLike, output: JsonValue) => GateValidationResult;

const REAL_E2E_METHODS = new Set(["browser", "http-behavior", "automation-run"]);

function asObject(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

const e2eEvidenceValidator: GateValidator = (_gate, output) => {
  const evidence = asObject(output)?.e2eEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { passed: false, reason: "此门禁要求至少一条真实 e2e 证据；仅静态检查（读源码/类型/lint）不被接受" };
  }
  for (const entry of evidence) {
    const method = asObject(entry as JsonValue)?.method;
    if (typeof method !== "string" || !REAL_E2E_METHODS.has(method)) {
      return { passed: false, reason: `e2e 证据的 method 必须是 ${[...REAL_E2E_METHODS].join(" / ")} 之一` };
    }
  }
  return { passed: true };
};

export const GATE_VALIDATORS: Record<string, GateValidator> = {
  "e2e-evidence": e2eEvidenceValidator
};

const VALIDATOR_DESCRIPTIONS: Record<string, string> = {
  "e2e-evidence": "校验执行者输出携带至少一条真实 e2e 证据（浏览器 / 服务响应 / 自动化用例），拒绝仅静态检查"
};

const CAPABILITY_DEFAULT_VALIDATOR: Record<string, string> = {
  "quality.test": "e2e-evidence"
};

export function resolveGateValidator(gate: GateLike): GateValidator | undefined {
  const id = gate.validatorId ?? CAPABILITY_DEFAULT_VALIDATOR[gate.requiredCapability];
  if (!id || id === "none") return undefined;
  if (!Object.prototype.hasOwnProperty.call(GATE_VALIDATORS, id)) {
    throw new Error(`gate ${gate.id} references unknown validator ${id}`);
  }
  const validator = GATE_VALIDATORS[id];
  if (!validator) throw new Error(`gate ${gate.id} references unknown validator ${id}`);
  return validator;
}

export function listGateValidators(): Array<{ id: string; description: string }> {
  return Object.keys(GATE_VALIDATORS).map((id) => ({ id, description: VALIDATOR_DESCRIPTIONS[id] ?? id }));
}
