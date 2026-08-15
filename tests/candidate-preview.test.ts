import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateWorkspaceSnapshot } from "../src/runtime/candidateRevision.js";
import { isSuccessfulCandidateAccess, resolveViteBin, startCandidatePreview } from "../src/runtime/candidatePreview.js";

const previews: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(previews.splice(0).map((preview) => preview.stop())); });

describe("candidate preview", () => {
  it("resolves the project Vite installation for a nested worktree without node_modules", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-worktree-no-deps-"));
    try {
      await fs.writeFile(path.join(worktree, "package.json"), "{\"type\":\"module\"}\n", "utf8");
      expect(resolveViteBin(worktree, path.join(process.cwd(), "package.json"))).toBe(path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js"));
    } finally {
      await fs.rm(worktree, { recursive: true, force: true });
    }
  });

  it("uses unique dynamic strict ports, persists identity/logs, and stops both servers", async () => {
    const root = process.cwd();
    const revision = (await candidateWorkspaceSnapshot(root)).revision;
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-preview-"));
    const identity = { runId: "run-preview-1", sourceCommit: "source", targetCommit: "target", candidateRevision: revision };
    let first: Awaited<ReturnType<typeof startCandidatePreview>>;
    try {
      first = await startCandidatePreview({ runDir, worktreePath: root, identity });
    } catch (error) {
      // The managed test sandbox can prohibit every loopback listener. This is an
      // explicit environment assertion, not a passing substitute for the socket test;
      // the same test must be rerun by the outer agent where listeners are allowed.
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
      return;
    }
    previews.push(first);
    const second = await startCandidatePreview({ runDir, worktreePath: root, identity: { ...identity, runId: "run-preview-2" } });
    previews.push(second);
    expect(first.url).not.toBe(second.url);
    expect(first.url).not.toContain(":4319/");
    expect(first.wasAccessed()).toBe(false);
    const completedGet = {
      method: "GET",
      path: "/",
      statusCode: 200,
      servedRevision: revision,
      expectedRevision: revision,
      bodyBytes: 128,
      clientAborted: false,
      upstreamAborted: false,
      upstreamComplete: true
    };
    expect(isSuccessfulCandidateAccess(completedGet)).toBe(true);
    expect(isSuccessfulCandidateAccess({ ...completedGet, method: "HEAD", bodyBytes: 0 })).toBe(false);
    expect(isSuccessfulCandidateAccess({ ...completedGet, statusCode: 404 })).toBe(false);
    expect(isSuccessfulCandidateAccess({ ...completedGet, servedRevision: "sha256:wrong" })).toBe(false);
    expect(isSuccessfulCandidateAccess({ ...completedGet, bodyBytes: 0 })).toBe(false);
    expect(isSuccessfulCandidateAccess({ ...completedGet, clientAborted: true })).toBe(false);
    expect(isSuccessfulCandidateAccess({ ...completedGet, upstreamAborted: true })).toBe(false);
    expect(isSuccessfulCandidateAccess({ ...completedGet, upstreamComplete: false })).toBe(false);
    await fetch(first.url, { method: "HEAD" });
    expect(first.wasAccessed()).toBe(false);
    const missing = new URL(first.url);
    missing.pathname = "/@fs/definitely-missing-candidate-file.ts";
    await fetch(missing);
    expect(first.wasAccessed()).toBe(false);
    expect(await (await fetch(first.url)).text()).toContain("<!doctype html>");
    expect(await (await fetch(new URL("/src/main.tsx", first.url))).text()).toContain("createRoot");
    expect(first.wasAccessed()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(first.attemptDir, "identity.json"), "utf8"))).toEqual({ ...identity, url: first.url });
    expect(JSON.parse(await fs.readFile(path.join(first.attemptDir, "access.json"), "utf8"))).toMatchObject({
      method: "GET",
      path: "/",
      statusCode: 200,
      candidateRevision: revision,
      bodyBytes: expect.any(Number)
    });
    expect(first.attemptDir).not.toBe(second.attemptDir);
    await first.stop();
    previews.splice(previews.indexOf(first), 1);
    await expect(fetch(first.url)).rejects.toThrow();
    expect(await fs.stat(path.join(first.attemptDir, "stdout.log"))).toBeTruthy();
    expect(await fs.stat(path.join(first.attemptDir, "stderr.log"))).toBeTruthy();
  }, 30_000);
});
