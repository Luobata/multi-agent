import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonObject,
  JsonValue,
  LoadedManifest,
  MultiAgentManifest,
  NodeRunResult,
  WorkflowDefinition,
  WorkflowRunRecord
} from "../core/types.js";

export interface ArchitectureValidationContext {
  manifest: MultiAgentManifest;
  workflowId: string;
  workflow: WorkflowDefinition;
}

export interface ArchitectureAdapter {
  id: string;
  validate(context: ArchitectureValidationContext): string[];
  compile(loaded: LoadedManifest, workflowId: string): ExecutionPlan;
  formatText(plan: ExecutionPlan): string;
  formatMermaid(plan: ExecutionPlan): string;
  execute(context: ArchitectureExecutionContext): Promise<void>;
}

export type ArchitectureRegistry = Map<string, ArchitectureAdapter>;

export interface ArchitectureExecutionContext {
  loaded: LoadedManifest;
  input: JsonObject;
  plan: ExecutionPlan;
  run: WorkflowRunRecord;
  executeNode(node: ExecutionPlanNode): Promise<NodeRunResult>;
  persist(): Promise<void>;
  emit(type: string, nodeId?: string, detail?: JsonValue): Promise<void>;
}
