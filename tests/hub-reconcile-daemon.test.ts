import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Express, NextFunction, Request, Response } from "express";
import { createDaemonApp } from "../src/daemon/server.js";
import { RunDeliveryStore, readRunDelivery } from "../src/runtime/worktreeDelivery.js";
import { WorkbenchService } from "../src/workbench/service.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

async function buildHealthyChain(dataRoot: string, runId: string): Promise<string> {
  const runDir = path.join(dataRoot, "artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const store = RunDeliveryStore.forRunDirectory(runDir, runId);
  await store.advanceDelivery(runId, 0, [{ kind: "absent" }], {
    type: "source.prepared",
    actor: "runtime",
    payload: {
      baseCommit: COMMIT_A,
      sourceBranch: "candidate",
      sourceCommit: COMMIT_A,
      targetBranch: "main",
      targetCommitBeforeMerge: COMMIT_B
    }
  });
  await store.advanceDelivery(runId, 1, [{ kind: "record", status: "awaiting-acceptance" }], {
    type: "merge.approved",
    actor: "reviewer",
    payload: { targetBranch: "main", queuedTargetCommit: COMMIT_B, message: "approved" }
  });
  await store.advanceDelivery(runId, 2, [{ kind: "record", status: "queued-for-merge" }], {
    type: "validation.started",
    actor: "runtime",
    payload: { targetCommit: COMMIT_B, message: "started" }
  });
  await store.advanceDelivery(runId, 3, [{ kind: "record", status: "retesting" }], {
    type: "validation.passed",
    actor: "runtime",
    payload: { required: true, targetCommit: COMMIT_B, runId: "inv-1", message: "passed" }
  });
  return runDir;
}

function revisionFileName(revision: number): string {
  return `${String(revision).padStart(20, "0")}.json`;
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (request: Request, response: Response, next: NextFunction) => void }>;
  };
}

interface InMemoryResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
}

async function invokeRoute(
  app: Express,
  method: "get" | "post",
  routePath: string,
  input: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {}
): Promise<InMemoryResponse> {
  const layers = (app as unknown as { router: { stack: RouteLayer[] } }).router.stack;
  const layer = layers.find((candidate) => candidate.route?.path === routePath && candidate.route.methods[method]);
  const route = layer?.route;
  if (!route) throw new Error(`route not registered: ${method.toUpperCase()} ${routePath}`);
  return new Promise<InMemoryResponse>((resolve, reject) => {
    const result: InMemoryResponse = { status: 200, headers: {} };
    const response = {
      status(code: number) {
        result.status = code;
        return response;
      },
      json(value: unknown) {
        result.json = value;
        resolve(result);
        return response;
      },
      type() {
        return response;
      },
      set(name: string, value: string) {
        result.headers[name.toLowerCase()] = value;
        return response;
      }
    } as unknown as Response;
    const request = {
      params: input.params ?? {},
      body: input.body,
      query: input.query ?? {},
      headers: {}
    } as unknown as Request;
    route.stack[0]!.handle(request, response, (error?: unknown) => {
      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ status: /not found/.test(message) ? 404 : 400, headers: {}, json: { error: { message } } });
      }
    });
  });
}

async function createApp(dataRoot: string): Promise<Express> {
  const service = await WorkbenchService.open({ dataRoot });
  return createDaemonApp(service, { staticDir: path.join(dataRoot, "missing-client") });
}

describe("hub-reconcile daemon API", () => {
  it("GET returns the delivery-chain finding report for a healthy run", async () => {
    const dataRoot = temporaryRoot("hub-reconcile-daemon-healthy-");
    const runId = "run-daemon-healthy";
    await buildHealthyChain(dataRoot, runId);
    const app = await createApp(dataRoot);

    const response = await invokeRoute(app, "get", "/api/runs/:id/delivery-chain", { params: { id: runId } });

    expect(response.status).toBe(200);
    const report = (response.json as { data: { status: string; highestRevision: number; findings: unknown[] } }).data;
    expect(report.status).toBe("aligned");
    expect(report.highestRevision).toBe(4);
    expect(report.findings).toHaveLength(0);
  });

  it("GET reports a misaligned chain and never mutates the files", async () => {
    const dataRoot = temporaryRoot("hub-reconcile-daemon-misaligned-");
    const runId = "run-daemon-misaligned";
    const runDir = await buildHealthyChain(dataRoot, runId);
    const revisionsDir = path.join(runDir, "delivery-revisions");
    fs.renameSync(path.join(revisionsDir, revisionFileName(2)), path.join(revisionsDir, revisionFileName(7)));
    const before = fs.readFileSync(path.join(revisionsDir, revisionFileName(7)), "utf8");
    const app = await createApp(dataRoot);

    const response = await invokeRoute(app, "get", "/api/runs/:id/delivery-chain", { params: { id: runId } });

    expect(response.status).toBe(200);
    const report = (response.json as { data: { status: string; findings: Array<{ code: string }> } }).data;
    expect(report.status).toBe("misaligned");
    expect(report.findings.some((finding) => finding.code === "snapshot-filename-mismatch")).toBe(true);
    // GET is strictly read-only: the misnamed file is untouched.
    expect(fs.readFileSync(path.join(revisionsDir, revisionFileName(7)), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(revisionsDir, revisionFileName(2)))).toBe(false);
  });

  it("POST repair is rejected without an explicit apply confirmation", async () => {
    const dataRoot = temporaryRoot("hub-reconcile-daemon-noapply-");
    const runId = "run-daemon-noapply";
    const runDir = await buildHealthyChain(dataRoot, runId);
    const revisionsDir = path.join(runDir, "delivery-revisions");
    fs.renameSync(path.join(revisionsDir, revisionFileName(2)), path.join(revisionsDir, revisionFileName(7)));
    const app = await createApp(dataRoot);

    const withoutBody = await invokeRoute(app, "post", "/api/runs/:id/delivery-chain/repair", { params: { id: runId } });
    expect(withoutBody.status).toBe(400);
    expect(JSON.stringify(withoutBody.json)).toContain("apply confirmation");

    const applyFalse = await invokeRoute(app, "post", "/api/runs/:id/delivery-chain/repair", {
      params: { id: runId },
      body: { apply: false }
    });
    expect(applyFalse.status).toBe(400);
    // Refusal must not have repaired anything.
    expect(fs.existsSync(path.join(revisionsDir, revisionFileName(7)))).toBe(true);
    expect(fs.existsSync(path.join(revisionsDir, revisionFileName(2)))).toBe(false);
  });

  it("POST repair with apply:true repairs the chain and returns the re-inspected report", async () => {
    const dataRoot = temporaryRoot("hub-reconcile-daemon-apply-");
    const runId = "run-daemon-apply";
    const runDir = await buildHealthyChain(dataRoot, runId);
    const revisionsDir = path.join(runDir, "delivery-revisions");
    fs.renameSync(path.join(revisionsDir, revisionFileName(2)), path.join(revisionsDir, revisionFileName(7)));
    const app = await createApp(dataRoot);

    const response = await invokeRoute(app, "post", "/api/runs/:id/delivery-chain/repair", {
      params: { id: runId },
      body: { apply: true }
    });

    expect(response.status).toBe(200);
    const report = (response.json as {
      data: { status: string; repaired: boolean; applied: string[]; findings: unknown[] };
    }).data;
    expect(report.status).toBe("aligned");
    expect(report.repaired).toBe(true);
    expect(report.applied.some((step) => step.startsWith("renamed snapshot"))).toBe(true);
    expect(report.findings).toHaveLength(0);
    expect(fs.existsSync(path.join(revisionsDir, revisionFileName(2)))).toBe(true);
    const delivery = await readRunDelivery(runDir, runId);
    expect(delivery?.revision).toBe(4);
  });

  it("POST repair surfaces the attention refusal (all-or-nothing) without mutating the projection", async () => {
    const dataRoot = temporaryRoot("hub-reconcile-daemon-refuse-");
    const runId = "run-daemon-refuse";
    const runDir = await buildHealthyChain(dataRoot, runId);
    // Hand-craft an unrepairable misalignment: a v2 projection ahead of the immutable chain.
    const snapshotFile = path.join(runDir, "delivery-revisions", revisionFileName(4));
    const envelope = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as {
      record: { revision: number; lastEvent?: { at?: string } };
    };
    const ahead = {
      ...envelope.record,
      revision: 5,
      lastEvent: {
        id: "manual-event",
        type: "validation.passed",
        actor: "runtime",
        at: envelope.record.lastEvent?.at,
        fromRevision: 4,
        toRevision: 5
      }
    };
    fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify(ahead, null, 2)}\n`);
    const app = await createApp(dataRoot);

    const response = await invokeRoute(app, "post", "/api/runs/:id/delivery-chain/repair", {
      params: { id: runId },
      body: { apply: true }
    });

    expect(response.status).toBe(200);
    const report = (response.json as {
      data: { status: string; repaired: boolean; applied: string[]; findings: Array<{ code: string; severity: string }> };
    }).data;
    expect(report.status).toBe("corrupt");
    expect(report.repaired).toBe(false);
    expect(report.applied).toHaveLength(0);
    expect(report.findings.some((finding) => finding.code === "projection-ahead" && finding.severity === "attention")).toBe(true);
    // The corrupt projection was left untouched.
    const onDisk = JSON.parse(fs.readFileSync(path.join(runDir, "delivery.json"), "utf8")) as { revision: number };
    expect(onDisk.revision).toBe(5);
  });
});
