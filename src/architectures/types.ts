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
import type { ExecutionBudget } from "../runtime/governance.js";
import type { CandidateWorkspaceSnapshot } from "../runtime/candidateRevision.js";

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
  /** One global Run ledger shared with Provider invocation and dynamic control-flow consumption. */
  budget?: ExecutionBudget;
  scheduleNode(node: ExecutionPlanNode): Promise<void>;
  executeNode(node: ExecutionPlanNode, options?: ExecuteNodeOptions): Promise<NodeRunResult>;
  /** Optional Workbench control-plane hook. Architectures must never bypass it for gated work. */
  requestHumanDecision?(request: RuntimeHumanDecisionRequest): Promise<RuntimeHumanDecisionOutcome>;
  /** Thin RunStore boundary for architecture-owned durable governance evidence. */
  readArtifact<T = JsonValue>(relativePath: string): Promise<T | undefined>;
  writeArtifact(relativePath: string, value: unknown): Promise<void>;
  /** Deterministic execution-root facts exposed through the runtime boundary. */
  candidateSnapshot(): Promise<CandidateWorkspaceSnapshot>;
  /** Absolute execution root (resolved provider cwd) for runtime-owned working files such as member handoff notes. */
  executionRoot(): string;
  /**
   * Opt-in hard gate (default off): a sessionKey delegation attempt that leaves no member handoff
   * file is treated as incomplete (blocked). When omitted, missing handoffs are only recorded
   * (turn flag + event) and never block the Run.
   */
  requireMemberHandoff?: boolean;
  /**
   * Number of recent supervisor rounds injected verbatim into the supervisor prompt's history
   * section (supervisor architecture; default 6). Older rounds are deterministically compacted
   * to one-line summaries, except human/Gate decisions which stay verbatim regardless of age.
   */
  supervisorHistoryKeepRounds?: number;
  /**
   * Reads the durable Invocation cancellation epoch. The supervisor dispatch critical section
   * fences batches when the epoch changes between the leader decision and spawn (B3 cancel fencing).
   */
  getCancellationEpoch?: () => number | Promise<number>;
  executionPackageScripts(): Promise<Record<string, string>>;
  persist(): Promise<void>;
  emit(type: string, nodeId?: string, detail?: JsonValue): Promise<void>;
}
