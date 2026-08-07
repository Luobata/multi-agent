// src/memory/store.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord, MemoryScope } from "./types.js";

interface ScopeIndex {
  scopeKey: string;
  memoryIds: string[];
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) throw new Error(`invalid memory id: ${value}`);
  return value;
}

function scopeKeyToFileName(scopeKey: string): string {
  // "employee:researcher" -> "employee__researcher.json"，且校验各段
  const [dimension = "", ...rest] = scopeKey.split(":");
  const id = rest.join(":");
  if (!/^[a-z]+$/.test(dimension)) throw new Error(`invalid scope dimension: ${dimension}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`invalid scope id: ${id}`);
  return `${dimension}__${id}.json`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class MemoryStore {
  private constructor(private readonly root: string) {}

  static async open(dataRoot: string): Promise<MemoryStore> {
    const root = path.join(dataRoot, "memory");
    await fs.mkdir(path.join(root, "records"), { recursive: true });
    await fs.mkdir(path.join(root, "index"), { recursive: true });
    return new MemoryStore(root);
  }

  get dataRoot(): string {
    return this.root;
  }

  static scopeKeys(scope: MemoryScope): string[] {
    const keys = [`employee:${scope.employeeId}`];
    if (scope.projectId) keys.push(`project:${scope.projectId}`);
    return keys;
  }

  private recordPath(id: string): string {
    return path.join(this.root, "records", `${safeId(id)}.json`);
  }

  private indexPath(scopeKey: string): string {
    return path.join(this.root, "index", scopeKeyToFileName(scopeKey));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return readJson<MemoryRecord>(this.recordPath(id));
  }

  async put(record: MemoryRecord): Promise<void> {
    await writeJsonAtomic(this.recordPath(record.id), record);
    for (const scopeKey of MemoryStore.scopeKeys(record.scope)) {
      const index = (await readJson<ScopeIndex>(this.indexPath(scopeKey))) ?? { scopeKey, memoryIds: [] };
      if (!index.memoryIds.includes(record.id)) {
        index.memoryIds.push(record.id);
        await writeJsonAtomic(this.indexPath(scopeKey), index);
      }
    }
  }

  async archive(id: string): Promise<MemoryRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    const updated: MemoryRecord = { ...record, status: "archived" };
    await writeJsonAtomic(this.recordPath(id), updated);
    return updated;
  }

  async listByScope(scopeKey: string): Promise<MemoryRecord[]> {
    const index = await readJson<ScopeIndex>(this.indexPath(scopeKey));
    if (!index) return [];
    const records: MemoryRecord[] = [];
    for (const id of index.memoryIds) {
      const record = await this.get(id);
      if (record) records.push(record);
    }
    return records;
  }

  async listScopes(): Promise<Array<{ scopeKey: string; count: number }>> {
    const indexDir = path.join(this.root, "index");
    let files: string[];
    try {
      files = (await fs.readdir(indexDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const scopes: Array<{ scopeKey: string; count: number }> = [];
    for (const file of files) {
      const index = await readJson<ScopeIndex>(path.join(indexDir, file));
      if (!index) continue;
      scopes.push({ scopeKey: index.scopeKey, count: index.memoryIds.length });
    }
    scopes.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
    return scopes;
  }

  async reindex(): Promise<number> {
    const recordsDir = path.join(this.root, "records");
    const indexDir = path.join(this.root, "index");
    await fs.rm(indexDir, { recursive: true, force: true });
    await fs.mkdir(indexDir, { recursive: true });
    const files = (await fs.readdir(recordsDir)).filter((name) => name.endsWith(".json"));
    let count = 0;
    for (const file of files) {
      const record = await readJson<MemoryRecord>(path.join(recordsDir, file));
      if (!record) continue;
      count += 1;
      for (const scopeKey of MemoryStore.scopeKeys(record.scope)) {
        const index = (await readJson<ScopeIndex>(this.indexPath(scopeKey))) ?? { scopeKey, memoryIds: [] };
        if (!index.memoryIds.includes(record.id)) index.memoryIds.push(record.id);
        await writeJsonAtomic(this.indexPath(scopeKey), index);
      }
    }
    return count;
  }
}
