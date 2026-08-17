import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject, WorkflowRunRecord } from "../src/core/types.js";
import { createRunWorktree } from "../src/runtime/worktree.js";
import {
  advanceDeliveryEvent,
  previewRunMerge,
  queueAcceptedRun,
  type RunMergePreview
} from "../src/runtime/worktreeDelivery.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
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
  const root = temporaryRoot("multi-agent-mqr-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "delivery-daemon@example.com");
  git(root, "config", "user.name", "Delivery Daemon Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".multi-agent/\nnode_modules/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-m", "seed");
  return root;
}

async function createRunWithWorktree(dataRoot: string, repo: string, runId: string): Promise<{ run: WorkflowRunRecord; runDir: string }> {
  const worktree = await createRunWorktree(repo, runId);
  expect(worktree).not.toBeNull();
  fs.writeFileSync(path.join(worktree!.path, "candidate.txt"), "candidate change\n", "utf8");

  const runDir = path.join(dataRoot, "artifacts", "runs", runId);
  fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "evidence", "acceptance.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const run: WorkflowRunRecord = {
    id: runId,
    workflow: "merge-queue-retest",
    architecture: "supervisor",
    manifestPath: path.join(runDir, "multi-agent.yaml"),
    artifactDir: runDir,
    status: "passed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    isolation: { mode: "worktree", worktreePath: worktree!.path, baseCommit: worktree!.baseCommit },
    output: {
      gates: [
        { gateId: "quality-test", requiredCapability: "quality.test", mode: "before-completion", required: true, status: "passed" },
        { gateId: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion", required: true, status: "passed" }
      ]
    },
    nodes: {
      tester: {
        nodeId: "tester",
        roleId: "test-engineer",
        status: "passed",
        attempts: 1,
        output: { verdict: "pass", e2eEvidence: [{ method: "browser", steps: "validate", observed: "passed" }] }
      }
    }
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return { run, runDir };
}

async function seedInvocation(service: WorkbenchService, runId: string, projectId: string): Promise<void> {
  const invocationId = `inv-${runId}`;
  const timestamp = new Date().toISOString();
  await service.store.mutate((state) => {
    state.invocations[invocationId] = {
      id: invocationId,
      target: { kind: "workflow", id: "merge-queue-retest", version: 1 },
      source: { kind: "workbench", project: projectId },
      status: "completed",
      phase: "completed",
      requestSummary: "merge-queue-retest test",
      runId,
      instanceIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      transitions: []
    };
  });
}

async function advanceTarget(repo: string): Promise<string> {
  fs.writeFileSync(path.join(repo, "target-drift.txt"), "target drifted\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "advance target");
  return git(repo, "rev-parse", "HEAD");
}

async function waitForDispatchFailure(service: WorkbenchService, runId: string, timeoutMs = 15_000): Promise<RunMergePreview> {
  const deadline = Date.now() + timeoutMs;
  const runDir = path.join(service.store.dataRoot, "artifacts", "runs", runId);
  let last: RunMergePreview | undefined;
  while (Date.now() < deadline) {
    await service.recoverDeliveryDispatches();
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as WorkflowRunRecord;
    last = await previewRunMerge(run, runDir);
    if (last.delivery?.dispatch?.lastFailure) return last;
    if (last.delivery?.status === "merged" || last.delivery?.status === "discarded") {
      throw new Error(`delivery settled to ${last.delivery.status} before dispatch failure`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no dispatch failure recorded: ${JSON.stringify(last?.delivery ?? null)}`);
}

async function waitForDeliveryTerminal(service: WorkbenchService, runId: string, timeoutMs = 60_000): Promise<RunMergePreview> {
  const deadline = Date.now() + timeoutMs;
  const runDir = path.join(service.store.dataRoot, "artifacts", "runs", runId);
  let last: RunMergePreview | undefined;
  while (Date.now() < deadline) {
    await service.recoverDeliveryDispatches();
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as WorkflowRunRecord;
    last = await previewRunMerge(run, runDir);
    const status = last.delivery?.status;
    if (status === "merged" || status === "discarded") return last;
    const mv = last.delivery?.mergeValidation;
    if (mv && (mv.status === "failed" || mv.status === "passed")) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`delivery did not reach terminal state: ${JSON.stringify(last?.delivery ?? null)}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const TEST_ROLE_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary"],
  properties: {
    verdict: { type: "string" },
    summary: { type: "string" },
    e2eEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["method", "steps", "observed"],
        properties: {
          method: { type: "string" },
          steps: { type: "string" },
          observed: { type: "string" }
        }
      }
    }
  }
};

/** Creates a repo with the minimum files needed for a candidate preview to start. */
function previewRepository(): string {
  const root = temporaryRoot("multi-agent-mqr-preview-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "delivery-daemon@example.com");
  git(root, "config", "user.name", "Delivery Daemon Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".multi-agent/\nnode_modules\n.vite-cache/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  // Minimal vite setup so startCandidatePreview can serve the worktree.
  fs.mkdirSync(path.join(root, "client"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "client", "vite.config.ts"),
    path.join(root, "client", "vite.config.ts")
  );
  fs.copyFileSync(
    path.join(process.cwd(), "client", "index.html"),
    path.join(root, "client", "index.html")
  );
  fs.mkdirSync(path.join(root, "src", "runtime"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "src", "runtime", "candidateRevision.ts"),
    path.join(root, "src", "runtime", "candidateRevision.ts")
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "mqr-preview-test",
    private: true,
    type: "module"
  }), "utf8");
  // Symlink node_modules so vite and @vitejs/plugin-react resolve from the real project.
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir");
  git(root, "add", "-A");
  git(root, "commit", "-m", "seed preview repo");
  return root;
}

async function setupPreviewTestEnvironment(options: {
  dataRoot: string;
  repo: string;
  runId: string;
  providerInvoke: (invocation: { prompt: string; cwd: string }) => { stdout: string; stderr: string; durationMs: number } | Promise<{ stdout: string; stderr: string; durationMs: number }>;
}): Promise<{ service: WorkbenchService; run: WorkflowRunRecord; runDir: string }> {
  const { run, runDir } = await createRunWithWorktree(options.dataRoot, options.repo, options.runId);
  const providers: ProviderRegistry = new Map([["mqr-test-provider", {
    id: "mqr-test-provider",
    validate: () => [],
    invoke: async (invocation) => options.providerInvoke({
      prompt: invocation.prompt,
      cwd: invocation.cwd
    })
  }]]);
  const service = await WorkbenchService.open({ dataRoot: options.dataRoot, providers });
  await service.putProvider("mqr-test-provider", { adapter: "mqr-test-provider", outputProtocol: "json" });
  await service.createEmployee({
    id: "mqr-tester",
    identity: { displayName: "MQR Tester", background: "Tests.", responsibilities: ["Test"] },
    capabilities: ["quality.test"],
    providerId: "mqr-test-provider",
    outputSchema: TEST_ROLE_OUTPUT_SCHEMA
  });
  await service.createProject({
    id: "mqr-project",
    name: "MQR Project",
    rootPath: options.repo,
    descriptorPath: path.join(options.repo, "multi-agent.project.yaml"),
    roles: [{
      id: "test-engineer",
      displayName: "Test Engineer",
      description: "Runs independent regression tests.",
      instructions: "Run the tests and return a verdict."
    }]
  });
  await service.saveProjectBinding("mqr-project", {
    roles: [{ roleId: "test-engineer", employeeId: "mqr-tester" }]
  });
  await seedInvocation(service, options.runId, "mqr-project");
  return { service, run, runDir };
}

function passOutputWithIdentity(prompt: string): JsonObject {
  // The prompt may pass through JSON serialization, turning real newlines into literal \n.
  const normalized = prompt.replace(/\\n/g, "\n");
  const url = normalized.match(/唯一受管候选 URL：(\S+)/)?.[1] ?? "";
  const sourceCommit = normalized.match(/候选 commit：([0-9a-f]{40})/)?.[1] ?? "";
  const candidateRevision = normalized.match(/候选 revision：(sha256:[0-9a-f]{64})/)?.[1] ?? "";
  return {
    verdict: "pass",
    summary: `CANDIDATE_IDENTITY url=${url}；sourceCommit=${sourceCommit}；candidateRevision=${candidateRevision}。回归通过。`,
    e2eEvidence: [{ method: "browser", steps: "navigate to candidate", observed: "页面可达，交互正常" }]
  };
}

async function providerInvokeWithPromptCapture(
  capturedPrompts: string[],
  prompt: string
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  capturedPrompts.push(prompt);
  // Actually fetch the candidate URL so preview.wasAccessed() is true.
  const normalized = prompt.replace(/\\n/g, "\n");
  const url = normalized.match(/唯一受管候选 URL：(\S+)/)?.[1];
  if (url) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
    } catch {
      // Best-effort access; evidence validation will catch a truly unreachable preview.
    }
  }
  return {
    stdout: JSON.stringify(passOutputWithIdentity(prompt)),
    stderr: "",
    durationMs: 1
  };
}

describe("merge-queue-retest candidate preview", () => {
  it("fails with environment-blocked when the candidate preview cannot start", async () => {
    const dataRoot = temporaryRoot("multi-agent-mqr-data-");
    const repo = repository();
    const runId = "run-mqr-preview-fail-1";
    const { run, runDir } = await createRunWithWorktree(dataRoot, repo, runId);

    const queued = await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "daemon-reviewer"
    });
    expect(queued.delivery.status).toBe("queued-for-merge");

    // Advance the target branch so the dispatcher detects drift.
    await advanceTarget(repo);

    const service = await WorkbenchService.open({ dataRoot });
    await seedInvocation(service, runId, "test-project");

    const settled = await waitForDispatchFailure(service, runId);
    // The preview cannot start in a minimal repo (no client/vite.config.ts), so the
    // merge-queue-retest must record a dispatch failure rather than silently testing the main app.
    const failure = settled.delivery?.dispatch?.lastFailure;
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("Vite");
    // The merge validation must not have passed.
    expect(settled.delivery?.mergeValidation?.status).not.toBe("passed");
    expect(settled.delivery?.status).not.toBe("merged");
  }, 20_000);

  it("starts a candidate preview and injects the unique URL into the retest prompt", async () => {
    const dataRoot = temporaryRoot("multi-agent-mqr-success-data-");
    const repo = previewRepository();
    const runId = "run-mqr-url-inject-1";
    const capturedPrompts: string[] = [];

    const { service, run, runDir } = await setupPreviewTestEnvironment({
      dataRoot,
      repo,
      runId,
      providerInvoke: ({ prompt }) => providerInvokeWithPromptCapture(capturedPrompts, prompt)
    });

    await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "daemon-reviewer"
    });
    await advanceTarget(repo);

    // Wait for the delivery to settle (passed or failed).
    const settled = await waitForDeliveryTerminal(service, runId);
    // The retest passed (merge validation); the actual merge may still be in progress.
    expect(settled.delivery?.mergeValidation?.status).toBe("passed");
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const retestPrompt = capturedPrompts.at(-1)!;
    expect(retestPrompt).toContain("唯一受管候选 URL：http://127.0.0.1:");
    expect(retestPrompt).toContain("CANDIDATE_IDENTITY");
    expect(retestPrompt).toContain("候选 revision：sha256:");
  }, 60_000);

  it("stops the candidate preview in the finally block after retest completes", async () => {
    const dataRoot = temporaryRoot("multi-agent-mqr-cleanup-data-");
    const repo = previewRepository();
    const runId = "run-mqr-cleanup-1";

    const capturedPrompts: string[] = [];
    const { service, run, runDir } = await setupPreviewTestEnvironment({
      dataRoot,
      repo,
      runId,
      providerInvoke: ({ prompt }) => providerInvokeWithPromptCapture(capturedPrompts, prompt)
    });

    await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "daemon-reviewer"
    });
    await advanceTarget(repo);

    const settled = await waitForDeliveryTerminal(service, runId);
    expect(settled.delivery?.mergeValidation?.status).toBe("passed");
    expect(capturedPrompts.length).toBeGreaterThan(0);
    // The validation worktree must be removed (which happens after preview.stop() in finally).
    const validationDir = path.join(repo, ".multi-agent", "merge-validation");
    if (fs.existsSync(validationDir)) {
      const remaining = fs.readdirSync(validationDir);
      expect(remaining).toHaveLength(0);
    }
  }, 30_000);

  it("fails validation when the retest output lacks CANDIDATE_IDENTITY", async () => {
    const dataRoot = temporaryRoot("multi-agent-mqr-evidence-data-");
    const repo = previewRepository();
    const runId = "run-mqr-evidence-1";

    const { service, run, runDir } = await setupPreviewTestEnvironment({
      dataRoot,
      repo,
      runId,
      providerInvoke: () => ({
        // Pass verdict but no CANDIDATE_IDENTITY in summary — evidence validation must reject it.
        stdout: JSON.stringify({
          verdict: "pass",
          summary: "测试通过，但没有身份声明。",
          e2eEvidence: [{ method: "browser", steps: "navigate", observed: "页面可达" }]
        }),
        stderr: "",
        durationMs: 1
      })
    });

    await queueAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main",
      actor: "daemon-reviewer"
    });
    await advanceTarget(repo);

    const settled = await waitForDeliveryTerminal(service, runId);
    // The delivery must not merge because evidence validation failed.
    expect(settled.delivery?.status).not.toBe("merged");
    // The merge validation should have failed.
    expect(settled.delivery?.mergeValidation?.status).toBe("failed");
  }, 30_000);
});
