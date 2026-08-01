import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue, WorkflowRunRecord } from "../core/types.js";

export interface RunEvent {
  at: string;
  type: string;
  nodeId?: string;
  detail?: JsonValue;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export class RunStore {
  private eventQueue: Promise<void> = Promise.resolve();
  private runQueue: Promise<void> = Promise.resolve();

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
    this.runQueue = this.runQueue.then(() => writeJsonAtomic(path.join(this.runDir, "run.json"), snapshot));
    await this.runQueue;
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
