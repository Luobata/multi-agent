import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue, WorkflowRunRecord } from "../core/types.js";
import type { Checkpoint, ExecutionBudgetSnapshot } from "./governance.js";

export interface RunEvent {
  at: string;
  type: string;
  nodeId?: string;
  detail?: JsonValue;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export class RunStore {
  private static indexQueue: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();
  private runQueue: Promise<void> = Promise.resolve();
  private sidecarQueue: Promise<void> = Promise.resolve();

  constructor(public readonly runDir: string) {}

  static async create(artifactRoot: string, runId: string): Promise<RunStore> {
    const runDir = path.join(artifactRoot, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    return new RunStore(runDir);
  }

  async writeInput(input: JsonValue): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir, "input.json"), input);
  }

  async writePlan(plan: unknown): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir, "plan.json"), plan);
  }

  async writeArtifact(relativePath: string, value: unknown): Promise<void> {
    if (path.isAbsolute(relativePath)) throw new Error("run artifact path must be relative");
    const target = path.resolve(this.runDir, relativePath);
    const relative = path.relative(this.runDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("run artifact path must stay inside the run directory");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeJsonAtomic(target, value);
  }

  async writeRun(run: WorkflowRunRecord): Promise<void> {
    const snapshot = structuredClone(run);
    this.runQueue = this.runQueue.then(async () => {
      await writeJsonAtomic(path.join(this.runDir, "run.json"), snapshot);
      await this.updateRunIndex(snapshot);
    });
    await this.runQueue;
  }

  async readArtifact<T>(relativePath: string): Promise<T> {
    return JSON.parse(await fs.readFile(path.join(this.runDir, relativePath), "utf8")) as T;
  }

  async readCheckpoint<T>(): Promise<Checkpoint<T> | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.runDir, "checkpoint.json"), "utf8")) as Checkpoint<T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Run checkpoint is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async commitCheckpoint<T>(next: Checkpoint<T>, expectedRevision: number): Promise<void> {
    let failure: unknown;
    this.sidecarQueue = this.sidecarQueue.then(async () => {
      const current = await this.readCheckpoint<T>();
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error("checkpoint revision conflict");
      if (current && next.fencingToken < current.fencingToken) throw new Error("checkpoint fencing token is stale");
      await writeJsonAtomic(path.join(this.runDir, "checkpoint.json"), next);
    }).catch((error) => { failure = error; });
    await this.sidecarQueue;
    if (failure) throw failure;
  }

  async writeRunManifest(value: { budget?: ExecutionBudgetSnapshot; checkpointRevision: number }): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir, "run-manifest.json"), value);
  }

  private async updateRunIndex(run: WorkflowRunRecord): Promise<void> {
    let failure: unknown;
    RunStore.indexQueue = RunStore.indexQueue.then(async () => {
      const runsRoot = path.dirname(this.runDir);
      const indexPath = path.join(runsRoot, "index.json");
      let records: Record<string, WorkflowRunRecord> = {};
      try { records = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<string, WorkflowRunRecord>; } catch { /* rebuild below */ }
      records[run.id] = run;
      await writeJsonAtomic(indexPath, records);
    }).catch((error) => { failure = error; });
    await RunStore.indexQueue;
    if (failure) throw failure;
  }

  static async listIndexed(runsRoot: string): Promise<WorkflowRunRecord[]> {
    const indexPath = path.join(runsRoot, "index.json");
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<string, WorkflowRunRecord>;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid run index");
      return Object.values(parsed);
    } catch {
      let entries: string[];
      try { entries = await fs.readdir(runsRoot); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const records: Record<string, WorkflowRunRecord> = {};
      for (const entry of entries.filter((value) => value !== "index.json")) {
        try {
          const run = JSON.parse(await fs.readFile(path.join(runsRoot, entry, "run.json"), "utf8")) as WorkflowRunRecord;
          records[run.id] = run;
        } catch { /* a broken run is not allowed to poison the rebuild */ }
      }
      await writeJsonAtomic(indexPath, records);
      return Object.values(records);
    }
  }

  async appendEvent(event: RunEvent): Promise<void> {
    this.eventQueue = this.eventQueue.then(() =>
      fs.appendFile(path.join(this.runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8")
    );
    await this.eventQueue;
  }

  async createAttempt(nodeId: string, attempt: number): Promise<string> {
    const attemptDir = path.join(this.runDir, "nodes", nodeId, `attempt-${attempt}`);
    await fs.mkdir(attemptDir, { recursive: true });
    return attemptDir;
  }

  async writeText(attemptDir: string, fileName: string, value: string): Promise<void> {
    await fs.writeFile(path.join(attemptDir, fileName), value, "utf8");
  }

  async writeAttemptJson(attemptDir: string, fileName: string, value: unknown): Promise<void> {
    await writeJsonAtomic(path.join(attemptDir, fileName), value);
  }
}
