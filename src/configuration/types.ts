import type {
  JsonObject,
  JsonValue,
  RoleIdentityDefinition,
  RolePermissionDefinition,
  RoleSkillBinding,
  RoleVerdictDefinition
} from "../core/types.js";

export type ConfigurationOperationRisk = "low" | "medium" | "high";

interface ConfigurationOperationBase {
  rationale: string;
  risk: ConfigurationOperationRisk;
}

export type ConfigurationOperation =
  | (ConfigurationOperationBase & {
      type: "identity-profile.set";
      payload: { identity: RoleIdentityDefinition; description: string };
    })
  | (ConfigurationOperationBase & {
      type: "prompts.set";
      payload: { systemPrompt: string; requestPrompt: string };
    })
  | (ConfigurationOperationBase & {
      type: "capabilities.set";
      payload: { capabilities: string[] };
    })
  | (ConfigurationOperationBase & {
      type: "skills.set";
      payload: { skills: RoleSkillBinding[]; skillVersions?: Record<string, number> };
    })
  | (ConfigurationOperationBase & {
      type: "runtime.set";
      payload: { providerId: string; maxAttempts: number };
    })
  | (ConfigurationOperationBase & {
      type: "permissions.set";
      payload: { permissions: RolePermissionDefinition };
    })
  | (ConfigurationOperationBase & {
      type: "output-contract.set";
      payload: { outputSchema: JsonObject; verdict?: RoleVerdictDefinition | null };
    })
  | (ConfigurationOperationBase & {
      type: "context-policy.set";
      payload: { historyLimit: number };
    })
  | (ConfigurationOperationBase & {
      type: "presentation.set";
      payload: { accent?: string; initials?: string; avatarUrl?: string };
    });

export type ConfigurationOperationType = ConfigurationOperation["type"];

export type ConfigurationProposalStatus =
  | "awaiting-review"
  | "ready-to-apply"
  | "applying"
  | "applied"
  | "needs-reapproval"
  | "cancelled"
  | "failed";

export interface ConfigurationReviewItem {
  id: string;
  operationIndex: number;
  operationType: ConfigurationOperationType;
  label: string;
  rationale: string;
  risk: ConfigurationOperationRisk;
  before: JsonValue;
  after: JsonValue;
}

export interface ConfigurationReviewDecision {
  id: string;
  reviewItemId: string;
  decision: "accepted" | "rejected";
  actor: string;
  at: string;
  comment?: string;
  planHash: string;
}

export interface ConfigurationReviewProgress {
  total: number;
  reviewed: number;
  accepted: number;
  rejected: number;
  pending: number;
}

export interface ConfigurationProposalSource {
  kind: "ai-generated";
  invocationId: string;
  projectId: string;
  projectVersion: number;
  projectRoleId: string;
  projectBindingVersion: number;
  employeeId: string;
  employeeVersion: number;
  requestedBy: string;
  sessionId: string;
  runId: string;
}

export interface ConfigurationProposalApplication {
  actor: string;
  at: string;
  reviewRevision: number;
  reviewHash: string;
  acceptedReviewItemIds: string[];
  fromEmployeeVersion: number;
  toEmployeeVersion: number;
}

export interface ConfigurationProposalCancellation {
  actor: string;
  at: string;
  comment?: string;
}

export interface ConfigurationProposal {
  id: string;
  status: ConfigurationProposalStatus;
  title: string;
  reason: string;
  employeeId: string;
  expectedEmployeeVersion: number;
  operations: ConfigurationOperation[];
  reviewItems: ConfigurationReviewItem[];
  decisions: ConfigurationReviewDecision[];
  progress: ConfigurationReviewProgress;
  reviewRevision: number;
  reviewHash: string;
  source: ConfigurationProposalSource;
  planHash: string;
  validation: { valid: boolean; errors: string[] };
  result?: { employeeId: string; employeeVersion: number };
  application?: ConfigurationProposalApplication;
  cancellation?: ConfigurationProposalCancellation;
  error?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface ConfigurationProposalCreateInput {
  title: string;
  reason: string;
  operations: ConfigurationOperation[];
  sourceRunId: string;
}

export interface ConfigurationReviewDecisionInput {
  decision: "accepted" | "rejected";
  expectedReviewRevision: number;
  expectedReviewHash: string;
  actor?: string;
  comment?: string;
}

export interface ConfigurationProposalApplyInput {
  expectedReviewRevision: number;
  expectedReviewHash: string;
}
