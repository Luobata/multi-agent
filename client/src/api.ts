interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

export async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers
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
