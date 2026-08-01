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
