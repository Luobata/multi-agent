import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface CandidatePreviewIdentity {
  runId: string;
  sourceCommit: string;
  targetCommit: string;
  candidateRevision: string;
  url: string;
}

export interface CandidatePreview extends CandidatePreviewIdentity {
  attemptDir: string;
  wasAccessed(): boolean;
  stop(): Promise<void>;
}

export function isSuccessfulCandidateAccess(input: {
  method: string | undefined;
  path: string;
  statusCode: number | undefined;
  servedRevision: string | undefined;
  expectedRevision: string;
  bodyBytes: number;
  clientAborted: boolean;
  upstreamAborted: boolean;
  upstreamComplete: boolean;
}): boolean {
  return input.method === "GET"
    && input.path === "/"
    && input.statusCode !== undefined
    && input.statusCode >= 200
    && input.statusCode < 300
    && input.servedRevision === input.expectedRevision
    && input.bodyBytes > 0
    && !input.clientAborted
    && !input.upstreamAborted
    && input.upstreamComplete;
}

export function resolveViteBin(worktreePath: string, fallbackPackageJson = path.resolve("package.json")): string {
  const candidates = [path.join(worktreePath, "package.json"), fallbackPackageJson];
  for (const packageJson of candidates) {
    try {
      const require = createRequire(packageJson);
      const vitePackage = require.resolve("vite/package.json");
      return path.join(path.dirname(vitePackage), "bin", "vite.js");
    } catch { /* try the project installation next */ }
  }
  throw new Error(`无法从候选 worktree 或项目根解析本地 Vite 依赖：${worktreePath}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配候选预览端口"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilHealthy(url: string, revision: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "预览尚未响应";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`候选预览提前退出（exit ${child.exitCode}）`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const served = response.headers.get("x-multi-agent-candidate-revision");
      if (response.ok && served === revision) return;
      lastError = `健康检查返回 ${response.status}，revision=${served ?? "missing"}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`候选预览健康检查超时：${lastError}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ]);
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

async function nextAttemptDir(runDir: string): Promise<string> {
  const root = path.join(runDir, "candidate-preview");
  await fs.mkdir(root, { recursive: true });
  for (let number = 1; ; number += 1) {
    const attempt = path.join(root, `attempt-${String(number).padStart(3, "0")}`);
    try { await fs.mkdir(attempt); return attempt; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function startCandidatePreview(input: {
  runDir: string;
  worktreePath: string;
  dependencyRoot?: string;
  identity: Omit<CandidatePreviewIdentity, "url">;
  timeoutMs?: number;
}): Promise<CandidatePreview> {
  const [internalPort, publicPort] = await Promise.all([availablePort(), availablePort()]);
  const internalUrl = `http://127.0.0.1:${internalPort}/`;
  const token = randomBytes(24).toString("hex");
  const url = `http://127.0.0.1:${publicPort}/?candidate-token=${token}`;
  const attemptDir = await nextAttemptDir(input.runDir);
  const stdoutHandle = await fs.open(path.join(attemptDir, "stdout.log"), "a");
  const stderrHandle = await fs.open(path.join(attemptDir, "stderr.log"), "a");
  let child: ChildProcess | undefined;
  let proxy: Server | undefined;
  let accessed = false;
  let accessWrite: Promise<void> | undefined;
  const identity = { ...input.identity, url };
  await fs.writeFile(path.join(attemptDir, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  try {
    child = spawn(process.execPath, [
      resolveViteBin(input.worktreePath, path.join(input.dependencyRoot ?? process.cwd(), "package.json")),
      "--configLoader", "runner", "--config", "client/vite.config.ts",
      "--host", "127.0.0.1", "--port", String(internalPort), "--strictPort"
    ], { cwd: input.worktreePath, stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd] });
    const spawnFailure = new Promise<never>((_, reject) => child!.once("error", reject));
    await Promise.race([waitUntilHealthy(internalUrl, input.identity.candidateRevision, child, input.timeoutMs ?? 30_000), spawnFailure]);
    proxy = http.createServer((request, response) => {
      const incoming = new URL(request.url ?? "/", `http://127.0.0.1:${publicPort}`);
      const proof = incoming.searchParams.get("candidate-token");
      incoming.searchParams.delete("candidate-token");
      const upstreamPath = `${incoming.pathname}${incoming.search}`;
      let clientAborted = false;
      request.once("aborted", () => { clientAborted = true; });
      response.once("close", () => { if (!response.writableFinished) clientAborted = true; });
      const upstream = http.request({
        hostname: "127.0.0.1",
        port: internalPort,
        method: request.method,
        path: upstreamPath,
        headers: { ...request.headers, host: `127.0.0.1:${internalPort}` }
      }, (upstreamResponse) => {
        const revisionHeader = upstreamResponse.headers["x-multi-agent-candidate-revision"];
        const servedRevision = Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader;
        let bodyBytes = 0;
        let upstreamAborted = false;
        upstreamResponse.on("data", (chunk: Buffer | string) => { bodyBytes += Buffer.byteLength(chunk); });
        upstreamResponse.once("aborted", () => { upstreamAborted = true; });
        response.once("finish", () => {
          if (!accessed && proof === token && isSuccessfulCandidateAccess({
            method: request.method,
            path: incoming.pathname,
            statusCode: upstreamResponse.statusCode,
            servedRevision,
            expectedRevision: input.identity.candidateRevision,
            bodyBytes,
            clientAborted,
            upstreamAborted,
            upstreamComplete: upstreamResponse.complete
          })) {
            accessed = true;
            accessWrite = fs.writeFile(path.join(attemptDir, "access.json"), `${JSON.stringify({
              accessedAt: new Date().toISOString(),
              method: request.method,
              path: incoming.pathname,
              statusCode: upstreamResponse.statusCode,
              candidateRevision: servedRevision,
              bodyBytes
            }, null, 2)}\n`, "utf8");
          }
        });
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", (error) => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
      request.pipe(upstream);
    });
    proxy.on("connection", (socket) => socket.unref());
    await new Promise<void>((resolve, reject) => { proxy!.once("error", reject); proxy!.listen(publicPort, "127.0.0.1", resolve); });
  } catch (error) {
    await Promise.allSettled([closeServer(proxy), child ? stopChild(child) : Promise.resolve(), stdoutHandle.close(), stderrHandle.close()]);
    throw error;
  }
  let stopped = false;
  return { ...identity, attemptDir, wasAccessed: () => accessed, async stop() {
    if (stopped) return;
    stopped = true;
    await closeServer(proxy);
    await stopChild(child!);
    await accessWrite;
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  } };
}
