import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Express, NextFunction, Request, Response } from "express";
import type { WorkflowRunRecord } from "../src/core/types.js";
import { createDaemonApp } from "../src/daemon/server.js";
import { createRunWorktree } from "../src/runtime/worktree.js";
import {
  assessQueuedRun,
  queueAcceptedRun,
  transitionRunDelivery,
  updateRunDelivery,
  type RunMergePreview,
  type RunMergeQueueResult
} from "../src/runtime/worktreeDelivery.js";
import { WorkbenchService } from "../src/workbench/service.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = temporaryRoot("multi-agent-delivery-daemon-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "delivery-daemon@example.com");
  git(root, "config", "user.name", "Delivery Daemon Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".multi-agent/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-m", "seed");
  return root;
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
  body?: Buffer;
}

async function invokeRoute(
  app: Express,
  method: "get" | "post",
  routePath: string,
  input: { params?: Record<string, string>; body?: unknown } = {}
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
      type(value: string) {
        result.headers["content-type"] = value;
        return response;
      },
      set(name: string, value: string) {
        result.headers[name.toLowerCase()] = value;
        return response;
      },
      sendFile(
        filePath: string,
        optionsOrCallback: { dotfiles?: string } | ((error?: Error) => void),
        maybeCallback?: (error?: Error) => void
      ) {
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
        if (!callback) throw new Error("sendFile callback is required");
        fs.readFile(filePath, (error, body) => {
          if (error) {
            callback(error);
            reject(error);
            return;
          }
          result.body = body;
          callback();
          resolve(result);
        });
        return response;
      }
    } as unknown as Response;
    const request = {
      params: input.params ?? {},
      body: input.body,
      query: {},
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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("run delivery daemon routes", () => {
  it("serves a read-only preview and inline evidence, then requires the exact confirmation token", async () => {
    const dataRoot = temporaryRoot("multi-agent-delivery-daemon-data-");
    const repo = repository();
    const runId = "run-delivery-daemon-1";
    const worktree = await createRunWorktree(repo, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "feature.txt"), "accepted through daemon\n", "utf8");

    const runDir = path.join(dataRoot, "artifacts", "runs", runId);
    fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(path.join(runDir, "evidence", "acceptance.png"), png);
    const run: WorkflowRunRecord = {
      id: runId,
      workflow: "delivery-daemon",
      architecture: "supervisor",
      manifestPath: path.join(runDir, "multi-agent.yaml"),
      // The service must ignore this persisted path for delivery filesystem access.
      artifactDir: path.join(dataRoot, "untrusted-artifact-dir"),
      status: "passed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      isolation: { mode: "worktree", worktreePath: worktree!.path, baseCommit: worktree!.baseCommit },
      output: {
        gates: [
          {
            gateId: "quality-test", requiredCapability: "quality.test", mode: "before-completion",
            required: true, status: "passed"
          },
          {
            gateId: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion",
            required: true, status: "passed"
          }
        ]
      },
      nodes: {
        tester: {
          nodeId: "tester",
          roleId: "test-engineer",
          status: "passed",
          attempts: 1,
          output: {
            verdict: "pass",
            e2eEvidence: [{ method: "http-behavior", steps: "Call delivery routes", observed: "Expected response" }]
          }
        }
      }
    };
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");

    const service = await WorkbenchService.open({ dataRoot });
    const app = createDaemonApp(service, { staticDir: path.join(dataRoot, "missing-client") });
    const headBefore = git(repo, "rev-parse", "HEAD");

    const previewResponse = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
    expect(previewResponse.status).toBe(200);
    const previewEnvelope = previewResponse.json as { data: RunMergePreview };
    expect(previewEnvelope.data).toMatchObject({
      runId,
      eligible: true,
      targetBranch: "main",
      changes: { fileCount: 1 },
      evidence: { structuredE2eCount: 1, acceptedVerdict: true }
    });
    expect(previewEnvelope.data.changes.unifiedDiff.text).toContain("feature.txt");
    expect(previewEnvelope.data.safeGitCommands.length).toBeGreaterThan(0);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);

    // A daemon restart loses the in-memory worker. The first preview must turn
    // its durable queued/running marker into a retryable terminal state instead
    // of leaving the UI disabled forever.
    fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify({
      runId,
      status: "awaiting-acceptance",
      updatedAt: "2026-08-11T06:03:35.570Z",
      evidenceRerun: {
        status: "running",
        actor: "workbench-operator",
        requestedAt: "2026-08-11T06:03:35.535Z",
        updatedAt: "2026-08-11T06:03:35.570Z"
      }
    }, null, 2)}\n`, "utf8");
    const interruptedStaging = path.join(
      worktree!.path,
      ".multi-agent",
      "evidence-rerun",
      `${runId}-interrupted-attempt`
    );
    fs.mkdirSync(interruptedStaging, { recursive: true });
    fs.writeFileSync(path.join(interruptedStaging, "recovered.png"), png);
    const recoveredPost = await invokeRoute(app, "post", "/api/runs/:id/evidence-rerun", {
      params: { id: runId }, body: { actor: "daemon-reviewer" }
    });
    expect(recoveredPost.status).toBe(202);
    expect(recoveredPost.json).toMatchObject({ data: { evidenceRerun: {
      status: "passed",
      mediaCount: 1,
      message: expect.stringContaining("无需重复补采")
    } } });
    const recoveredResponse = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
    expect(recoveredResponse.status).toBe(200);
    expect(recoveredResponse.json).toMatchObject({ data: { delivery: { evidenceRerun: {
      status: "passed",
      mediaCount: 1,
      message: expect.stringContaining("无需重复补采")
    } } } });
    expect((recoveredResponse.json as { data: RunMergePreview }).data.evidence.assets.map((candidate) => candidate.name))
      .toContain("001-recovered.png");

    // Recovered media remains first-class delivery evidence. The API must agree with the UI and
    // reject a duplicate capture instead of displaying an action that can never succeed.
    const retriedCapture = await invokeRoute(app, "post", "/api/runs/:id/evidence-rerun", {
      params: { id: runId },
      body: { actor: "daemon-reviewer" }
    });
    expect(retriedCapture.status).toBe(400);
    expect(retriedCapture.json).toMatchObject({ error: { message: expect.stringContaining("已有完整媒体证据") } });

    for (const conflictStatus of ["resolving", "retesting", "leader-review"]) {
      fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify({
        runId, status: "conflict", updatedAt: "2026-08-11T06:03:50.000Z",
        evidenceRerun: {
          status: "failed", actor: "workbench-operator", requestedAt: "2026-08-11T06:03:35.535Z",
          updatedAt: "2026-08-11T06:03:50.000Z", mediaCount: 1, message: "补采失败；已保留部分媒体。"
        },
        conflictResolution: { status: conflictStatus, actor: "daemon-reviewer", requestedAt: "2026-08-11T06:03:45.000Z", updatedAt: "2026-08-11T06:03:50.000Z" }
      }, null, 2)}\n`, "utf8");
      const conflictCapture = await invokeRoute(app, "post", "/api/runs/:id/evidence-rerun", {
        params: { id: runId }, body: { actor: "daemon-reviewer" }
      });
      expect(conflictCapture.status).toBe(400);
      expect(conflictCapture.json).toMatchObject({ error: { message: expect.stringContaining("冲突处理正在进行") } });
    }

    fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify({
      runId, status: "awaiting-acceptance", updatedAt: "2026-08-11T06:04:00.000Z",
      evidenceRerun: {
        status: "failed", actor: "workbench-operator", requestedAt: "2026-08-11T06:03:35.535Z",
        updatedAt: "2026-08-11T06:04:00.000Z", mediaCount: 1, message: "补采失败；已保留部分媒体。"
      }
    }, null, 2)}\n`, "utf8");
    const retriedPartialCapture = await invokeRoute(app, "post", "/api/runs/:id/evidence-rerun", {
      params: { id: runId }, body: { actor: "daemon-reviewer" }
    });
    expect(retriedPartialCapture.status).toBe(202);
    expect(retriedPartialCapture.json).toMatchObject({ data: { evidenceRerun: { status: "queued" } } });
    expect(fs.existsSync(path.join(runDir, "evidence-reruns", "recovered-2026-08-11T06-03-35-535Z-1", "001-recovered.png"))).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const latest = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
      const status = (latest.json as { data: RunMergePreview }).data.delivery?.evidenceRerun?.status;
      if (status !== "queued" && status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const kept = await invokeRoute(app, "post", "/api/runs/:id/keep", {
      params: { id: runId },
      body: { actor: "daemon-reviewer", note: "retain while reviewing" }
    });
    expect(kept.status).toBe(200);
    expect(kept.json).toMatchObject({ data: { status: "kept", delivery: { humanDecision: { action: "keep" } } } });
    expect(fs.existsSync(worktree!.path)).toBe(true);

    const rejectedDiscard = await invokeRoute(app, "post", "/api/runs/:id/discard", {
      params: { id: runId },
      body: { confirmation: "DISCARD another-run", actor: "daemon-reviewer" }
    });
    expect(rejectedDiscard.status).toBe(400);
    expect(rejectedDiscard.json).toMatchObject({ error: { message: expect.stringContaining("精确丢弃确认") } });

    const asset = previewEnvelope.data.evidence.assets[0]!;
    const evidenceResponse = await invokeRoute(app, "get", "/api/runs/:id/evidence/:assetId", {
      params: { id: runId, assetId: asset.id }
    });
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.headers["content-type"]).toContain("image/png");
    expect(evidenceResponse.headers["content-disposition"]).toContain("inline;");
    expect(evidenceResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(evidenceResponse.body).toEqual(png);

    const rejected = await invokeRoute(app, "post", "/api/runs/:id/merge", {
      params: { id: runId },
      body: { confirmation: "MERGE another-run", targetBranch: "main" }
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ error: { message: expect.stringContaining("直接合入接口已停用") } });
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);

    const queued = await invokeRoute(app, "post", "/api/runs/:id/merge-queue", {
      params: { id: runId },
      body: { confirmation: previewEnvelope.data.confirmationToken, targetBranch: "main", actor: "daemon-reviewer" }
    });
    expect(queued.status).toBe(202);
    expect(queued.json).toMatchObject({ data: { status: "queued-for-merge", delivery: { runId, targetBranch: "main" } } });
    let mergedPreview: RunMergePreview | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
      mergedPreview = (response.json as { data: RunMergePreview }).data;
      if (mergedPreview.status === "merged") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mergedPreview).toMatchObject({ status: "merged", delivery: { runId, targetBranch: "main" } });
    expect(fs.readFileSync(path.join(repo, "feature.txt"), "utf8")).toBe("accepted through daemon\n");
    for (let attempt = 0; attempt < 100 && fs.existsSync(worktree!.path); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(worktree!.path)).toBe(false);
  }, 15_000);

  it("resumes a validated merging delivery without repeating target-drift tests", async () => {
    const dataRoot = temporaryRoot("multi-agent-delivery-resume-data-");
    const repo = repository();
    const runId = "run-delivery-resume-validated-1";
    const worktree = await createRunWorktree(repo, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "validated.txt"), "validated candidate\n", "utf8");

    const runDir = path.join(dataRoot, "artifacts", "runs", runId);
    fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "evidence", "acceptance.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const run: WorkflowRunRecord = {
      id: runId,
      workflow: "delivery-resume",
      architecture: "supervisor",
      manifestPath: path.join(runDir, "multi-agent.yaml"),
      artifactDir: runDir,
      status: "passed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      isolation: { mode: "worktree", worktreePath: worktree!.path, baseCommit: worktree!.baseCommit },
      output: {
        gates: [
          {
            gateId: "quality-test", requiredCapability: "quality.test", mode: "before-completion",
            required: true, status: "passed"
          },
          {
            gateId: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion",
            required: true, status: "passed"
          }
        ]
      },
      nodes: {
        tester: {
          nodeId: "tester",
          roleId: "test-engineer",
          status: "passed",
          attempts: 1,
          output: {
            verdict: "pass",
            e2eEvidence: [{ method: "browser", steps: "Validate candidate", observed: "Candidate passed" }]
          }
        }
      }
    };
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");

    await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "daemon-reviewer"
    });
    fs.writeFileSync(path.join(repo, "target-before-rebase.txt"), "target before rebase\n", "utf8");
    git(repo, "add", "target-before-rebase.txt");
    git(repo, "commit", "-m", "advance target before managed rebase");
    const rebasedTargetCommit = git(repo, "rev-parse", "HEAD");
    git(worktree!.path, "rebase", rebasedTargetCommit);
    const rebasedSourceCommit = git(worktree!.path, "rev-parse", "HEAD");
    await updateRunDelivery(runDir, runId, (current) => ({
      ...current!,
      runId,
      baseCommit: rebasedTargetCommit,
      sourceCommit: rebasedSourceCommit,
      queuedTargetCommit: rebasedTargetCommit,
      targetCommitBeforeMerge: rebasedTargetCommit,
      updatedAt: new Date().toISOString()
    }));

    fs.writeFileSync(path.join(repo, "target-after-rebase.txt"), "target after rebase\n", "utf8");
    git(repo, "add", "target-after-rebase.txt");
    git(repo, "commit", "-m", "advance target after managed rebase");
    const targetCommit = (await assessQueuedRun(run, runDir)).currentTargetCommit;
    await transitionRunDelivery(runDir, runId, "merging", {
      message: "Target-drift validation passed; daemon stopped before merge.",
      mergeValidation: {
        required: true,
        status: "passed",
        runId: "validation-run-1",
        targetCommit,
        message: "Independent validation passed.",
        updatedAt: new Date().toISOString()
      }
    });
    await updateRunDelivery(runDir, runId, (current) => ({
      ...current!,
      runId,
      // The current target is not an ancestor of the rebased candidate. This
      // deliberately exercises the queue worker rejection path first.
      baseCommit: targetCommit,
      updatedAt: new Date().toISOString()
    }));

    const service = await WorkbenchService.open({ dataRoot });
    const app = createDaemonApp(service, { staticDir: path.join(dataRoot, "missing-client") });
    let rejectedPreview: RunMergePreview | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
      rejectedPreview = (response.json as { data: RunMergePreview }).data;
      if (rejectedPreview.status === "returned-to-acceptance") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rejectedPreview).toMatchObject({
      status: "returned-to-acceptance",
      delivery: { message: expect.stringContaining("受管 rebase 基线") }
    });
    await updateRunDelivery(runDir, runId, (current) => ({
      ...current!,
      runId,
      status: "merging",
      baseCommit: rebasedTargetCommit,
      updatedAt: new Date().toISOString(),
      message: "Retry the already validated merge after correcting its trusted base."
    }));

    let mergedPreview: RunMergePreview | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
      mergedPreview = (response.json as { data: RunMergePreview }).data;
      if (mergedPreview.status === "merged") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mergedPreview).toMatchObject({
      status: "merged",
      delivery: { mergeValidation: { status: "passed", runId: "validation-run-1", targetCommit } }
    });
    expect(fs.readFileSync(path.join(repo, "validated.txt"), "utf8")).toBe("validated candidate\n");
    for (let attempt = 0; attempt < 100 && fs.existsSync(worktree!.path); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(worktree!.path)).toBe(false);
  }, 15_000);

  it("retries a failed rebased conflict at retesting instead of bypassing candidate validation", async () => {
    const dataRoot = temporaryRoot("multi-agent-delivery-conflict-retry-data-");
    const repo = repository();
    const runId = "run-delivery-conflict-retry-1";
    const worktree = await createRunWorktree(repo, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "candidate.txt"), "rebased candidate\n", "utf8");

    const runDir = path.join(dataRoot, "artifacts", "runs", runId);
    fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "evidence", "acceptance.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const run: WorkflowRunRecord = {
      id: runId,
      workflow: "delivery-conflict-retry",
      architecture: "supervisor",
      manifestPath: path.join(runDir, "multi-agent.yaml"),
      artifactDir: runDir,
      status: "passed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      isolation: { mode: "worktree", worktreePath: worktree!.path, baseCommit: worktree!.baseCommit },
      output: { gates: [
        { gateId: "quality-test", requiredCapability: "quality.test", mode: "before-completion", required: true, status: "passed" },
        { gateId: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion", required: true, status: "passed" }
      ] },
      nodes: { tester: {
        nodeId: "tester", roleId: "test-engineer", status: "passed", attempts: 1,
        output: { verdict: "pass", e2eEvidence: [{ method: "browser", steps: "validate", observed: "passed" }] }
      } }
    };
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    const queued = await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "daemon-reviewer"
    });
    await updateRunDelivery(runDir, runId, (current) => ({
      ...current!,
      runId,
      status: "conflict",
      updatedAt: new Date().toISOString(),
      message: "Candidate environment validation failed.",
      conflictResolution: {
        status: "failed",
        targetCommit: queued.delivery.baseCommit!,
        updatedAt: new Date().toISOString(),
        failureClass: "environment-blocked",
        testRunId: "stale-test-run",
        testedSourceCommit: queued.delivery.sourceCommit,
        testedCandidateRevision: "sha256:stale",
        testedUrl: "http://127.0.0.1:4318/",
        leaderReviewRunId: "stale-leader-run",
        message: "Managed preview was unavailable."
      },
      mergeValidation: {
        required: true,
        status: "passed",
        runId: "stale-validation-run",
        targetCommit: "stale-target-commit",
        message: "Stale validation passed for an older target.",
        updatedAt: new Date().toISOString()
      }
    }));

    const service = await WorkbenchService.open({ dataRoot });
    const app = createDaemonApp(service, { staticDir: path.join(dataRoot, "missing-client") });
    const retried = await invokeRoute(app, "post", "/api/runs/:id/merge-conflict-retry", {
      params: { id: runId },
      body: { actor: "daemon-reviewer" }
    });
    expect(retried.status).toBe(202);
    expect(retried.json).toMatchObject({ data: {
      status: "retesting",
      delivery: {
        status: "retesting",
        sourceCommit: queued.delivery.sourceCommit,
        baseCommit: queued.delivery.baseCommit,
        queuedTargetCommit: queued.delivery.queuedTargetCommit,
        conflictResolution: { status: "retesting", targetCommit: queued.delivery.baseCommit }
      }
    } });
    const retriedDelivery = (retried.json as { data: RunMergeQueueResult }).data.delivery;
    expect(retriedDelivery.conflictResolution?.testRunId).toBeUndefined();
    expect(retriedDelivery.conflictResolution?.testedSourceCommit).toBeUndefined();
    expect(retriedDelivery.conflictResolution?.testedCandidateRevision).toBeUndefined();
    expect(retriedDelivery.conflictResolution?.testedUrl).toBeUndefined();
    expect(retriedDelivery.conflictResolution?.leaderReviewRunId).toBeUndefined();
    expect(retriedDelivery.mergeValidation).toMatchObject({
      required: true,
      status: "running",
      targetCommit: queued.delivery.baseCommit,
      message: expect.stringContaining("已失效")
    });
    expect(retriedDelivery.mergeValidation?.runId).toBeUndefined();

    let stopped: RunMergePreview | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await invokeRoute(app, "get", "/api/runs/:id/merge-preview", { params: { id: runId } });
      stopped = (response.json as { data: RunMergePreview }).data;
      if (stopped.status === "conflict" && stopped.delivery?.conflictResolution?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(stopped).toMatchObject({
      status: "conflict",
      delivery: {
        sourceCommit: queued.delivery.sourceCommit,
        conflictResolution: { status: "failed", targetCommit: queued.delivery.baseCommit },
        mergeValidation: {
          required: true,
          status: "failed",
          targetCommit: queued.delivery.baseCommit
        },
        message: expect.stringContaining("候选仍在待合入队列")
      }
    });
    expect(stopped?.delivery?.mergeValidation?.runId).toBeUndefined();
    expect(stopped?.delivery?.mergeValidation?.targetCommit).not.toBe("stale-target-commit");
    expect(git(repo, "rev-parse", "HEAD")).toBe(queued.delivery.baseCommit);
  }, 15_000);
});
