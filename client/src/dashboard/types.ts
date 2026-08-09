/**
 * 多项目研发后台看板 · 第一阶段数据契约。
 * 状态词严格复用 components.tsx 的 Stamp / RuntimeStatusChip 语义，不新增状态词。
 */

/** 看板七列（与异常态正交）。 */
export type RequirementLane = "inbox" | "clarify" | "planned" | "queued" | "running" | "acceptance" | "done";

/** 阻塞 / 失败 / 取消三种异常态，与所在列正交叠加。 */
export type RequirementException = "blocked" | "failed" | "cancelled" | null;

export type RequirementPriority = "low" | "medium" | "high";

export const REQUIREMENT_LANES: ReadonlyArray<{ id: RequirementLane; label: string }> = [
  { id: "inbox", label: "收件箱" },
  { id: "clarify", label: "待澄清" },
  { id: "planned", label: "已规划" },
  { id: "queued", label: "排队中" },
  { id: "running", label: "执行中" },
  { id: "acceptance", label: "待验收" },
  { id: "done", label: "已完成" }
];

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

export type SpaceNodeKind = "folder" | "project";

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
}

export type SpaceNode = FolderNode | ManagedProject;

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

export interface RequirementEvidence {
  diffSummary: string;
  testReport: string;
  reviewNotes: string;
  deliverables: string[];
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
  tasks: { queued: number; running: number; acceptance: number };
  activities: ActivityItem[];
  resourceOverview: { demo: true; agents: ResourceAgentLoad[] };
}

export type ArchiveKind = SpaceNodeKind | "requirement";

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
