import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  KnowledgeBaseDefinition,
  KnowledgeDocumentDefinition,
  KnowledgeIndex,
  KnowledgeIndexChunk,
  KnowledgeRevision,
  KnowledgeSourceDefinition
} from "./types.js";

const DEFAULT_EXTENSIONS = [".md", ".mdx", ".txt", ".json", ".yaml", ".yml"];
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_DOCUMENTS = 2_000;
const MAX_CHUNK_CHARACTERS = 1_200;

function safeSegment(value: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error(`invalid knowledge path segment: ${value}`);
  return value;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function tokenizeKnowledgeText(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  const hanRuns = normalized.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of hanRuns) {
    const characters = [...run];
    tokens.push(...characters);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.push(`${characters[index]}${characters[index + 1]}`);
    }
  }
  const words = normalized
    .replaceAll(/\p{Script=Han}+/gu, " ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  tokens.push(...words);
  return unique(tokens);
}

/**
 * Tokens allowed to open an on-demand Collection or count as a retrieval hit.
 * Single Han characters are retained in the index for ranking, but are too noisy
 * to expand an Employee's knowledge scope by themselves.
 */
export function knowledgeQueryTokens(value: string): string[] {
  return tokenizeKnowledgeText(value).filter((token) => {
    const characters = [...token];
    if (characters.every((character) => /\p{Script=Han}/u.test(character))) return characters.length >= 2;
    return characters.length >= 2;
  });
}

function splitLongBlock(value: string): string[] {
  const pieces: string[] = [];
  let remaining = value.trim();
  while (remaining.length > MAX_CHUNK_CHARACTERS) {
    let boundary = remaining.lastIndexOf("\n", MAX_CHUNK_CHARACTERS);
    if (boundary < MAX_CHUNK_CHARACTERS / 2) boundary = remaining.lastIndexOf("。", MAX_CHUNK_CHARACTERS);
    if (boundary < MAX_CHUNK_CHARACTERS / 2) boundary = remaining.lastIndexOf(". ", MAX_CHUNK_CHARACTERS);
    if (boundary < MAX_CHUNK_CHARACTERS / 2) boundary = MAX_CHUNK_CHARACTERS;
    pieces.push(remaining.slice(0, boundary + 1).trim());
    remaining = remaining.slice(boundary + 1).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

function chunkDocument(document: KnowledgeDocumentDefinition): KnowledgeIndexChunk[] {
  const blocks = document.content
    .split(/\n\s*\n/g)
    .flatMap(splitLongBlock)
    .filter(Boolean);
  const grouped: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;
    if (current && next.length > MAX_CHUNK_CHARACTERS) {
      grouped.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) grouped.push(current);
  if (grouped.length === 0 && document.content.trim()) grouped.push(document.content.trim());
  return grouped.map((content, index) => ({
    id: `${document.id}-${index + 1}`,
    documentId: document.id,
    collectionId: document.collectionId,
    title: document.title,
    content,
    sourceRef: document.sourceRef,
    metadata: document.metadata,
    tokens: tokenizeKnowledgeText(`${document.title}\n${content}`)
  }));
}

function buildIndex(revision: KnowledgeRevision): KnowledgeIndex {
  return {
    knowledgeBaseId: revision.knowledgeBaseId,
    revision: revision.revision,
    chunks: revision.documents.flatMap(chunkDocument),
    createdAt: revision.createdAt
  };
}

function normalizeStoredRevision(revision: KnowledgeRevision): KnowledgeRevision {
  return {
    ...revision,
    documents: revision.documents.map((document, index) => ({
      ...document,
      order: Number.isInteger(document.order) && document.order >= 0 ? document.order : index,
      references: Array.isArray(document.references) ? document.references : []
    }))
  };
}

async function collectDirectoryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
      if (files.length > MAX_SOURCE_DOCUMENTS) {
        throw new Error(`knowledge source ${root} exceeds ${MAX_SOURCE_DOCUMENTS} documents`);
      }
    }
  };
  await visit(root);
  return files;
}

function sourceDocumentId(source: KnowledgeSourceDefinition, relativePath: string): string {
  const digest = createHash("sha256").update(relativePath).digest("hex").slice(0, 12);
  return `${source.id}-${digest}`;
}

async function readSourceDocument(
  source: KnowledgeSourceDefinition,
  filePath: string,
  relativePath: string
): Promise<KnowledgeDocumentDefinition> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`knowledge source file exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${filePath}`);
  }
  return {
    id: sourceDocumentId(source, relativePath),
    title: relativePath.split(path.sep).join("/"),
    content: await fs.readFile(filePath, "utf8"),
    collectionId: source.collectionId,
    sourceId: source.id,
    sourceRef: filePath,
    order: 0,
    references: [],
    metadata: { relativePath: relativePath.split(path.sep).join("/") },
    updatedAt: stat.mtime.toISOString()
  };
}

export class KnowledgeStore {
  constructor(public readonly root: string) {}

  static async open(dataRoot: string): Promise<KnowledgeStore> {
    const root = path.join(dataRoot, "knowledge");
    await fs.mkdir(root, { recursive: true });
    return new KnowledgeStore(root);
  }

  private revisionPath(knowledgeBaseId: string, revision: number): string {
    return path.join(this.root, safeSegment(knowledgeBaseId), "revisions", `${revision}.json`);
  }

  private indexPath(knowledgeBaseId: string, revision: number): string {
    return path.join(this.root, safeSegment(knowledgeBaseId), "indexes", `${revision}.json`);
  }

  async writeRevision(revision: KnowledgeRevision): Promise<void> {
    const revisionPath = this.revisionPath(revision.knowledgeBaseId, revision.revision);
    try {
      await fs.access(revisionPath);
      throw new Error(`knowledge revision already exists: ${revision.knowledgeBaseId}@${revision.revision}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeJsonAtomic(revisionPath, revision);
    await writeJsonAtomic(this.indexPath(revision.knowledgeBaseId, revision.revision), buildIndex(revision));
  }

  async readRevision(knowledgeBaseId: string, revision: number): Promise<KnowledgeRevision> {
    return normalizeStoredRevision(
      JSON.parse(await fs.readFile(this.revisionPath(knowledgeBaseId, revision), "utf8")) as KnowledgeRevision
    );
  }

  async readIndex(knowledgeBaseId: string, revision: number): Promise<KnowledgeIndex> {
    return JSON.parse(await fs.readFile(this.indexPath(knowledgeBaseId, revision), "utf8")) as KnowledgeIndex;
  }

  async collectSources(knowledgeBase: KnowledgeBaseDefinition): Promise<KnowledgeDocumentDefinition[]> {
    const documents: KnowledgeDocumentDefinition[] = [];
    for (const source of knowledgeBase.sources) {
      const extensions = new Set((source.includeExtensions?.length ? source.includeExtensions : DEFAULT_EXTENSIONS)
        .map((extension) => extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`));
      const location = path.resolve(source.location);
      const files = source.kind === "file" ? [location] : await collectDirectoryFiles(location);
      for (const filePath of files) {
        if (!extensions.has(path.extname(filePath).toLowerCase())) continue;
        const relativePath = source.kind === "file" ? path.basename(filePath) : path.relative(location, filePath);
        documents.push(await readSourceDocument(source, filePath, relativePath));
      }
    }
    return documents.map((document, index) => ({ ...document, order: index }));
  }
}
