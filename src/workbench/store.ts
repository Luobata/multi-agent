import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchState } from "./types.js";

function initialState(): WorkbenchState {
  return {
    schemaVersion: 1,
    providers: {
      mock: {
        adapter: "mock",
        model: "deterministic-mock",
        outputProtocol: "json"
      }
    },
    skills: {},
    skillHistory: {},
    employees: {},
    workflows: {},
    sessions: {},
    publications: {},
    invocations: {},
    workInstances: {}
  };
}

function normalizeState(state: WorkbenchState): WorkbenchState {
  if (state.providers.mock?.adapter === "mock" && state.providers.mock.model === undefined) {
    state.providers.mock.model = "deterministic-mock";
  }
  state.skillHistory ??= Object.fromEntries(
    Object.entries(state.skills).map(([id, skill]) => [id, [skill]])
  );
  state.invocations ??= {};
  state.workInstances ??= {};
  for (const skill of Object.values(state.skills)) skill.status ??= "active";
  for (const versions of Object.values(state.skillHistory)) {
    for (const skill of versions) skill.status ??= "active";
  }
  for (const record of Object.values(state.employees)) {
    for (const employee of record.versions) {
      employee.skillVersions ??= Object.fromEntries(
        employee.skills.map((binding) => {
          const id = typeof binding === "string" ? binding : binding.id;
          return [id, state.skills[id]?.version ?? 1];
        })
      );
    }
    record.current = record.versions.find((employee) => employee.version === record.current.version) ?? record.current;
    record.current.skillVersions ??= Object.fromEntries(
      record.current.skills.map((binding) => {
        const id = typeof binding === "string" ? binding : binding.id;
        return [id, state.skills[id]?.version ?? 1];
      })
    );
  }
  return state;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      return async () => {
        await handle.close();
        await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.min(attempt, 40)));
    }
  }
  throw new Error(`timed out waiting for Workbench state lock: ${lockPath}`);
}

export class WorkbenchStore {
  private state: WorkbenchState;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly dataRoot: string,
    state: WorkbenchState
  ) {
    this.state = state;
  }

  static async open(dataRoot: string): Promise<WorkbenchStore> {
    const resolvedRoot = path.resolve(dataRoot);
    await fs.mkdir(resolvedRoot, { recursive: true });
    const statePath = path.join(resolvedRoot, "state.json");
    let state: WorkbenchState;
    try {
      state = normalizeState(JSON.parse(await fs.readFile(statePath, "utf8")) as WorkbenchState);
      if (state.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(state.schemaVersion)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = initialState();
      await writeJsonAtomic(statePath, state);
    }
    return new WorkbenchStore(resolvedRoot, state);
  }

  snapshot(): WorkbenchState {
    const latest = normalizeState(JSON.parse(readFileSync(path.join(this.dataRoot, "state.json"), "utf8")) as WorkbenchState);
    if (latest.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
    this.state = latest;
    return structuredClone(this.state);
  }

  async mutate<T>(mutation: (state: WorkbenchState) => T | Promise<T>): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    this.mutationQueue = this.mutationQueue.then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireFileLock(path.join(this.dataRoot, "state.lock"));
        const latest = normalizeState(JSON.parse(await fs.readFile(path.join(this.dataRoot, "state.json"), "utf8")) as WorkbenchState);
        if (latest.schemaVersion !== 1) throw new Error(`unsupported workbench schema version ${String(latest.schemaVersion)}`);
        const next = structuredClone(latest);
        result = await mutation(next);
        await writeJsonAtomic(path.join(this.dataRoot, "state.json"), next);
        this.state = next;
      } catch (error) {
        failure = error;
      } finally {
        await release?.();
      }
    });
    await this.mutationQueue;
    if (failure) throw failure;
    return result as T;
  }
}
