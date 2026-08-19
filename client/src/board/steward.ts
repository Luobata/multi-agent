import type { RequirementPriority } from "../dashboard/types";
import type { JsonValue } from "../types";

export interface AgentRequirementDraft {
  title: string;
  summary: string;
  priority: RequirementPriority;
  rawRequirement: string;
  acceptanceCriteria: string[];
}

interface RequirementStewardOutput {
  message: string;
  nextAction: "clarify" | "draft";
  draft?: AgentRequirementDraft | null;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

export function requirementStewardOutput(value: JsonValue | undefined): RequirementStewardOutput | undefined {
  const output = objectValue(value);
  if (!output || typeof output.message !== "string" || (output.nextAction !== "clarify" && output.nextAction !== "draft")) return undefined;
  const candidate = objectValue(output.draft);
  const draft = candidate
    && typeof candidate.title === "string"
    && typeof candidate.summary === "string"
    && ["low", "medium", "high"].includes(String(candidate.priority))
    && typeof candidate.rawRequirement === "string"
    && Array.isArray(candidate.acceptanceCriteria)
    && candidate.acceptanceCriteria.every((item) => typeof item === "string")
    ? {
        title: candidate.title,
        summary: candidate.summary,
        priority: candidate.priority as RequirementPriority,
        rawRequirement: candidate.rawRequirement,
        acceptanceCriteria: candidate.acceptanceCriteria as string[]
      }
    : null;
  return { message: output.message, nextAction: output.nextAction, draft };
}
