import { ManifestValidationError } from "./errors.js";
import { createDefaultArchitectureRegistry } from "../architectures/registry.js";
import type { ArchitectureRegistry } from "../architectures/types.js";
import type { ExecutionPlan, LoadedManifest } from "./types.js";

export function compilePlan(
  loaded: LoadedManifest,
  workflowId: string,
  architectures: ArchitectureRegistry = createDefaultArchitectureRegistry()
): ExecutionPlan {
  const workflow = loaded.manifest.workflows[workflowId];
  if (!workflow) throw new ManifestValidationError([`workflow not found: ${workflowId}`]);
  const adapter = architectures.get(workflow.architecture);
  if (!adapter) throw new ManifestValidationError([`architecture adapter not registered: ${workflow.architecture}`]);
  return adapter.compile(loaded, workflowId);
}

export function formatPlanText(
  plan: ExecutionPlan,
  architectures: ArchitectureRegistry = createDefaultArchitectureRegistry()
): string {
  const adapter = architectures.get(plan.architecture);
  if (!adapter) throw new ManifestValidationError([`architecture adapter not registered: ${plan.architecture}`]);
  return adapter.formatText(plan);
}

export function formatPlanMermaid(
  plan: ExecutionPlan,
  architectures: ArchitectureRegistry = createDefaultArchitectureRegistry()
): string {
  const adapter = architectures.get(plan.architecture);
  if (!adapter) throw new ManifestValidationError([`architecture adapter not registered: ${plan.architecture}`]);
  return adapter.formatMermaid(plan);
}
