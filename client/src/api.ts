import type { InvocationProgress, InvocationRecord, Session } from "./types";

interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

const encodedMetadataHeaders = new Set([
  "x-multi-agent-source-label",
  "x-multi-agent-project",
  "x-multi-agent-caller",
  "x-multi-agent-context"
]);

export function encodeMetadataHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `utf8:${encodeURIComponent(value)}`;
}

function headerEntries(headers?: HeadersInit): Array<[string, string]> {
  if (!headers) return [];
  if (headers instanceof Headers) return Array.from(headers.entries());
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value]);
  return Object.entries(headers);
}

function requestHeaders(init?: RequestInit): Headers | undefined {
  const entries = headerEntries(init?.headers);
  if (!init?.body && entries.length === 0) return undefined;
  const headers = new Headers();
  for (const [name, value] of entries) {
    headers.append(name, encodedMetadataHeaders.has(name.toLowerCase()) ? encodeMetadataHeaderValue(value) : value);
  }
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

export async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: requestHeaders(init)
  });
  let envelope: Envelope<T>;
  try {
    envelope = await response.json() as Envelope<T>;
  } catch {
    throw new Error(`服务返回了无法识别的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return envelope.data as T;
}

export function writeBody(value: unknown, method: "POST" | "PATCH" | "PUT" = "POST"): RequestInit {
  return { method, body: JSON.stringify(value) };
}

/** Client mirror of the 202 receipt returned by POST .../start (src/workbench/service.ts). */
export interface InvocationStartReceipt {
  invocation: InvocationRecord;
  runId: string;
  leaderSessionId?: string;
  statusUrl: string;
  progressUrl: string;
  streamUrl: string;
  monitor: {
    mode: "long-poll";
    tool: string;
    initialCursor: string;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    instructions: string;
    waitUrl: string;
  };
}

/** Client mirror of one long-poll wait response (GET <monitor.waitUrl>). */
export interface InvocationWaitResult {
  invocationId: string;
  leaderSessionId?: string;
  nextCursor: string;
  changed: boolean;
  terminal: boolean;
  reason: "changed" | "heartbeat" | "terminal";
  progressReport: string;
  progress: InvocationProgress;
  event?: unknown;
}

export function startInvocation(path: string, body: unknown, headers?: HeadersInit): Promise<InvocationStartReceipt> {
  return api<InvocationStartReceipt>(path, { ...writeBody(body), ...(headers ? { headers } : {}) });
}

export async function waitInvocationOnce(waitUrl: string, cursor?: string, timeoutMs = 20_000): Promise<InvocationWaitResult> {
  const result = await api<InvocationWaitResult>(
    `${waitUrl}?timeoutMs=${encodeURIComponent(timeoutMs)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
  );
  if (!result || typeof result.nextCursor !== "string" || !result.progress) {
    throw new Error("进度监听返回了无法识别的结果");
  }
  return result;
}

export function cancelInvocation(invocationId: string, reason?: string): Promise<InvocationRecord> {
  return api<InvocationRecord>(
    `/api/invocations/${encodeURIComponent(invocationId)}/cancel`,
    writeBody({ actor: "workbench-operator", ...(reason ? { reason } : {}) })
  );
}

export function getSession(sessionId: string): Promise<Session> {
  return api<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Long-poll loop over an invocation receipt. The cursor starts at
 * `options.startCursor` when given (remount after an interruption resumes from
 * the last seen nextCursor), otherwise at `monitor.initialCursor`; it advances
 * on every response (changed, heartbeat and terminal alike) and the terminal
 * result is returned to the caller. Errors rethrow — interruption handling is
 * the caller's job, never a new /start.
 */
export async function monitorInvocation(
  receipt: InvocationStartReceipt,
  options: {
    signal?: AbortSignal;
    onUpdate?: (result: InvocationWaitResult) => void;
    yieldMs?: number;
    startCursor?: string;
  } = {}
): Promise<InvocationWaitResult | undefined> {
  const { signal, onUpdate, yieldMs = 250, startCursor } = options;
  let cursor: string | undefined = startCursor ?? receipt.monitor.initialCursor;
  while (!signal?.aborted) {
    const result = await waitInvocationOnce(receipt.monitor.waitUrl, cursor);
    if (signal?.aborted) return undefined;
    cursor = result.nextCursor;
    onUpdate?.(result);
    if (result.terminal) return result;
    // Yield between iterations so an instantly-resolving (mocked or proxied)
    // endpoint can never spin the render loop; the server normally holds open.
    await new Promise((resolve) => setTimeout(resolve, yieldMs));
  }
  return undefined;
}
