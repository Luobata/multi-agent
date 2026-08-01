import { createHash } from "node:crypto";
import type { JsonValue } from "../core/types.js";
import type {
  KnowledgeChangeOperationType,
  KnowledgeChangeRisk
} from "./types.js";

const MEDIUM_RISK = new Set<KnowledgeChangeOperationType>([
  "knowledge-base.create",
  "knowledge-base.update",
  "knowledge-base.sync",
  "knowledge-base.restore",
  "knowledge-revision.create",
  "knowledge-profile.restore"
]);

const CRITICAL_RISK = new Set<KnowledgeChangeOperationType>([
  "employee-profiles.set",
  "project-role-profiles.set"
]);

export function knowledgeChangeRisk(type: KnowledgeChangeOperationType): KnowledgeChangeRisk {
  if (MEDIUM_RISK.has(type)) return "medium";
  if (CRITICAL_RISK.has(type)) return "critical";
  return "high";
}

export function knowledgeChangePlanHash(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function knowledgeChangeIsTerminal(status: string): boolean {
  return ["applied", "rejected", "cancelled", "failed"].includes(status);
}
