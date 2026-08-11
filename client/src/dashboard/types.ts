/**
 * 多项目研发后台看板 · 第一阶段数据契约。
 * 状态词严格复用 components.tsx 的 Stamp / RuntimeStatusChip 语义，不新增状态词。
 */

/** 看板九列（与异常态正交）；merging 专门承接已人工验收、等待串行合入的候选。 */
export type RequirementLane = "inbox" | "clarify" | "planned" | "queued" | "running" | "confirmation" | "acceptance" | "merging" | "done";

/** 阻塞 / 失败 / 取消三种异常态，与所在列正交叠加。 */
export type RequirementException = "blocked" | "failed" | "cancelled" | null;

export type RequirementPriority = "low" | "medium" | "high";

export type RequirementAdvancementStatus =
  | "dispatching"
  | "queued"
  | "running"
  | "awaiting-human-decision"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

/**
 * Durable cursor shared by the human-triggered button and a future polling worker.
 * One cycle owns one idempotency key, so a retry after a lost response cannot create a duplicate Run.
 */
export interface RequirementAdvancement {
  schemaVersion: 1;
  cycle: number;
  trigger: "human" | "automatic";
  status: RequirementAdvancementStatus;
  entrancePolicyId: string;
  idempotencyKey: string;
  invocationId?: string;
  runId?: string;
  leaderSessionId?: string;
  startedAt: string;
  updatedAt: string;
  /** Non-terminal records are eligible for the future scanner after this time. */
  nextCheckAt?: string;
  error?: string;
}

export const REQUIREMENT_LANES: ReadonlyArray<{ id: RequirementLane; label: string }> = [
  { id: "inbox", label: "收件箱" },
  { id: "clarify", label: "待澄清" },
  { id: "planned", label: "已规划" },
  { id: "queued", label: "排队中" },
  { id: "running", label: "执行中" },
  { id: "confirmation", label: "待确认" },
  { id: "acceptance", label: "待验收" },
  { id: "merging", label: "待合入" },
  { id: "done", label: "已完成" }
];

/**
 * The data contract keeps the two early product-state lanes for backward
 * compatibility, but the current board intentionally hides them. Legacy cards
 * stored in either lane are projected into inbox so hiding a column never makes
 * a requirement disappear.
 */
export const VISIBLE_REQUIREMENT_LANES = REQUIREMENT_LANES.filter(
  (lane) => lane.id !== "clarify" && lane.id !== "planned"
);

export function visibleRequirementLane(lane: RequirementLane): RequirementLane {
  return lane === "clarify" || lane === "planned" ? "inbox" : lane;
}

export const REQUIREMENT_EXCEPTION_LABELS: Record<Exclude<RequirementException, null>, string> = {
  blocked: "阻塞",
  failed: "失败",
  cancelled: "已取消"
};

export const REQUIREMENT_PRIORITY_LABELS: Record<RequirementPriority, string> = {
  low: "低",
  medium: "中",
  high: "高"
};

export function requirementLaneLabel(lane: RequirementLane): string {
  return REQUIREMENT_LANES.find((entry) => entry.id === lane)?.label ?? lane;
}

export type SpaceNodeKind = "folder" | "project" | "mcp-observed";

interface SpaceNodeBase {
  id: string;
  parentId: string | null;
  name: string;
  favorite: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 虚拟文件夹：只组织空间树，不对应磁盘目录。 */
export interface FolderNode extends SpaceNodeBase {
  kind: "folder";
}

/** 托管项目：repositoryPath 仅保存配置，不会移动磁盘上的文件。 */
export interface ManagedProject extends SpaceNodeBase {
  kind: "project";
  /** 兼容首个仓库的快捷字段；完整绑定见 repositories。 */
  repositoryPath: string;
  defaultBranch: string;
  repositories: RepositoryBinding[];
  /** MCP 只作为接入证据；正式 Project 仍是需求、角色和权限的唯一事实源。 */
  mcpAccess?: McpAccessEvidence;
}

export interface McpAccessEvidence {
  accessId: string;
  projectKeys: string[];
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * MCP 自动发现的目录节点。它可以被分类和收藏，但尚不是正式 Project，
 * 因此不能承接需求、配置角色或被当成另一套项目事实源。
 */
export interface McpObservedProject extends SpaceNodeBase, McpAccessEvidence {
  kind: "mcp-observed";
  rootPath?: string;
  historical: boolean;
}

export type SpaceNode = FolderNode | ManagedProject | McpObservedProject;

export interface Requirement {
  id: string;
  projectId: string;
  code: string;
  title: string;
  summary: string;
  lane: RequirementLane;
  exception: RequirementException;
  priority: RequirementPriority;
  owner: string;
  advancement?: RequirementAdvancement;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface RepositoryBinding {
  id: string;
  label: string;
  path: string;
  defaultBranch: string;
  primary: boolean;
}

export interface ProjectProfile {
  project: ManagedProject;
  members: Array<{ id: string; name: string; role: string; status: "active" | "pending" }>;
  skills: Array<{ id: string; name: string; source: string }>;
  knowledge: Array<{ id: string; title: string; kind: "document" | "knowledge-base"; updatedAt: string }>;
}

export type DagTaskStatus = "pending" | "running" | "completed" | "blocked" | "failed" | "skipped";

export interface DagTaskNode {
  id: string;
  title: string;
  status: DagTaskStatus;
  dependsOn: string[];
}

export interface TimelineEntry {
  id: string;
  at: string;
  agent: string;
  action: string;
  detail: string;
}

/** 单条 Gate 的可追溯快照；status 必须为服务端真实结论。 */
export interface RunGateSnapshot {
  gateId: string;
  status: string;
}

/**
 * Run 验收快照：把一次合格交付预览的关键证据固定到需求上。
 * 所有字段都来自 merge-preview 的真实返回值，不接受占位字符串。
 */
export interface RunAcceptanceSnapshot {
  runId: string;
  /** 对应服务端完整门禁计算后的 preview.eligible；旧 acceptedVerdict 不能替代硬门禁。 */
  eligible: boolean;
  worktreePath: string;
  /** 对应 requiredCapability === "quality.test" 的 Gate。 */
  testGate?: RunGateSnapshot;
  /** 对应 requiredCapability === "quality.audit" 的 Gate。 */
  reviewGate?: RunGateSnapshot;
  mediaCount: number;
  structuredE2eCount: number;
  diffFiles: string[];
  capturedAt: string;
}

export interface RequirementEvidence {
  diffSummary: string;
  testReport: string;
  reviewNotes: string;
  deliverables: string[];
  /** fail-closed 验收闸：迁移到「待验收」前必须存在的真实 Run 证据。 */
  acceptance?: RunAcceptanceSnapshot;
}

export interface RequirementDetail extends Requirement {
  rawRequirement: string;
  acceptanceCriteria: string[];
  /** demo 字面量 true 是 DemoBadge 的唯一渲染依据。 */
  dag: { demo: true; nodes: DagTaskNode[] };
  timeline: { demo: true; entries: TimelineEntry[] };
  resourceOverview: { demo: true; agents: number; elapsedMinutes: number; tokensUsed: number };
  evidence: RequirementEvidence;
}

export interface ActivityItem {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export interface ResourceAgentLoad {
  name: string;
  role: string;
  load: number;
}

export interface DashboardSummary {
  generatedAt: string;
  projects: { total: number; active: number; favorites: number; archived: number };
  requirements: { total: number; active: number; exceptions: number; byLane: Record<RequirementLane, number> };
  tasks: { queued: number; running: number; confirmation: number; acceptance: number };
  activities: ActivityItem[];
  resourceOverview: { demo: true; agents: ResourceAgentLoad[] };
}

export type ArchiveKind = Exclude<SpaceNodeKind, "mcp-observed"> | "requirement";

export interface ArchiveRecord {
  id: string;
  nodeId: string;
  kind: ArchiveKind;
  name: string;
  breadcrumb: string;
  archivedAt: string;
  archivedBy: string;
  /** 真实接入项目尚无恢复端点时，归档中心只展示历史并说明原因。 */
  restoreDisabledReason?: string;
}

export interface SettingsEntry {
  label: string;
  value: string;
  hint?: string;
}

export interface SettingsSection {
  id: string;
  title: string;
  description: string;
  entries: SettingsEntry[];
}

/** 设置 / 集成第一阶段为只读占位快照。 */
export interface SettingsSnapshot {
  generatedAt: string;
  sections: SettingsSection[];
}
