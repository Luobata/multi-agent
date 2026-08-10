import type {
  ExecutionPlan,
  ExecutionPlanNode,
  JsonObject,
  JsonValue,
  LoadedManifest,
  MultiAgentManifest,
  NodeRunResult,
  RuntimeHumanDecisionOutcome,
  RuntimeHumanDecisionRequest,
  WorkflowDefinition,
  WorkflowRunStatus,
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
  execute(context: ArchitectureExecutionContext): Promise<ArchitectureExecutionResult | void>;
}

export type ArchitectureRegistry = Map<string, ArchitectureAdapter>;

export interface ArchitectureExecutionResult {
  status?: Exclude<WorkflowRunStatus, "running">;
  output?: JsonValue;
}

export interface ExecuteNodeOptions {
  /** Supervisors need to observe failed workers; Graph keeps the historical skip behavior. */
  dependencyFailure?: "skip" | "observe";
  /** Absolute runtime deadline used by bounded dynamic control loops. */
  deadlineAt?: number;
  /** Dynamic controllers may repair malformed structured decisions without restarting the whole Run. */
  retryValidation?: boolean;
}

export interface ArchitectureExecutionContext {
  loaded: LoadedManifest;
  input: JsonObject;
  plan: ExecutionPlan;
  run: WorkflowRunRecord;
  scheduleNode(node: ExecutionPlanNode): Promise<void>;
  executeNode(node: ExecutionPlanNode, options?: ExecuteNodeOptions): Promise<NodeRunResult>;
  /** Optional Workbench control-plane hook. Architectures must never bypass it for gated work. */
  requestHumanDecision?(request: RuntimeHumanDecisionRequest): Promise<RuntimeHumanDecisionOutcome>;
  persist(): Promise<void>;
  emit(type: string, nodeId?: string, detail?: JsonValue): Promise<void>;
}
