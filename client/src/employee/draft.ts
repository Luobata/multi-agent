import { defaultEmployeeAccentInput } from "../components";
import type { Employee, EmployeeTemplate, JsonObject, SkillBinding } from "../types";

export interface EmployeeDraft {
  id: string;
  displayName: string;
  background: string;
  responsibilities: string;
  goals: string;
  constraints: string;
  metadata: string;
  description: string;
  systemPrompt: string;
  requestPrompt: string;
  capabilities: string;
  scopeKind: "global" | "project";
  scopeProjectId: string;
  providerId: string;
  selectedSkills: string[];
  skillConfigs: Record<string, string>;
  skillEnabled: Record<string, boolean>;
  write: "none" | "artifacts-only" | "project";
  tools: string;
  outputSchema: string;
  verdictPath: string;
  verdictPass: string;
  verdictBlock: string;
  maxAttempts: number;
  historyLimit: number;
  accent: string;
  initials: string;
  avatarUrl: string;
}

const defaultOutputSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string" } }
}, null, 2);

// Layer-1b e2e evidence output contract — identical in shape to the 小米象 tester
// template (templates/workbench/xiaomixiang-tester.employee.json `outputSchema`).
// The "要求 e2e 证据" toggle injects this so users don't hand-write the JSON Schema.
export const E2E_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "e2eEvidence", "risks"],
  properties: {
    verdict: { enum: ["pass", "block"] },
    summary: { type: "string", minLength: 1 },
    e2eEvidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["method", "steps", "observed"],
        properties: {
          method: { enum: ["browser", "http-behavior", "automation-run"] },
          steps: { type: "string", minLength: 1 },
          observed: { type: "string", minLength: 1 }
        }
      }
    },
    risks: { type: "array", items: { type: "string" } }
  }
};

// Best-effort: the toggle's checked state is derived from the raw outputSchema (the
// source of truth) — true when the current schema parses to one declaring e2eEvidence.
export function schemaRequiresE2eEvidence(outputSchema: string): boolean {
  try {
    const parsed = JSON.parse(outputSchema) as { properties?: Record<string, unknown> };
    return Boolean(parsed?.properties && "e2eEvidence" in parsed.properties);
  } catch {
    return false;
  }
}

export function bindingId(binding: SkillBinding): string {
  return typeof binding === "string" ? binding : binding.id;
}

export function bindingEnabled(binding: SkillBinding): boolean {
  return typeof binding === "string" || binding.enabled !== false;
}

export function draftFrom(employee?: Employee): EmployeeDraft {
  return {
    id: employee?.id ?? "",
    displayName: employee?.identity.displayName ?? "",
    background: employee?.identity.background ?? "",
    responsibilities: employee?.identity.responsibilities.join("\n") ?? "",
    goals: employee?.identity.goals?.join("\n") ?? "",
    constraints: employee?.identity.constraints?.join("\n") ?? "",
    metadata: JSON.stringify(employee?.identity.metadata ?? {}, null, 2),
    description: employee?.description ?? "",
    systemPrompt: employee?.systemPrompt ?? "保持证据边界，明确说明不确定性，并严格履行被分配的职责。",
    requestPrompt: employee?.requestPrompt ?? "完成当前交办事项，并按约定的结构化输出返回结果。",
    capabilities: employee?.capabilities.join(", ") ?? "",
    scopeKind: employee?.scope.kind ?? "global",
    scopeProjectId: employee?.scope.kind === "project" ? employee.scope.projectId : "",
    providerId: employee?.providerId ?? "mock",
    selectedSkills: employee?.skills.map(bindingId) ?? [],
    skillConfigs: Object.fromEntries((employee?.skills ?? []).map((binding) => [
      bindingId(binding),
      JSON.stringify(typeof binding === "string" ? {} : binding.config ?? {}, null, 2)
    ])),
    skillEnabled: Object.fromEntries((employee?.skills ?? []).map((binding) => [bindingId(binding), bindingEnabled(binding)])),
    write: employee?.permissions.write ?? "none",
    tools: employee?.permissions.tools?.join(", ") ?? "",
    outputSchema: JSON.stringify(employee?.outputSchema ?? JSON.parse(defaultOutputSchema), null, 2),
    verdictPath: employee?.verdict?.path ?? "",
    verdictPass: employee?.verdict?.pass.map(String).join(", ") ?? "",
    verdictBlock: employee?.verdict?.block.map(String).join(", ") ?? "",
    maxAttempts: employee?.maxAttempts ?? 1,
    historyLimit: employee?.contextPolicy.historyLimit ?? 20,
    accent: employee?.presentation.accent ?? defaultEmployeeAccentInput(),
    initials: employee?.presentation.initials ?? "",
    avatarUrl: employee?.presentation.avatarUrl ?? ""
  };
}

function nonemptyLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function parseObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as JsonObject;
}

function capabilityList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function draftFromTemplate(template: EmployeeTemplate): EmployeeDraft {
  const draft = draftFrom();
  const defaults = template.defaults;
  return {
    ...draft,
    background: defaults.identity.background,
    responsibilities: defaults.identity.responsibilities.join("\n"),
    goals: defaults.identity.goals?.join("\n") ?? "",
    constraints: defaults.identity.constraints?.join("\n") ?? "",
    metadata: JSON.stringify(defaults.identity.metadata ?? {}, null, 2),
    description: defaults.description ?? template.description,
    systemPrompt: defaults.systemPrompt ?? draft.systemPrompt,
    requestPrompt: defaults.requestPrompt ?? draft.requestPrompt,
    capabilities: defaults.capabilities?.join(", ") ?? "",
    scopeKind: defaults.scope?.kind ?? "global",
    scopeProjectId: defaults.scope?.kind === "project" ? defaults.scope.projectId : "",
    providerId: defaults.providerId ?? draft.providerId,
    selectedSkills: defaults.skills?.map(bindingId) ?? [],
    skillConfigs: Object.fromEntries((defaults.skills ?? []).map((binding) => [
      bindingId(binding),
      JSON.stringify(typeof binding === "string" ? {} : binding.config ?? {}, null, 2)
    ])),
    skillEnabled: Object.fromEntries((defaults.skills ?? []).map((binding) => [bindingId(binding), bindingEnabled(binding)])),
    write: defaults.permissions?.write ?? draft.write,
    tools: defaults.permissions?.tools?.join(", ") ?? "",
    outputSchema: JSON.stringify(defaults.outputSchema ?? JSON.parse(defaultOutputSchema), null, 2),
    verdictPath: defaults.verdict?.path ?? "",
    verdictPass: defaults.verdict?.pass.map(String).join(", ") ?? "",
    verdictBlock: defaults.verdict?.block.map(String).join(", ") ?? "",
    maxAttempts: defaults.maxAttempts ?? draft.maxAttempts,
    historyLimit: defaults.contextPolicy?.historyLimit ?? draft.historyLimit,
    accent: defaults.presentation?.accent ?? draft.accent,
    initials: defaults.presentation?.initials ?? "",
    avatarUrl: defaults.presentation?.avatarUrl ?? ""
  };
}

export function payloadFrom(draft: EmployeeDraft) {
  const skills = draft.selectedSkills.map((id) => ({
    id,
    config: parseObject(draft.skillConfigs[id] || "{}", `Skill ${id} 配置`),
    enabled: draft.skillEnabled[id] !== false
  }));
  return {
    id: draft.id.trim(),
    identity: {
      displayName: draft.displayName.trim(),
      background: draft.background.trim(),
      responsibilities: nonemptyLines(draft.responsibilities),
      goals: nonemptyLines(draft.goals),
      constraints: nonemptyLines(draft.constraints),
      metadata: parseObject(draft.metadata || "{}", "Identity metadata")
    },
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    requestPrompt: draft.requestPrompt.trim(),
    capabilities: capabilityList(draft.capabilities),
    skills,
    providerId: draft.providerId,
    outputSchema: parseObject(draft.outputSchema, "Output Schema"),
    verdict: draft.verdictPath.trim() ? {
      path: draft.verdictPath.trim(),
      pass: draft.verdictPass.split(",").map((value) => value.trim()).filter(Boolean),
      block: draft.verdictBlock.split(",").map((value) => value.trim()).filter(Boolean)
    } : null,
    maxAttempts: Number(draft.maxAttempts),
    permissions: { write: draft.write, tools: draft.tools.split(",").map((value) => value.trim()).filter(Boolean) },
    contextPolicy: { historyLimit: Number(draft.historyLimit) },
    presentation: {
      accent: draft.accent || undefined,
      initials: draft.initials.trim() || undefined,
      avatarUrl: draft.avatarUrl.trim() || undefined
    }
  };
}
