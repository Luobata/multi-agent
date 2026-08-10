import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/core/types.js";
import { createRunWorktree } from "../src/runtime/worktree.js";
import {
  discardRunWorktree,
  keepRunWorktree,
  mergeAcceptedRun,
  openManagedRunWorktree,
  previewRunMerge,
  readRunDelivery
} from "../src/runtime/worktreeDelivery.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return fs.realpathSync(root);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = temporaryRoot("multi-agent-delivery-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "delivery@example.com");
  git(root, "config", "user.name", "Delivery Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".multi-agent/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-m", "seed");
  return root;
}

function runRecord(runId: string, runDir: string, worktreePath: string, baseCommit: string): WorkflowRunRecord {
  return {
    id: runId,
    workflow: "delivery-test",
    architecture: "supervisor",
    manifestPath: path.join(runDir, "multi-agent.yaml"),
    artifactDir: runDir,
    status: "passed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    isolation: { mode: "worktree", worktreePath, baseCommit },
    output: {
      summary: "Ready for acceptance.",
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
      verify: {
        nodeId: "verify",
        roleId: "test-engineer",
        status: "passed",
        attempts: 1,
        output: {
          verdict: "pass",
          e2eEvidence: [{ method: "browser", steps: "Open the flow", observed: "Expected result" }]
        }
      }
    }
  };
}

function artifactDirectory(): string {
  const root = temporaryRoot("multi-agent-delivery-artifact-");
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(root, "evidence", "acceptance.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("worktree delivery merge gate", () => {
  it("opens only the validated managed Run worktree through an argv-safe desktop boundary", async () => {
    const root = repository();
    const runId = "run-delivery-open-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
    const opened: string[] = [];

    await expect(openManagedRunWorktree(run, async (candidate) => { opened.push(candidate); })).resolves.toEqual({
      runId,
      worktreePath: worktree!.path,
      repositoryRoot: root
    });
    expect(opened).toEqual([worktree!.path]);

    await expect(openManagedRunWorktree({ ...run, isolation: { mode: "none" } }, async () => undefined))
      .rejects.toThrow(/没有可打开的 worktree/);
  }, 15_000);

  it("keeps preview read-only and merges only after the exact run confirmation", async () => {
    const root = repository();
    const runId = "run-delivery-preview-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "feature.txt"), "accepted\n", "utf8");
    git(worktree!.path, "add", "feature.txt");
    git(worktree!.path, "commit", "-m", "agent committed feature");
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
    const headBefore = git(root, "rev-parse", "HEAD");
    const refsBefore = git(root, "show-ref");

    const preview = await previewRunMerge(run, runDir);

    expect(preview).toMatchObject({
      eligible: true,
      status: "awaiting-acceptance",
      targetBranch: "main",
      targetClean: true,
      changes: { fileCount: 1 },
      evidence: { acceptedVerdict: true, structuredE2eCount: 1 }
    });
    expect(preview.evidence.assets).toEqual([
      expect.objectContaining({ kind: "screenshot", name: "acceptance.png" })
    ]);
    expect(preview.changes.unifiedDiff).toMatchObject({
      text: expect.stringContaining("feature.txt"),
      truncated: false,
      maxBytes: expect.any(Number)
    });
    expect(preview.safeGitCommands).toEqual(expect.arrayContaining([
      expect.stringContaining(" status --short --branch"),
      expect.stringContaining(" diff --no-ext-diff --no-color ")
    ]));
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(root, "show-ref")).toBe(refsBefore);
    expect(fs.existsSync(path.join(runDir, "delivery.json"))).toBe(false);

    await expect(mergeAcceptedRun(run, runDir, {
      confirmation: "MERGE another-run",
      targetBranch: "main"
    })).rejects.toThrow(/明确合并确认/);
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);

    const result = await mergeAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main"
    });

    expect(result.status).toBe("merged");
    expect(fs.readFileSync(path.join(root, "feature.txt"), "utf8")).toBe("accepted\n");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(headBefore);
    expect(fs.existsSync(worktree!.path)).toBe(false);
    await expect(readRunDelivery(runDir)).resolves.toMatchObject({
      runId,
      status: "merged",
      targetBranch: "main",
      mergeCommit: expect.any(String)
    });
  }, 15_000);

  it("preflights conflicts without changing the target branch and preserves the worktree", async () => {
    const root = repository();
    const runId = "run-delivery-conflict-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "README.md"), "source change\n", "utf8");
    fs.writeFileSync(path.join(root, "README.md"), "target change\n", "utf8");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "target change");
    const targetHead = git(root, "rev-parse", "HEAD");
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);

    const result = await mergeAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main"
    });

    expect(result.status).toBe("conflict");
    expect(result.delivery.message).toMatch(/conflict/i);
    expect(git(root, "rev-parse", "HEAD")).toBe(targetHead);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("target change\n");
    expect(fs.existsSync(worktree!.path)).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("");
  }, 15_000);

  it("withholds merge when run status, acceptance, media, or worktree changes are missing", async () => {
    const root = repository();
    const runId = "run-delivery-not-ready-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    const runDir = temporaryRoot("multi-agent-delivery-empty-artifact-");
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
    run.status = "blocked";
    run.output = {
      gates: [
        {
          gateId: "quality-test", requiredCapability: "quality.test", mode: "before-completion",
          required: true, status: "blocked"
        },
        {
          gateId: "quality-audit", requiredCapability: "quality.audit", mode: "before-completion",
          required: true, status: "blocked"
        }
      ]
    };
    run.nodes.verify!.output = {};

    const preview = await previewRunMerge(run, runDir);

    expect(preview.eligible).toBe(false);
    expect(preview.reasons.join(" ")).toMatch(/尚未通过/);
    expect(preview.reasons.join(" ")).toMatch(/Gate/);
    expect(preview.reasons.join(" ")).toMatch(/验收证据/);
    expect(preview.reasons.join(" ")).toMatch(/没有可合并/);
  }, 15_000);

  it("does not let an acceptedVerdict bypass either strict worktree Gate", async () => {
    const root = repository();
    const runId = "run-delivery-no-verdict-bypass-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "feature.txt"), "candidate\n", "utf8");
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
    const gates = (run.output as { gates: Array<{ requiredCapability: string; status: string }> }).gates;
    gates.find((gate) => gate.requiredCapability === "quality.audit")!.status = "blocked";

    const preview = await previewRunMerge(run, runDir);

    expect(preview.evidence.acceptedVerdict).toBe(true);
    expect(preview.eligible).toBe(false);
    expect(preview.reasons.join(" ")).toMatch(/quality\.audit/);
  }, 15_000);

  it("records keep and requires an exact, non-repeatable discard that removes only the managed candidate", async () => {
    const root = repository();
    const runId = "run-delivery-discard-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    const sourceBranch = `codex/${runId}`;
    git(worktree!.path, "switch", "-c", sourceBranch);
    fs.writeFileSync(path.join(worktree!.path, "feature.txt"), "discard me\n", "utf8");
    git(worktree!.path, "add", "feature.txt");
    git(worktree!.path, "commit", "-m", "candidate to discard");
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
    const runJson = `${JSON.stringify(run, null, 2)}\n`;
    fs.writeFileSync(path.join(runDir, "run.json"), runJson, "utf8");

    await expect(keepRunWorktree(run, runDir, { actor: "reviewer", note: "inspect later" }))
      .resolves.toMatchObject({ status: "kept", delivery: { humanDecision: { action: "keep", actor: "reviewer" } } });
    expect(fs.existsSync(worktree!.path)).toBe(true);

    await expect(discardRunWorktree(run, runDir, {
      confirmation: "DISCARD another-run",
      actor: "reviewer"
    })).rejects.toThrow(/精确丢弃确认/);
    expect(fs.existsSync(worktree!.path)).toBe(true);

    await expect(discardRunWorktree(run, runDir, {
      confirmation: `DISCARD ${runId}`,
      actor: "reviewer",
      note: "candidate rejected"
    })).resolves.toMatchObject({
      status: "discarded",
      delivery: { status: "discarded", humanDecision: { action: "discard", actor: "reviewer" } }
    });
    expect(fs.existsSync(worktree!.path)).toBe(false);
    expect(git(root, "branch", "--list", sourceBranch)).toBe("");
    expect(fs.readFileSync(path.join(runDir, "run.json"), "utf8")).toBe(runJson);
    await expect(discardRunWorktree(run, runDir, {
      confirmation: `DISCARD ${runId}`,
      actor: "reviewer"
    })).rejects.toThrow(/已经丢弃|重复/);
  }, 15_000);

  it("refuses discard when the candidate commit is already merged", async () => {
    const root = repository();
    const runId = "run-delivery-discard-merged-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    const sourceBranch = `codex/${runId}`;
    git(worktree!.path, "switch", "-c", sourceBranch);
    fs.writeFileSync(path.join(worktree!.path, "feature.txt"), "already merged\n", "utf8");
    git(worktree!.path, "add", "feature.txt");
    git(worktree!.path, "commit", "-m", "merged candidate");
    git(root, "merge", "--no-ff", "--no-edit", sourceBranch);
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);

    await expect(discardRunWorktree(run, runDir, {
      confirmation: `DISCARD ${runId}`,
      actor: "reviewer"
    })).rejects.toThrow(/已经合并/);
    expect(fs.existsSync(worktree!.path)).toBe(true);
    expect(git(root, "branch", "--list", sourceBranch)).toContain(sourceBranch);
  }, 15_000);

  it("rejects a delivery record whose source branch provenance was tampered with", async () => {
    const root = repository();
    const runId = "run-delivery-tampered-1";
    const worktree = await createRunWorktree(root, runId);
    expect(worktree).not.toBeNull();
    fs.writeFileSync(path.join(worktree!.path, "feature.txt"), "candidate\n", "utf8");
    const runDir = artifactDirectory();
    const run = runRecord(runId, runDir, worktree!.path, worktree!.baseCommit);
    fs.writeFileSync(path.join(runDir, "delivery.json"), `${JSON.stringify({
      runId,
      status: "awaiting-acceptance",
      updatedAt: new Date().toISOString(),
      baseCommit: worktree!.baseCommit,
      sourceBranch: "codex/unrelated-run",
      sourceCommit: worktree!.baseCommit,
      targetBranch: "main"
    }, null, 2)}\n`, "utf8");
    const headBefore = git(root, "rev-parse", "HEAD");

    await expect(mergeAcceptedRun(run, runDir, {
      confirmation: `MERGE ${runId}`,
      targetBranch: "main"
    })).rejects.toThrow(/交付记录与当前 Run 不匹配/);
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(fs.existsSync(worktree!.path)).toBe(true);
  }, 15_000);
});
