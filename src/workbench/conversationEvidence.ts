import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConversationDocumentEvidenceMetadata,
  ConversationImageAttachmentInput,
  ConversationImageAttachmentMetadata,
  ConversationImageMediaType
} from "./types.js";

export const MAX_CONVERSATION_IMAGES = 5;
export const MAX_CONVERSATION_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CONVERSATION_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_LARK_DOCUMENTS_PER_MESSAGE = 5;
export const MAX_LARK_DOCUMENT_CONTENT_BYTES = 2 * 1024 * 1024;
export const LARK_DOCUMENT_FETCH_TIMEOUT_MS = 30_000;

const LARK_EXEC_MAX_BUFFER_BYTES = MAX_LARK_DOCUMENT_CONTENT_BYTES + 512 * 1024;
const ATTACHMENT_ID_PATTERN = /^att-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_EXTENSIONS: Record<ConversationImageMediaType, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"]
};

export interface ValidatedConversationImage {
  name: string;
  mediaType: ConversationImageMediaType;
  bytes: Buffer;
  sha256: string;
}

export interface LarkDocumentFetchResult {
  content: string;
  documentId?: string;
  revisionId?: string;
}

export interface LarkDocumentFetcher {
  fetch(url: string): Promise<LarkDocumentFetchResult>;
}

export interface ConversationPromptImage extends ConversationImageAttachmentMetadata {
  absolutePath: string;
}

export interface ConversationPromptDocument extends ConversationDocumentEvidenceMetadata {
  absolutePath?: string;
}

export interface PreparedConversationEvidence {
  attachments: ConversationImageAttachmentMetadata[];
  documents: ConversationDocumentEvidenceMetadata[];
  prompt: {
    sessionId: string;
    attachments: ConversationPromptImage[];
    documents: ConversationPromptDocument[];
  };
}

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type LarkExecFile = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    killSignal: NodeJS.Signals;
  }
) => Promise<ExecFileResult>;

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: Parameters<LarkExecFile>[2]
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class LarkDocumentFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly action: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "LarkDocumentFetchError";
  }
}

function boundedErrorText(value: unknown, maxLength = 1_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
}

function parsedCliError(error: unknown): Record<string, unknown> | undefined {
  const record = errorRecord(error);
  const candidates = [record.stderr, record.stdout, error instanceof Error ? error.message : String(error)];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const envelope = JSON.parse(candidate) as Record<string, unknown>;
      const detail = envelope.error;
      if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
        return detail as Record<string, unknown>;
      }
    } catch {
      // CLI launch errors and older CLI versions may return plain text.
    }
  }
  return undefined;
}

function normalizeCliFailure(error: unknown): LarkDocumentFetchError {
  if (error instanceof LarkDocumentFetchError) return error;
  const record = errorRecord(error);
  if (record.code === "ENOENT") {
    return new LarkDocumentFetchError(
      "lark-cli is not installed or is not available in the daemon PATH.",
      "lark_cli_unavailable",
      "Install lark-cli, restart the daemon so it inherits the updated PATH, then retry.",
      { cause: error }
    );
  }
  if (record.killed === true || record.code === "ETIMEDOUT" || record.signal === "SIGKILL") {
    return new LarkDocumentFetchError(
      `lark-cli document fetch exceeded ${LARK_DOCUMENT_FETCH_TIMEOUT_MS}ms.`,
      "lark_fetch_timeout",
      "Retry the request; if it continues to time out, provide a smaller or directly accessible document.",
      { cause: error }
    );
  }
  if (record.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new LarkDocumentFetchError(
      "lark-cli document output exceeded the configured content buffer.",
      "lark_content_too_large",
      "Provide a smaller document or paste the relevant excerpt into the conversation.",
      { cause: error }
    );
  }
  const detail = parsedCliError(error);
  const detailMessage = boundedErrorText(detail?.message);
  const hint = boundedErrorText(detail?.hint);
  const plain = `${detailMessage} ${hint} ${boundedErrorText(error instanceof Error ? error.message : error)}`.toLowerCase();
  if (/permission|scope|forbidden|access denied|无权限|权限/.test(plain)) {
    return new LarkDocumentFetchError(
      detailMessage || "The authenticated Lark user cannot read this document.",
      "lark_permission_denied",
      hint || "Ask the document owner to grant the authenticated user read access, or authorize the missing docs scope, then retry.",
      { cause: error }
    );
  }
  if (/auth|login|access[_ -]?token|user token|unauth|未登录|登录|授权/.test(plain)) {
    return new LarkDocumentFetchError(
      detailMessage || "lark-cli user authentication is missing or expired.",
      "lark_auth_required",
      hint || "Run lark-cli auth login --domain docs --no-wait --json for the user identity, complete authorization, then retry.",
      { cause: error }
    );
  }
  return new LarkDocumentFetchError(
    detailMessage || boundedErrorText(error instanceof Error ? error.message : error) || "lark-cli document fetch failed.",
    "lark_fetch_failed",
    hint || "Verify the document URL, user login, and document permissions, then retry.",
    { cause: error }
  );
}

export class LarkCliDocumentFetcher implements LarkDocumentFetcher {
  constructor(private readonly run: LarkExecFile = defaultExecFile) {}

  async fetch(url: string): Promise<LarkDocumentFetchResult> {
    let result: ExecFileResult;
    try {
      result = await this.run(
        "lark-cli",
        [
          "docs",
          "+fetch",
          "--doc",
          url,
          "--doc-format",
          "markdown",
          "--detail",
          "simple",
          "--as",
          "user"
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
            LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
          },
          timeout: LARK_DOCUMENT_FETCH_TIMEOUT_MS,
          maxBuffer: LARK_EXEC_MAX_BUFFER_BYTES,
          windowsHide: true,
          killSignal: "SIGKILL"
        }
      );
    } catch (error) {
      throw normalizeCliFailure(error);
    }

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (error) {
      throw new LarkDocumentFetchError(
        "lark-cli returned invalid JSON.",
        "lark_invalid_response",
        "Update lark-cli and retry the document fetch.",
        { cause: error }
      );
    }
    if (envelope.ok !== true || envelope.identity !== "user") {
      throw normalizeCliFailure(Object.assign(new Error("lark-cli returned an unsuccessful user response"), {
        stdout: result.stdout,
        stderr: result.stderr
      }));
    }
    const data = typeof envelope.data === "object" && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : undefined;
    const document = typeof data?.document === "object" && data.document !== null
      ? data.document as Record<string, unknown>
      : undefined;
    if (!document || typeof document.content !== "string") {
      throw new LarkDocumentFetchError(
        "lark-cli response did not contain document content.",
        "lark_invalid_response",
        "Update lark-cli and retry the document fetch."
      );
    }
    const contentBytes = Buffer.byteLength(document.content, "utf8");
    if (contentBytes > MAX_LARK_DOCUMENT_CONTENT_BYTES) {
      throw new LarkDocumentFetchError(
        `Lark document content is ${contentBytes} bytes; the limit is ${MAX_LARK_DOCUMENT_CONTENT_BYTES} bytes.`,
        "lark_content_too_large",
        "Provide a smaller document or paste the relevant excerpt into the conversation."
      );
    }
    const revision = document.revision_id;
    return {
      content: document.content,
      ...(typeof document.document_id === "string" && document.document_id
        ? { documentId: document.document_id }
        : {}),
      ...(typeof revision === "string" || typeof revision === "number"
        ? { revisionId: String(revision) }
        : {})
    };
  }
}

function isAllowedLarkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return ["feishu.cn", "larksuite.com", "larkoffice.com", "doubao.com"]
    .some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;!?\]}，。；！？”’》】）]+$/u, "");
}

export function detectLarkDocumentUrls(message: string): string[] {
  const matches = message.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const original = trimUrlPunctuation(match);
    try {
      const parsed = new URL(original);
      if (!isAllowedLarkHost(parsed.hostname)) continue;
      if (!/^\/(?:docx|wiki)\/[^/?#]+/i.test(parsed.pathname)) continue;
      if (seen.has(original)) continue;
      seen.add(original);
      result.push(original);
    } catch {
      // Natural-language messages often contain URL-like text; malformed values are ignored.
    }
  }
  return result;
}

function validMagic(mediaType: ConversationImageMediaType, bytes: Buffer): boolean {
  if (mediaType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function decodeStrictBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !value) throw new Error(`${label} base64 must be a non-empty string`);
  if (value.startsWith("data:") || /\s/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${label} base64 must be canonical base64 without a data URL prefix or whitespace`);
  }
  const firstPadding = value.indexOf("=");
  const contentLength = firstPadding === -1 ? value.length : firstPadding;
  const paddingLength = value.length - contentLength;
  if (paddingLength > 2 || (paddingLength > 0 && !/^={1,2}$/.test(value.slice(contentLength)))) {
    throw new Error(`${label} base64 padding is invalid`);
  }
  const decodedLength = (value.length / 4) * 3 - paddingLength;
  if (decodedLength > MAX_CONVERSATION_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_CONVERSATION_IMAGE_BYTES} byte limit`);
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!valid) throw new Error(`${label} base64 is invalid`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} base64 is not canonical`);
  return bytes;
}

export function validateConversationImages(value: unknown): ValidatedConversationImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invocation attachments must be an array");
  if (value.length > MAX_CONVERSATION_IMAGES) {
    throw new Error(`invocation attachments support at most ${MAX_CONVERSATION_IMAGES} images`);
  }
  let totalBytes = 0;
  return value.map((candidate, index) => {
    const label = `invocation attachment ${index + 1}`;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`${label} must be an object`);
    }
    const input = candidate as Partial<ConversationImageAttachmentInput> & Record<string, unknown>;
    if (Object.keys(input).some((key) => !["name", "mediaType", "base64"].includes(key))) {
      throw new Error(`${label} contains unsupported fields`);
    }
    if (typeof input.name !== "string"
      || input.name !== input.name.trim()
      || !input.name
      || Buffer.byteLength(input.name, "utf8") > 255
      || /[\u0000-\u001f\u007f/\\]/u.test(input.name)
      || input.name === "."
      || input.name === ".."
      || path.basename(input.name) !== input.name) {
      throw new Error(`${label} name must be a safe 1-255 byte file name without path separators or control characters`);
    }
    if (typeof input.mediaType !== "string" || !Object.hasOwn(MEDIA_EXTENSIONS, input.mediaType)) {
      throw new Error(`${label} mediaType must be image/png, image/jpeg, image/webp, or image/gif`);
    }
    const mediaType = input.mediaType as ConversationImageMediaType;
    const extension = path.extname(input.name).toLowerCase();
    if (!MEDIA_EXTENSIONS[mediaType].includes(extension)) {
      throw new Error(`${label} file extension does not match ${mediaType}`);
    }
    const bytes = decodeStrictBase64(input.base64, label);
    if (bytes.length > MAX_CONVERSATION_IMAGE_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_CONVERSATION_IMAGE_BYTES} byte limit`);
    }
    if (!validMagic(mediaType, bytes)) throw new Error(`${label} bytes do not match ${mediaType}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_CONVERSATION_IMAGE_TOTAL_BYTES) {
      throw new Error(`invocation attachments exceed the ${MAX_CONVERSATION_IMAGE_TOTAL_BYTES} byte total limit`);
    }
    return {
      name: input.name,
      mediaType,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  });
}

function sessionStorageKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function evidenceSessionRoot(dataRoot: string, sessionId: string): string {
  return path.join(dataRoot, "conversation-evidence", "sessions", sessionStorageKey(sessionId));
}

function extensionFor(mediaType: ConversationImageMediaType): string {
  return MEDIA_EXTENSIONS[mediaType][0]!;
}

export function conversationImagePath(
  dataRoot: string,
  sessionId: string,
  attachment: Pick<ConversationImageAttachmentMetadata, "id" | "mediaType">
): string {
  if (!ATTACHMENT_ID_PATTERN.test(attachment.id)) throw new Error("conversation attachment id is invalid");
  return path.join(evidenceSessionRoot(dataRoot, sessionId), "attachments", `${attachment.id}${extensionFor(attachment.mediaType)}`);
}

export function conversationDocumentPath(dataRoot: string, sessionId: string, documentId: string): string {
  if (!/^doc-[0-9a-f-]{36}$/i.test(documentId)) throw new Error("conversation document id is invalid");
  return path.join(evidenceSessionRoot(dataRoot, sessionId), "documents", `${documentId}.md`);
}

async function writeEvidenceFile(filePath: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
}

async function persistDocument(
  dataRoot: string,
  sessionId: string,
  url: string,
  fetcher: LarkDocumentFetcher
): Promise<{ metadata: ConversationDocumentEvidenceMetadata; absolutePath?: string }> {
  const id = `doc-${randomUUID()}`;
  const fetchedAt = new Date().toISOString();
  const metadataPath = path.join(evidenceSessionRoot(dataRoot, sessionId), "documents", `${id}.metadata.json`);
  try {
    const fetched = await fetcher.fetch(url);
    const contentBytes = Buffer.byteLength(fetched.content, "utf8");
    if (contentBytes > MAX_LARK_DOCUMENT_CONTENT_BYTES) {
      throw new LarkDocumentFetchError(
        `Lark document content is ${contentBytes} bytes; the limit is ${MAX_LARK_DOCUMENT_CONTENT_BYTES} bytes.`,
        "lark_content_too_large",
        "Provide a smaller document or paste the relevant excerpt into the conversation."
      );
    }
    const absolutePath = conversationDocumentPath(dataRoot, sessionId, id);
    const metadata: ConversationDocumentEvidenceMetadata = {
      id,
      kind: "lark-document",
      url,
      status: "available",
      fetchedAt,
      ...(fetched.documentId ? { documentId: fetched.documentId } : {}),
      ...(fetched.revisionId ? { revisionId: fetched.revisionId } : {}),
      contentBytes,
      sha256: createHash("sha256").update(fetched.content, "utf8").digest("hex")
    };
    await writeEvidenceFile(absolutePath, fetched.content);
    await writeEvidenceFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return { metadata, absolutePath };
  } catch (error) {
    const failure = normalizeCliFailure(error);
    const metadata: ConversationDocumentEvidenceMetadata = {
      id,
      kind: "lark-document",
      url,
      status: "failed",
      fetchedAt,
      error: { code: failure.code, message: failure.message, action: failure.action }
    };
    await writeEvidenceFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return { metadata };
  }
}

async function persistDocumentLimitEvidence(
  dataRoot: string,
  sessionId: string,
  firstSkippedUrl: string,
  skippedCount: number
): Promise<{ metadata: ConversationDocumentEvidenceMetadata }> {
  const id = `doc-${randomUUID()}`;
  const metadata: ConversationDocumentEvidenceMetadata = {
    id,
    kind: "lark-document",
    url: firstSkippedUrl,
    status: "failed",
    fetchedAt: new Date().toISOString(),
    error: {
      code: "lark_document_limit",
      message: `Detected ${skippedCount} additional Lark document link(s) beyond the per-message limit of ${MAX_LARK_DOCUMENTS_PER_MESSAGE}.`,
      action: `Ask the user to send the remaining document links in batches of at most ${MAX_LARK_DOCUMENTS_PER_MESSAGE}.`
    }
  };
  const metadataPath = path.join(evidenceSessionRoot(dataRoot, sessionId), "documents", `${id}.metadata.json`);
  await writeEvidenceFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { metadata };
}

export async function prepareConversationEvidence(options: {
  dataRoot: string;
  sessionId: string;
  message: string;
  attachments: unknown;
  validatedAttachments?: ValidatedConversationImage[];
  larkDocumentFetcher: LarkDocumentFetcher;
}): Promise<PreparedConversationEvidence> {
  const validated = options.validatedAttachments ?? validateConversationImages(options.attachments);
  const attachmentMetadata: ConversationImageAttachmentMetadata[] = [];
  const promptAttachments: ConversationPromptImage[] = [];
  for (const image of validated) {
    const metadata: ConversationImageAttachmentMetadata = {
      id: `att-${randomUUID()}`,
      kind: "image",
      name: image.name,
      mediaType: image.mediaType,
      sizeBytes: image.bytes.length,
      sha256: image.sha256
    };
    const absolutePath = conversationImagePath(options.dataRoot, options.sessionId, metadata);
    await writeEvidenceFile(absolutePath, image.bytes);
    attachmentMetadata.push(metadata);
    promptAttachments.push({ ...metadata, absolutePath });
  }

  const detectedUrls = detectLarkDocumentUrls(options.message);
  const urls = detectedUrls.slice(0, MAX_LARK_DOCUMENTS_PER_MESSAGE);
  const persistedDocuments = await Promise.all(urls.map((url) => persistDocument(
    options.dataRoot,
    options.sessionId,
    url,
    options.larkDocumentFetcher
  )));
  if (detectedUrls.length > MAX_LARK_DOCUMENTS_PER_MESSAGE) {
    persistedDocuments.push(await persistDocumentLimitEvidence(
      options.dataRoot,
      options.sessionId,
      detectedUrls[MAX_LARK_DOCUMENTS_PER_MESSAGE]!,
      detectedUrls.length - MAX_LARK_DOCUMENTS_PER_MESSAGE
    ));
  }
  return {
    attachments: attachmentMetadata,
    documents: persistedDocuments.map((item) => item.metadata),
    prompt: {
      sessionId: options.sessionId,
      attachments: promptAttachments,
      documents: persistedDocuments.map((item) => ({
        ...item.metadata,
        ...(item.absolutePath ? { absolutePath: item.absolutePath } : {})
      }))
    }
  };
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolvePersistedConversationImage(options: {
  dataRoot: string;
  sessionId: string;
  attachment: ConversationImageAttachmentMetadata;
}): Promise<string> {
  const root = path.resolve(options.dataRoot, "conversation-evidence");
  const expected = conversationImagePath(options.dataRoot, options.sessionId, options.attachment);
  if (!pathInside(root, path.resolve(expected))) throw new Error("conversation attachment path is outside the evidence root");
  let real: string;
  try {
    real = await fs.realpath(expected);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("not a file");
  } catch (error) {
    throw new Error(`conversation attachment not found: ${options.attachment.id}`, { cause: error });
  }
  const realRoot = await fs.realpath(root);
  if (!pathInside(realRoot, real)) throw new Error("conversation attachment path is outside the evidence root");
  return real;
}

export function isConversationAttachmentId(value: string): boolean {
  return ATTACHMENT_ID_PATTERN.test(value);
}
