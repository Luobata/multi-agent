import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "../core/types.js";
import type {
  EntrancePolicyDecision,
  EntrancePolicyDefinition,
  EntrancePolicyDispatchInput,
  EntrancePolicyEvaluationInput,
  EntrancePolicyRoute,
  EntrancePolicyRouteResult,
  EntrancePolicyRule,
  EntrancePolicyRuleCondition,
  EntrancePolicySignalComparison,
  EntrancePolicySourceCondition,
  InvocationSource,
  InvocationSourceKind
} from "./types.js";

const RESOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SIGNAL_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SIGNAL_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCE_KINDS = new Set<InvocationSourceKind>(["workbench", "http", "mcp", "a2a"]);
const SOURCE_FIELDS = [
  "kind",
  "label",
  "project",
  "projectRole",
  "projectBindingVersion",
  "caller",
  "contextId",
  "taskId",
  "idempotencyKey",
  "publicationId"
] as const;

type UnknownRecord = Record<string, unknown>;

function objectValue(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as UnknownRecord;
}

function onlyKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function resourceId(value: unknown, label: string): string {
  const id = textValue(value, label);
  if (!RESOURCE_ID_PATTERN.test(id)) throw new Error(`${label} must match ${RESOURCE_ID_PATTERN.source}`);
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as UnknownRecord).every(isJsonValue);
}

function jsonObject(value: unknown, label: string): JsonObject {
  const object = objectValue(value, label);
  if (!isJsonValue(object)) throw new Error(`${label} must contain only JSON values`);
  return structuredClone(object) as JsonObject;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of non-empty strings`);
  const normalized = value.map((item, index) => textValue(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
  return normalized;
}

function normalizeInvocationSource(value: unknown, label: string): InvocationSource {
  const source = objectValue(value, label);
  onlyKeys(source, SOURCE_FIELDS, label);
  if (typeof source.kind !== "string" || !SOURCE_KINDS.has(source.kind as InvocationSourceKind)) {
    throw new Error(`${label}.kind must be one of ${[...SOURCE_KINDS].join(", ")}`);
  }
  const normalized: InvocationSource = { kind: source.kind as InvocationSourceKind };
  for (const field of SOURCE_FIELDS) {
    if (field === "kind" || field === "projectBindingVersion" || source[field] === undefined) continue;
    normalized[field] = textValue(source[field], `${label}.${field}`);
  }
  if (source.projectBindingVersion !== undefined) {
    normalized.projectBindingVersion = positiveInteger(source.projectBindingVersion, `${label}.projectBindingVersion`);
  }
  return normalized;
}

function routeValue(value: unknown, label: string): EntrancePolicyRoute {
  if (value !== "auto" && value !== "direct" && value !== "specialist" && value !== "leader") {
    throw new Error(`${label} must be one of auto, direct, specialist, leader`);
  }
  return value;
}

export function normalizeEntrancePolicyRouteResult(value: unknown, label: string): EntrancePolicyRouteResult {
  const result = objectValue(value, label);
  onlyKeys(result, ["route", "specialistKey"], label);
  const route = routeValue(result.route, `${label}.route`);
  if (route === "auto") throw new Error(`${label}.route cannot be auto`);
  if (route === "specialist") {
    return { route, specialistKey: resourceId(result.specialistKey, `${label}.specialistKey`) };
  }
  if (result.specialistKey !== undefined) throw new Error(`${label}.specialistKey is only allowed for specialist routes`);
  return { route };
}

function normalizeSourceCondition(value: unknown, label: string): EntrancePolicySourceCondition {
  const source = objectValue(value, label);
  onlyKeys(source, SOURCE_FIELDS, label);
  const normalized: EntrancePolicySourceCondition = {};
  if (source.kind !== undefined) {
    if (typeof source.kind !== "string" || !SOURCE_KINDS.has(source.kind as InvocationSourceKind)) {
      throw new Error(`${label}.kind must be one of ${[...SOURCE_KINDS].join(", ")}`);
    }
    normalized.kind = source.kind as InvocationSourceKind;
  }
  for (const field of SOURCE_FIELDS) {
    if (field === "kind" || field === "projectBindingVersion" || source[field] === undefined) continue;
    normalized[field] = textValue(source[field], `${label}.${field}`);
  }
  if (source.projectBindingVersion !== undefined) {
    normalized.projectBindingVersion = positiveInteger(source.projectBindingVersion, `${label}.projectBindingVersion`);
  }
  return normalized;
}

function normalizeSignalComparison(value: unknown, label: string): EntrancePolicySignalComparison {
  const comparison = objectValue(value, label);
  onlyKeys(comparison, ["eq", "neq", "gte", "lte", "in", "exists"], label);
  if (Object.keys(comparison).length === 0) throw new Error(`${label} must define at least one comparison`);
  const normalized: EntrancePolicySignalComparison = {};
  if (Object.hasOwn(comparison, "eq")) {
    if (!isJsonValue(comparison.eq)) throw new Error(`${label}.eq must be a JSON value`);
    normalized.eq = structuredClone(comparison.eq);
  }
  if (Object.hasOwn(comparison, "neq")) {
    if (!isJsonValue(comparison.neq)) throw new Error(`${label}.neq must be a JSON value`);
    normalized.neq = structuredClone(comparison.neq);
  }
  for (const operator of ["gte", "lte"] as const) {
    if (!Object.hasOwn(comparison, operator)) continue;
    if (typeof comparison[operator] !== "number" || !Number.isFinite(comparison[operator])) {
      throw new Error(`${label}.${operator} must be a finite number`);
    }
    normalized[operator] = comparison[operator];
  }
  if (Object.hasOwn(comparison, "in")) {
    if (!Array.isArray(comparison.in) || !comparison.in.every(isJsonValue)) {
      throw new Error(`${label}.in must be an array of JSON values`);
    }
    normalized.in = structuredClone(comparison.in);
  }
  if (Object.hasOwn(comparison, "exists")) {
    if (typeof comparison.exists !== "boolean") throw new Error(`${label}.exists must be a boolean`);
    normalized.exists = comparison.exists;
  }
  return normalized;
}

function signalPath(value: string, label: string): string {
  const path = textValue(value, label);
  const segments = path.split(".");
  if (segments.some((segment) => !SIGNAL_PATH_SEGMENT_PATTERN.test(segment) || FORBIDDEN_SIGNAL_PATH_SEGMENTS.has(segment))) {
    throw new Error(`${label} must be a safe dot-delimited signal path`);
  }
  return path;
}

export function normalizeEntrancePolicyRuleCondition(value: unknown, label: string): EntrancePolicyRuleCondition {
  const condition = objectValue(value, label);
  onlyKeys(condition, ["tagsAllOf", "tagsAnyOf", "source", "signals"], label);
  const normalized: EntrancePolicyRuleCondition = {};
  if (condition.tagsAllOf !== undefined) {
    normalized.tagsAllOf = stringList(condition.tagsAllOf, `${label}.tagsAllOf`);
    if (normalized.tagsAllOf.length === 0) throw new Error(`${label}.tagsAllOf must not be empty`);
  }
  if (condition.tagsAnyOf !== undefined) {
    normalized.tagsAnyOf = stringList(condition.tagsAnyOf, `${label}.tagsAnyOf`);
    if (normalized.tagsAnyOf.length === 0) throw new Error(`${label}.tagsAnyOf must not be empty`);
  }
  if (condition.source !== undefined) normalized.source = normalizeSourceCondition(condition.source, `${label}.source`);
  if (condition.signals !== undefined) {
    const comparisons = objectValue(condition.signals, `${label}.signals`);
    normalized.signals = Object.fromEntries(Object.entries(comparisons).map(([path, comparison]) => {
      const normalizedPath = signalPath(path, `${label}.signals path`);
      return [normalizedPath, normalizeSignalComparison(comparison, `${label}.signals.${normalizedPath}`)];
    }));
    if (Object.keys(normalized.signals).length === 0) throw new Error(`${label}.signals must not be empty`);
  }
  return normalized;
}

export function normalizeEntrancePolicyRules(value: unknown, label = "entrance policy rules"): EntrancePolicyRule[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const rule = objectValue(item, `${label}[${index}]`);
    onlyKeys(rule, ["id", "when", "result"], `${label}[${index}]`);
    const id = rule.id === undefined ? `rule-${index + 1}` : resourceId(rule.id, `${label}[${index}].id`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate rule id ${id}`);
    seen.add(id);
    return {
      id,
      when: normalizeEntrancePolicyRuleCondition(rule.when, `${label}[${index}].when`),
      result: normalizeEntrancePolicyRouteResult(rule.result, `${label}[${index}].result`)
    };
  });
}

function evaluationFields(value: UnknownRecord, fallbackSource?: InvocationSource): EntrancePolicyEvaluationInput {
  const route = routeValue(value.route, "entrance policy evaluation.route");
  const specialistKey = value.specialistKey === undefined
    ? undefined
    : resourceId(value.specialistKey, "entrance policy evaluation.specialistKey");
  if (route === "specialist" && specialistKey === undefined) {
    throw new Error("entrance policy evaluation.specialistKey is required for a specialist override");
  }
  if (route !== "specialist" && specialistKey !== undefined) {
    throw new Error("entrance policy evaluation.specialistKey is only allowed when route is specialist");
  }
  const source = value.source === undefined
    ? fallbackSource && normalizeInvocationSource(fallbackSource, "entrance policy evaluation.source")
    : normalizeInvocationSource(value.source, "entrance policy evaluation.source");
  if (!source) throw new Error("entrance policy evaluation.source is required");
  return {
    route,
    specialistKey,
    tags: value.tags === undefined ? [] : stringList(value.tags, "entrance policy evaluation.tags"),
    signals: value.signals === undefined ? {} : jsonObject(value.signals, "entrance policy evaluation.signals"),
    source
  };
}

export function parseEntrancePolicyEvaluationInput(
  value: unknown,
  fallbackSource?: InvocationSource
): EntrancePolicyEvaluationInput {
  const input = objectValue(value, "entrance policy evaluation");
  onlyKeys(input, ["route", "specialistKey", "tags", "signals", "source"], "entrance policy evaluation");
  return evaluationFields(input, fallbackSource);
}

export function parseEntrancePolicyDispatchInput(
  value: unknown,
  fallbackSource?: InvocationSource
): EntrancePolicyDispatchInput {
  const input = objectValue(value, "entrance policy dispatch");
  onlyKeys(
    input,
    ["route", "specialistKey", "tags", "signals", "source", "message", "sessionId", "candidateUrl"],
    "entrance policy dispatch"
  );
  const evaluation = evaluationFields(input, fallbackSource);
  const message = input.message === undefined ? undefined : textValue(input.message, "entrance policy dispatch.message");
  const sessionId = input.sessionId === undefined ? undefined : textValue(input.sessionId, "entrance policy dispatch.sessionId");
  const candidateUrl = input.candidateUrl === undefined ? undefined : textValue(input.candidateUrl, "entrance policy dispatch.candidateUrl");
  if (candidateUrl) {
    let parsed: URL;
    try { parsed = new URL(candidateUrl); } catch { throw new Error("entrance policy dispatch.candidateUrl must be a valid HTTP(S) URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("entrance policy dispatch.candidateUrl must be a valid HTTP(S) URL");
    }
  }
  return { ...evaluation, message, sessionId, candidateUrl };
}

function signalAtPath(signals: JsonObject, path: string): { exists: boolean; value?: JsonValue } {
  let current: JsonValue = signals;
  for (const segment of path.split(".")) {
    if ((typeof current !== "object" || current === null) || !Object.hasOwn(current, segment)) {
      return { exists: false };
    }
    current = (current as Record<string, JsonValue>)[segment] as JsonValue;
  }
  return { exists: true, value: current };
}

function signalComparisonMatches(
  actual: { exists: boolean; value?: JsonValue },
  comparison: EntrancePolicySignalComparison
): boolean {
  if (comparison.exists !== undefined && actual.exists !== comparison.exists) return false;
  if (comparison.eq !== undefined && (!actual.exists || !isDeepStrictEqual(actual.value, comparison.eq))) return false;
  if (comparison.neq !== undefined && actual.exists && isDeepStrictEqual(actual.value, comparison.neq)) return false;
  if (comparison.gte !== undefined && (
    !actual.exists || typeof actual.value !== "number" || actual.value < comparison.gte
  )) return false;
  if (comparison.lte !== undefined && (
    !actual.exists || typeof actual.value !== "number" || actual.value > comparison.lte
  )) return false;
  if (comparison.in !== undefined && (
    !actual.exists || !comparison.in.some((candidate) => isDeepStrictEqual(candidate, actual.value))
  )) return false;
  return true;
}

export function entrancePolicyRuleMatches(
  condition: EntrancePolicyRuleCondition,
  input: EntrancePolicyEvaluationInput
): boolean {
  const tags = new Set(input.tags);
  if (condition.tagsAllOf && !condition.tagsAllOf.every((tag) => tags.has(tag))) return false;
  if (condition.tagsAnyOf && !condition.tagsAnyOf.some((tag) => tags.has(tag))) return false;
  if (condition.source) {
    for (const [field, expected] of Object.entries(condition.source)) {
      if (!isDeepStrictEqual(input.source[field as keyof InvocationSource], expected)) return false;
    }
  }
  if (condition.signals) {
    for (const [path, comparison] of Object.entries(condition.signals)) {
      if (!signalComparisonMatches(signalAtPath(input.signals, path), comparison)) return false;
    }
  }
  return true;
}

export function resolveEntrancePolicyTarget(
  policy: EntrancePolicyDefinition,
  result: EntrancePolicyRouteResult
): EntrancePolicyDecision["target"] {
  if (result.route === "direct") {
    if (!policy.direct) throw new Error(`entrance policy ${policy.id} direct route is not configured`);
    return policy.direct.mode === "caller"
      ? { kind: "caller" }
      : {
          kind: "employee",
          employeeId: policy.direct.employeeId,
          employeeVersion: policy.direct.employeeVersion
        };
  }
  if (result.route === "specialist") {
    const target = policy.specialists[result.specialistKey];
    if (!target) throw new Error(`entrance policy ${policy.id} specialist ${result.specialistKey} is not configured`);
    return target;
  }
  if (!policy.leader) throw new Error(`entrance policy ${policy.id} leader route is not configured`);
  return policy.leader;
}

export function evaluateEntrancePolicyDefinition(
  policy: EntrancePolicyDefinition,
  input: EntrancePolicyEvaluationInput
): EntrancePolicyDecision {
  let result: EntrancePolicyRouteResult;
  let decidedBy: EntrancePolicyDecision["decidedBy"];
  let matchedRuleId: string | undefined;
  if (input.route !== "auto") {
    result = input.route === "specialist"
      ? { route: "specialist", specialistKey: input.specialistKey! }
      : { route: input.route };
    decidedBy = "explicit";
  } else {
    const matched = policy.rules.find((rule) => entrancePolicyRuleMatches(rule.when, input));
    if (matched) {
      result = matched.result;
      decidedBy = "rule";
      matchedRuleId = matched.id;
    } else {
      result = policy.default;
      decidedBy = "default";
    }
  }
  const target = resolveEntrancePolicyTarget(policy, result);
  const caller = target.kind === "caller";
  return {
    policyId: policy.id,
    policyVersion: policy.version,
    result,
    decidedBy,
    matchedRuleId,
    target,
    executable: !caller,
    warnings: caller ? ["direct caller route returns control without creating an Invocation or Run"] : []
  };
}
