import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkbenchStore } from "./store.js";
import type { EmployeeDefinition, WorkbenchState } from "./types.js";

// These tests exercise the real load path: WorkbenchStore.open() reads state.json
// and runs normalizeState, and snapshot() re-runs it. normalizeState performs pure
// FIELD MIGRATION for the built-in system employees — it backfills the first-class
// `systemRole` on legacy internal-employee records (小忆 automatic; 小知/小配/小关
// conversational) and repairs the summarizer's provider, and it seeds the
// codex-memory-summarizer provider singleton. It must NOT create employees or
// skills (those have a version-pinned domain lifecycle), and must not reclassify
// ad-hoc legacy project-internal employees that lack the system-employee marker.

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-system-employees-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function emptyState(over: Partial<WorkbenchState> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    providers: {},
    skills: {},
    skillHistory: {},
    knowledgeBases: {},
    knowledgeProfiles: {},
    knowledgeChangeRequests: {},
    workflowChangeRequests: {},
    configurationProposals: {},
    employees: {},
    employeeTemplates: {},
    managementPolicies: {},
    entrancePolicies: {},
    workflows: {},
    sessions: {},
    publications: {},
    projects: {},
    projectBindings: {},
    passiveProjectAccesses: {},
    invocations: {},
    workInstances: {},
    ...over
  };
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(dataRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readState(): Promise<WorkbenchState> {
  return JSON.parse(await readFile(path.join(dataRoot, "state.json"), "utf8")) as WorkbenchState;
}

/** A legacy employee record missing the first-class systemRole field. */
function legacyEmployeeRecord(over: Partial<EmployeeDefinition>): { current: EmployeeDefinition; versions: EmployeeDefinition[] } {
  const base: EmployeeDefinition = {
    id: "x",
    version: 1,
    status: "active",
    identity: { displayName: "x", background: "b", responsibilities: ["r"] },
    description: "d",
    systemPrompt: "s",
    requestPrompt: "q",
    capabilities: [],
    scope: { kind: "global" },
    skills: [],
    skillVersions: {},
    knowledgeProfileIds: [],
    knowledgeGrants: [],
    providerId: "codex",
    outputSchema: { type: "object" },
    maxAttempts: 1,
    permissions: { write: "none", tools: [] },
    contextPolicy: { historyLimit: 1 },
    presentation: {},
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...over
  };
  return { current: base, versions: [base] };
}

describe("system employee normalization", () => {
  it("seeds the codex-memory-summarizer provider on a fresh install", async () => {
    const store = await WorkbenchStore.open(dataRoot); // no state.json => initialState()
    const state = store.snapshot();

    expect(state.providers["codex-memory-summarizer"]).toBeDefined();
    expect(state.providers["codex-memory-summarizer"]?.adapter).toBe("codex");
    // Migration must not fabricate employees.
    expect(Object.keys(state.employees)).toHaveLength(0);
  });

  it("backfills systemRole=automatic and repairs the provider for a legacy 小忆", async () => {
    await writeState(emptyState({
      employees: {
        "memory-summarizer": legacyEmployeeRecord({
          id: "memory-summarizer",
          identity: {
            displayName: "小忆 · 运行经验提炼器",
            background: "b",
            responsibilities: ["r"],
            metadata: { employeeKind: "system-automatic-summarizer" }
          },
          scope: { kind: "global" },
          providerId: "codex"
        })
      }
    }) as unknown as Record<string, unknown>);

    const summarizer = (await WorkbenchStore.open(dataRoot)).snapshot().employees["memory-summarizer"]?.current;

    expect(summarizer?.systemRole).toBe("automatic");
    expect(summarizer?.providerId).toBe("codex-memory-summarizer");
  });

  it("backfills systemRole=conversational for a steward record and syncs all versions", async () => {
    const steward = legacyEmployeeRecord({
      id: "local-agent-workbench-knowledge-steward",
      identity: {
        displayName: "小知 · 项目知识管理员",
        background: "b",
        responsibilities: ["r"],
        metadata: {
          internalProjectId: "local-agent-workbench",
          internalProjectRoleId: "knowledge-steward",
          employeeKind: "project-internal-control-agent"
        }
      },
      scope: { kind: "project", projectId: "local-agent-workbench", projectVersion: 1 },
      providerId: "codex-knowledge-control"
    });

    await writeState(emptyState({
      employees: { "local-agent-workbench-knowledge-steward": steward }
    }) as unknown as Record<string, unknown>);

    const record = (await WorkbenchStore.open(dataRoot)).snapshot().employees["local-agent-workbench-knowledge-steward"];

    expect(record?.current.systemRole).toBe("conversational");
    expect(record?.versions.every((version) => version.systemRole === "conversational")).toBe(true);
  });

  it("does NOT reclassify an ad-hoc legacy project-internal employee lacking the system marker", async () => {
    // internalProjectId without employeeKind is the pre-system-employee convention
    // used by ordinary project-internal employees; migration must leave it alone so
    // the domain's older project-role enforcement path still applies.
    const adhoc = legacyEmployeeRecord({
      id: "internal-steward",
      identity: {
        displayName: "Internal Steward",
        background: "b",
        responsibilities: ["r"],
        metadata: { internalProjectId: "project-a", internalProjectRoleId: "knowledge-steward" }
      },
      scope: { kind: "project", projectId: "project-a", projectVersion: 1 },
      providerId: "codex"
    });

    await writeState(emptyState({
      employees: { "internal-steward": adhoc }
    }) as unknown as Record<string, unknown>);

    const record = (await WorkbenchStore.open(dataRoot)).snapshot().employees["internal-steward"]?.current;

    expect(record?.systemRole).toBeUndefined();
  });

  it("is idempotent: only-missing fields are filled and no versions accumulate", async () => {
    await writeState(emptyState({
      employees: {
        "memory-summarizer": legacyEmployeeRecord({
          id: "memory-summarizer",
          identity: {
            displayName: "小忆 · 运行经验提炼器",
            background: "b",
            responsibilities: ["r"],
            metadata: { employeeKind: "system-automatic-summarizer" }
          },
          providerId: "codex"
        })
      }
    }) as unknown as Record<string, unknown>);

    const store = await WorkbenchStore.open(dataRoot);
    const first = store.snapshot();
    const second = store.snapshot();

    expect(second.employees["memory-summarizer"]?.versions.length)
      .toBe(first.employees["memory-summarizer"]?.versions.length);

    // A mutation persists normalized state; re-opening must be stable.
    await store.mutate(() => undefined);
    const persisted = await readState();
    expect(persisted.employees["memory-summarizer"]?.current.systemRole).toBe("automatic");
    expect(persisted.employees["memory-summarizer"]?.versions.length).toBe(1);
  });
});
