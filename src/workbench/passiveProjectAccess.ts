import { createHash } from "node:crypto";
import path from "node:path";
import type {
  PassiveProjectAccessRecord,
  ProjectDefinition,
  WorkbenchState
} from "./types.js";

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export interface PassiveProjectAccessObservation {
  rootPath?: string;
  projectKey?: string;
  seenAt: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedRoot(value: unknown): string | undefined {
  const rootPath = text(value);
  return rootPath && path.isAbsolute(rootPath) ? path.normalize(rootPath) : undefined;
}

function normalizedProjectKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter((item): item is string => Boolean(item)))].sort();
}

function passiveAccessId(rootPath: string | undefined, projectKey: string | undefined): string {
  const identity = rootPath ? `root:${rootPath}` : `project:${projectKey}`;
  return `mcp-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function displayName(rootPath: string | undefined, projectKeys: string[]): string {
  return projectKeys[0] ?? (rootPath ? path.basename(rootPath) || rootPath : "MCP 历史项目");
}

function timestamp(value: unknown, fallback = FALLBACK_TIMESTAMP): string {
  return text(value) ?? fallback;
}

function linkedProject(
  access: Pick<PassiveProjectAccessRecord, "rootPath" | "projectKeys">,
  projects: ProjectDefinition[]
): ProjectDefinition | undefined {
  const keys = new Set(access.projectKeys);
  return projects.find((project) => keys.has(project.id))
    ?? projects.find((project) => access.rootPath !== undefined && project.rootPath === access.rootPath);
}

export function passiveProjectAccessLinkedProjectId(
  access: Pick<PassiveProjectAccessRecord, "rootPath" | "projectKeys">,
  projects: ProjectDefinition[]
): string | undefined {
  return linkedProject(access, projects)?.id;
}

function shouldMerge(
  left: PassiveProjectAccessRecord,
  right: PassiveProjectAccessRecord,
  projects: ProjectDefinition[]
): boolean {
  if (left.rootPath && left.rootPath === right.rootPath) return true;
  if (left.projectKeys.some((projectKey) => right.projectKeys.includes(projectKey))) return true;
  const leftProject = linkedProject(left, projects);
  const rightProject = linkedProject(right, projects);
  return Boolean(leftProject && rightProject && leftProject.id === rightProject.id);
}

function mergeRecords(records: PassiveProjectAccessRecord[]): PassiveProjectAccessRecord {
  const ordered = [...records].sort((left, right) =>
    left.firstSeenAt.localeCompare(right.firstSeenAt) || left.id.localeCompare(right.id)
  );
  const first = ordered[0]!;
  const projectKeys = [...new Set(ordered.flatMap((record) => record.projectKeys))].sort();
  const rootPath = ordered.find((record) => record.rootPath)?.rootPath;
  return {
    id: first.id,
    rootPath,
    projectKeys,
    displayName: first.displayName || displayName(rootPath, projectKeys),
    transport: "mcp",
    requestCount: ordered.reduce((total, record) => total + record.requestCount, 0),
    firstSeenAt: ordered.map((record) => record.firstSeenAt).sort()[0] ?? FALLBACK_TIMESTAMP,
    lastSeenAt: ordered.map((record) => record.lastSeenAt).sort().at(-1) ?? FALLBACK_TIMESTAMP
  };
}

function coalesceRecords(
  records: PassiveProjectAccessRecord[],
  projects: ProjectDefinition[]
): PassiveProjectAccessRecord[] {
  const pending = [...records];
  const merged: PassiveProjectAccessRecord[] = [];
  while (pending.length > 0) {
    let group = [pending.shift()!];
    let grew = true;
    while (grew) {
      grew = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (!group.some((record) => shouldMerge(record, pending[index]!, projects))) continue;
        group.push(pending.splice(index, 1)[0]!);
        grew = true;
      }
    }
    merged.push(mergeRecords(group));
  }
  return merged;
}

function normalizedRecord(value: PassiveProjectAccessRecord): PassiveProjectAccessRecord | undefined {
  const legacy = value as PassiveProjectAccessRecord & { projectKey?: unknown };
  const rootPath = normalizedRoot(legacy.rootPath);
  const projectKeys = normalizedProjectKeys([
    ...(Array.isArray(legacy.projectKeys) ? legacy.projectKeys : []),
    legacy.projectKey
  ]);
  if (!rootPath && projectKeys.length === 0) return undefined;
  const firstSeenAt = timestamp(legacy.firstSeenAt);
  return {
    id: text(legacy.id) ?? passiveAccessId(rootPath, projectKeys[0]),
    rootPath,
    projectKeys,
    displayName: text(legacy.displayName) ?? displayName(rootPath, projectKeys),
    transport: "mcp",
    requestCount: Number.isInteger(legacy.requestCount) && legacy.requestCount > 0 ? legacy.requestCount : 1,
    firstSeenAt,
    lastSeenAt: timestamp(legacy.lastSeenAt, firstSeenAt)
  };
}

/**
 * Repairs the passive-access ledger and idempotently backfills MCP Invocation evidence.
 * Historical Invocations carry no cwd, so their source.project becomes a key-only record.
 */
export function normalizePassiveProjectAccesses(state: WorkbenchState): void {
  const projects = Object.values(state.projects).map((record) => record.current);
  let records = coalesceRecords(
    Object.values(state.passiveProjectAccesses)
      .map(normalizedRecord)
      .filter((record): record is PassiveProjectAccessRecord => Boolean(record)),
    projects
  );

  const historicalByProjectKey = new Map<string, { count: number; firstSeenAt: string; lastSeenAt: string }>();
  for (const invocation of Object.values(state.invocations)) {
    const projectKey = invocation.source.kind === "mcp" ? text(invocation.source.project) : undefined;
    if (!projectKey) continue;
    const seenAt = timestamp(invocation.createdAt, timestamp(invocation.updatedAt));
    const historical = historicalByProjectKey.get(projectKey);
    if (historical) {
      historical.count += 1;
      historical.firstSeenAt = [historical.firstSeenAt, seenAt].sort()[0]!;
      historical.lastSeenAt = [historical.lastSeenAt, seenAt].sort().at(-1)!;
    } else {
      historicalByProjectKey.set(projectKey, { count: 1, firstSeenAt: seenAt, lastSeenAt: seenAt });
    }
  }

  for (const [projectKey, historical] of historicalByProjectKey) {
    const connectedProject = projects.find((project) => project.id === projectKey);
    const existing = records.find((record) => record.projectKeys.includes(projectKey))
      ?? (connectedProject
        ? records.find((record) => record.rootPath === connectedProject.rootPath)
        : undefined);
    if (existing) {
      existing.projectKeys = [...new Set([...existing.projectKeys, projectKey])].sort();
      continue;
    }
    records.push({
      id: passiveAccessId(undefined, projectKey),
      projectKeys: [projectKey],
      displayName: projectKey,
      transport: "mcp",
      requestCount: historical.count,
      firstSeenAt: historical.firstSeenAt,
      lastSeenAt: historical.lastSeenAt
    });
  }

  records = coalesceRecords(records, projects);
  for (const record of records) {
    const historical = record.projectKeys
      .map((projectKey) => historicalByProjectKey.get(projectKey))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (historical.length === 0) continue;
    record.requestCount = Math.max(
      record.requestCount,
      historical.reduce((total, item) => total + item.count, 0)
    );
    record.firstSeenAt = [record.firstSeenAt, ...historical.map((item) => item.firstSeenAt)].sort()[0]!;
    record.lastSeenAt = [record.lastSeenAt, ...historical.map((item) => item.lastSeenAt)].sort().at(-1)!;
  }

  state.passiveProjectAccesses = Object.fromEntries(
    records.sort((left, right) => left.id.localeCompare(right.id)).map((record) => [record.id, record])
  );
}

export function observePassiveProjectAccess(
  state: WorkbenchState,
  observation: PassiveProjectAccessObservation
): PassiveProjectAccessRecord {
  normalizePassiveProjectAccesses(state);
  const projects = Object.values(state.projects).map((record) => record.current);
  const rootPath = normalizedRoot(observation.rootPath);
  const projectKey = text(observation.projectKey);
  if (!rootPath && !projectKey) throw new Error("MCP project access requires a root path or project key");

  const matches = Object.values(state.passiveProjectAccesses).filter((record) =>
    (rootPath !== undefined && record.rootPath === rootPath)
    || (projectKey !== undefined && record.projectKeys.includes(projectKey))
  );
  const existing = matches.length > 0 ? mergeRecords(matches) : undefined;
  for (const match of matches) delete state.passiveProjectAccesses[match.id];

  const projectKeys = [...new Set([...(existing?.projectKeys ?? []), ...(projectKey ? [projectKey] : [])])].sort();
  const recordedRoot = existing?.rootPath ?? rootPath;
  const access: PassiveProjectAccessRecord = {
    id: existing?.id ?? passiveAccessId(recordedRoot, projectKeys[0]),
    rootPath: recordedRoot,
    projectKeys,
    displayName: existing?.displayName ?? displayName(recordedRoot, projectKeys),
    transport: "mcp",
    requestCount: (existing?.requestCount ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? observation.seenAt,
    lastSeenAt: observation.seenAt
  };
  state.passiveProjectAccesses[access.id] = access;
  normalizePassiveProjectAccesses(state);
  return Object.values(state.passiveProjectAccesses).find((record) =>
    (recordedRoot !== undefined && record.rootPath === recordedRoot)
    || (projectKey !== undefined && record.projectKeys.includes(projectKey))
  ) ?? access;
}
