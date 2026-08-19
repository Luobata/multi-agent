import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchStore, verifyStore } from "../src/workbench/store.js";
import type { ActivityLogEvent, WorkbenchStateV2 } from "../src/workbench/storeTypes.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-sharding-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const SESSION_ID = "sess-1";
const INVOCATION_ID = "inv-1";
const INSTANCE_ID = "wi-1";

function sessionFixture() {
  return {
    id: SESSION_ID,
    employeeId: "emp-1",
    startedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    status: "active" as const,
    messages: [
      { id: "m1", role: "user" as const, content: "hello", at: "2026-08-20T00:00:00.000Z", dedupeKey: "k1" }
    ]
  };
}

function invocationFixture() {
  return {
    id: INVOCATION_ID,
    source: { kind: "workbench" as const },
    target: { kind: "employee" as const, id: "emp-1", version: 1 },
    requestSummary: "fixture request",
    phase: "completed",
    status: "completed" as const,
    runId: "run-1",
    instanceIds: [] as string[],
    transitions: [] as Array<{ at: string; status: "completed"; phase: string; message?: string }>,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
}

function instanceFixture() {
  return {
    id: INSTANCE_ID,
    invocationId: INVOCATION_ID,
    employeeId: "emp-1",
    employeeVersion: 1,
    workflowId: "wf-1",
    workflowVersion: 1,
    nodeId: "node-1",
    runId: "run-1",
    providerId: "mock",
    source: { kind: "workbench" as const },
    status: "completed" as const,
    phase: "completed",
    createdAt: "2026-08-20T00:00:00.000Z"
  };
}

/** Boots a v1 store (fresh install writes v1), then hand-edits activity data into state.json. */
async function v1RootWithActivity(): Promise<{ root: string; v1: Record<string, unknown> }> {
  const root = temporaryRoot();
  await WorkbenchStore.open(root); // fresh install → v1 initialState
  const statePath = path.join(root, "state.json");
  const v1 = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  v1.sessions = { [SESSION_ID]: sessionFixture() };
  v1.invocations = { [INVOCATION_ID]: invocationFixture() };
  v1.workInstances = { [INSTANCE_ID]: instanceFixture() };
  fs.writeFileSync(statePath, `${JSON.stringify(v1, null, 2)}\n`, "utf8");
  return { root, v1 };
}

function readStateEnvelope(root: string): WorkbenchStateV2 {
  return JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")) as WorkbenchStateV2;
}

function readLog(root: string, entity: "sessions" | "workInstances" | "invocations"): ActivityLogEvent[] {
  const dir = entity === "workInstances" ? "workinstances" : entity;
  const raw = fs.readFileSync(path.join(root, "activity", dir, "log.jsonl"), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as ActivityLogEvent);
}

/** Mirrors the pre-v2 open(): any schemaVersion other than 1 is rejected (fail-closed degradation). */
function legacyOpenRejects(root: string): void {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")) as { schemaVersion?: number };
  if (parsed.schemaVersion !== 1) {
    throw new Error(`unsupported workbench schema version ${String(parsed.schemaVersion)}`);
  }
}

describe("Store v2 sharding", () => {
  it("① migrates v1 activity data into v2 shards with per-domain reconciliation", async () => {
    const { root, v1 } = await v1RootWithActivity();

    const store = await WorkbenchStore.open(root);

    expect(store.openReport.migrated).toBe(true);
    expect(store.openReport.migration?.activityCounts).toEqual({ sessions: 1, workInstances: 1, invocations: 1 });
    // v2 state.json = config + manifests, no top-level activity domains
    const envelope = readStateEnvelope(root);
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.config.providers).toBeDefined();
    expect((envelope as unknown as Record<string, unknown>).sessions).toBeUndefined();
    for (const entity of ["sessions", "workinstances", "invocations"] as const) {
      expect(fs.existsSync(path.join(root, "activity", entity, "base.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, "activity", entity, "log.jsonl"))).toBe(true);
    }
    // per-domain sha256 reconciliation recorded for all 21 domains
    const domainSha256 = store.openReport.migration!.domainSha256;
    expect(Object.keys(domainSha256).sort()).toEqual(
      ["providers", "skills", "skillHistory", "knowledgeBases", "knowledgeProfiles", "knowledgeChangeRequests",
        "workflowChangeRequests", "configurationProposals", "employees", "employeeTemplates", "managementPolicies",
        "entrancePolicies", "workflows", "publications", "projects", "projectBindings", "passiveProjectAccesses",
        "humanDecisionRequests", "sessions", "workInstances", "invocations"].sort()
    );
    // snapshot equivalence with the v1 parse, per domain
    const snapshot = store.snapshot();
    for (const domain of ["providers", "skills", "employees", "projects", "sessions", "workInstances", "invocations"] as const) {
      expect(JSON.stringify(snapshot[domain])).toBe(JSON.stringify((v1 as never)[domain]));
    }
    // .v1.bak retained
    expect(fs.existsSync(path.join(root, "state.json.v1.bak"))).toBe(true);
  });

  it("② old code fail-closes on a v2 state.json", async () => {
    const { root } = await v1RootWithActivity();
    await WorkbenchStore.open(root);
    expect(readStateEnvelope(root).schemaVersion).toBe(2);
    expect(() => legacyOpenRejects(root)).toThrow(/unsupported workbench schema version 2/);
  });

  it("③ rolls back to state.json.v1.bak and reopens cleanly", async () => {
    const { root, v1 } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);
    expect(store.openReport.migrated).toBe(true);

    // simulate rollback: restore the backup, drop the shards
    fs.copyFileSync(path.join(root, "state.json.v1.bak"), path.join(root, "state.json"));
    fs.rmSync(path.join(root, "activity"), { recursive: true, force: true });

    const reopened = await WorkbenchStore.open(root);
    expect(reopened.openReport.migrated).toBe(true); // re-migrates from the restored v1
    const snapshot = reopened.snapshot();
    expect(JSON.stringify(snapshot.sessions)).toBe(JSON.stringify(v1.sessions));
    expect(JSON.stringify(snapshot.invocations)).toBe(JSON.stringify(v1.invocations));
    expect(JSON.stringify(snapshot.workInstances)).toBe(JSON.stringify(v1.workInstances));
  });

  it("④ truncates a torn log tail, reports it, and keeps complete data", async () => {
    const { root } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);
    await store.appendActivity({
      op: "messages.append",
      entity: "sessions",
      id: SESSION_ID,
      message: { id: "m2", role: "employee", content: "hi", at: "2026-08-20T00:01:00.000Z" },
      dedupeKey: "k2"
    });

    // tear the log: append a partial line (simulates a crash mid-append)
    const logPath = path.join(root, "activity", "sessions", "log.jsonl");
    fs.appendFileSync(logPath, '{"v":1,"seq":99,"op":"record.upsert"');
    const tornSize = fs.statSync(logPath).size;

    const reopened = await WorkbenchStore.open(root);
    const truncatedSize = fs.statSync(logPath).size;
    expect(reopened.openReport.truncatedTail).toEqual([{ entity: "sessions", bytesDropped: tornSize - truncatedSize }]);
    expect(tornSize - truncatedSize).toBe(36); // the torn fragment length
    // torn line gone, complete events intact
    const messages = reopened.snapshot().sessions[SESSION_ID]!.messages;
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    const tail = fs.readFileSync(logPath, "utf8");
    expect(tail.endsWith("\n")).toBe(true);
    expect(tail).not.toContain("seq\":99");
  });

  it("⑤ dedupeKey makes message replay idempotent", async () => {
    const { root } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);
    const message = { id: "m2", role: "employee" as const, content: "hi", at: "2026-08-20T00:01:00.000Z" };
    await store.appendActivity({ op: "messages.append", entity: "sessions", id: SESSION_ID, message, dedupeKey: "k2" });
    await store.appendActivity({ op: "messages.append", entity: "sessions", id: SESSION_ID, message, dedupeKey: "k2" });

    const reopened = await WorkbenchStore.open(root);
    const messages = reopened.snapshot().sessions[SESSION_ID]!.messages;
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(reopened.openReport.skippedEvents).toBe(1);
  });

  it("⑥ concurrent open: the second opener waits for the lock and skips migration", async () => {
    const { root } = await v1RootWithActivity();
    // a fully-migrated sibling provides the v2 files the "first" opener will produce
    const sibling = await v1RootWithActivity();
    const first = await WorkbenchStore.open(sibling.root);
    expect(first.openReport.migrated).toBe(true);

    // hold the global lock, then start an open() that must wait
    const lockPath = path.join(root, "state.lock");
    fs.writeFileSync(lockPath, `${process.pid} holder\n`, "utf8");
    const pending = WorkbenchStore.open(root);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let it enter the lock wait

    // the "first" opener finishes: publish v2 files and release the lock
    fs.copyFileSync(path.join(sibling.root, "state.json"), path.join(root, "state.json"));
    fs.cpSync(path.join(sibling.root, "activity"), path.join(root, "activity"), { recursive: true });
    fs.unlinkSync(lockPath);

    const second = await pending;
    expect(second.openReport.migrated).toBe(false); // double-checked: saw v2, did not re-migrate
    expect(second.snapshot().sessions[SESSION_ID]).toBeDefined();
  }, 20_000);

  it("⑦ bootstrap consistency: assembled snapshot matches the v1 content after migration", async () => {
    const { root, v1 } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);
    const snapshot = store.snapshot();
    // every domain (config + activity) round-trips losslessly
    for (const domain of Object.keys(v1)) {
      if (domain === "schemaVersion") continue;
      expect(JSON.stringify(snapshot[domain as keyof typeof snapshot])).toBe(JSON.stringify(v1[domain]));
    }
    expect(snapshot.schemaVersion).toBe(1); // in-memory assembled shape stays v1
  });

  it("⑧ retention deletes become record.delete events and survive reopen", async () => {
    const { root } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);
    await store.mutateActivity((activity) => {
      delete activity.invocations[INVOCATION_ID];
      delete activity.workInstances[INSTANCE_ID];
    });

    const invocationsLog = readLog(root, "invocations");
    const instancesLog = readLog(root, "workInstances");
    expect(invocationsLog).toContainEqual(expect.objectContaining({ op: "record.delete", id: INVOCATION_ID }));
    expect(instancesLog).toContainEqual(expect.objectContaining({ op: "record.delete", id: INSTANCE_ID }));

    const reopened = await WorkbenchStore.open(root);
    const snapshot = reopened.snapshot();
    expect(snapshot.invocations[INVOCATION_ID]).toBeUndefined();
    expect(snapshot.workInstances[INSTANCE_ID]).toBeUndefined();
    expect(snapshot.sessions[SESSION_ID]).toBeDefined();
  });

  it("routes config writes to state.json and activity writes to shard logs", async () => {
    const { root } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);

    const stateBefore = fs.statSync(path.join(root, "state.json")).size;
    const sessionsLogBefore = fs.statSync(path.join(root, "activity", "sessions", "log.jsonl")).size;

    await store.mutateConfig((config) => {
      config.providers["p1"] = { id: "p1", adapter: "command", command: "x", outputProtocol: "json" } as never;
    });
    expect(fs.statSync(path.join(root, "state.json")).size).not.toBe(stateBefore);
    expect(fs.statSync(path.join(root, "activity", "sessions", "log.jsonl")).size).toBe(sessionsLogBefore);

    await store.mutateActivity((activity) => {
      activity.invocations["inv-2"] = invocationFixture();
      activity.invocations["inv-2"]!.id = "inv-2";
    });
    expect(fs.statSync(path.join(root, "activity", "invocations", "log.jsonl")).size).toBeGreaterThan(0);
    expect(store.snapshot().invocations["inv-2"]).toBeDefined();
  });

  it("assigns monotonic per-shard seq via appendActivity", async () => {
    const { root } = await v1RootWithActivity();
    const store = await WorkbenchStore.open(root);
    await store.appendActivity({ op: "record.upsert", entity: "invocations", id: "inv-2", record: invocationFixture() });
    await store.appendActivity({ op: "record.upsert", entity: "invocations", id: "inv-3", record: invocationFixture() });
    await store.appendActivity({
      op: "messages.append",
      entity: "sessions",
      id: SESSION_ID,
      message: { id: "m2", role: "employee", content: "hi", at: "2026-08-20T00:01:00.000Z" }
    });

    const invocationSeqs = readLog(root, "invocations").map((event) => event.seq);
    expect(invocationSeqs).toEqual([1, 2]);
    expect(readLog(root, "sessions").map((event) => event.seq)).toEqual([1]); // per-shard, not global
  });

  it("keeps config-only v1 stores on v1 (no activity → no migration)", async () => {
    const root = temporaryRoot();
    const store = await WorkbenchStore.open(root);
    await store.mutateConfig((config) => {
      config.providers["p1"] = { id: "p1", adapter: "command", command: "x", outputProtocol: "json" } as never;
    });
    const envelope = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")) as { schemaVersion: number };
    expect(envelope.schemaVersion).toBe(1);
    expect(fs.existsSync(path.join(root, "activity"))).toBe(false);
    expect(store.snapshot().providers["p1"]).toBeDefined();
  });

  it("adopts the v2 layout when another process migrates while this instance is open", async () => {
    const { root } = await v1RootWithActivity();
    // strip activity so the first open stays v1 (long-lived "old daemon")
    const statePath = path.join(root, "state.json");
    const v1 = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    v1.sessions = {};
    v1.invocations = {};
    v1.workInstances = {};
    fs.writeFileSync(statePath, JSON.stringify(v1, null, 2));

    const longLived = await WorkbenchStore.open(root); // v1 mode
    expect(longLived.snapshot().schemaVersion).toBe(1);

    // a "new daemon" reopens with activity present and migrates underneath
    const withActivity = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    withActivity.sessions = { [SESSION_ID]: sessionFixture() };
    fs.writeFileSync(statePath, JSON.stringify(withActivity, null, 2));
    const migrator = await WorkbenchStore.open(root);
    expect(migrator.openReport.migrated).toBe(true);

    // the long-lived instance must adopt v2 instead of crashing on the v2 file
    expect(longLived.snapshot().sessions[SESSION_ID]).toBeDefined();
    await longLived.mutate((state) => {
      state.sessions[SESSION_ID]!.status = "closed";
    });
    const reopened = await WorkbenchStore.open(root);
    expect(reopened.snapshot().sessions[SESSION_ID]!.status).toBe("closed");
  });

  it("verifyStore reports ok for a healthy store and failure for a tampered base", async () => {
    const { root } = await v1RootWithActivity();
    await WorkbenchStore.open(root);
    const healthy = await verifyStore(root);
    expect(healthy.ok).toBe(true);
    expect(healthy.schemaVersion).toBe(2);
    expect(healthy.shards?.map((shard) => shard.entity).sort()).toEqual(["invocations", "sessions", "workInstances"]);

    // tamper with a base.json → sha256 mismatch
    const basePath = path.join(root, "activity", "sessions", "base.json");
    const tampered = JSON.parse(fs.readFileSync(basePath, "utf8")) as Record<string, unknown>;
    (tampered[SESSION_ID] as Record<string, unknown>).status = "closed";
    fs.writeFileSync(basePath, JSON.stringify(tampered, null, 2));
    const broken = await verifyStore(root);
    expect(broken.ok).toBe(false);
    expect(broken.shards?.find((shard) => shard.entity === "sessions")?.baseSha256Matches).toBe(false);
  });
});
