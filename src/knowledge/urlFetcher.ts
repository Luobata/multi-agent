import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type RequestOptions } from "node:http";
import https, { type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";

export interface KnowledgeFetchedUrl {
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  contentType: string;
  byteLength: number;
  contentSha256: string;
  html: string;
  fetchedAt: string;
}

export interface KnowledgeUrlHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  abort: () => void;
}

export type KnowledgeUrlLookup = (hostname: string) => Promise<LookupAddress[]>;
export type KnowledgeUrlRequest = (
  url: URL,
  address: LookupAddress,
  signal: AbortSignal
) => Promise<KnowledgeUrlHttpResponse>;

export interface RestrictedKnowledgeUrlFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: KnowledgeUrlLookup;
  request?: KnowledgeUrlRequest;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

function normalizedUrl(value: string | URL): URL {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error("knowledge URL must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("knowledge URL protocol must be http or https");
  }
  if (parsed.username || parsed.password) throw new Error("knowledge URL must not contain credentials");
  parsed.hash = "";
  return parsed;
}

function parseIpv4(value: string): number | undefined {
  const pieces = value.split(".");
  if (pieces.length !== 4) return undefined;
  const octets = pieces.map((piece) => Number(piece));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== pieces[index])) {
    return undefined;
  }
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function ipv4InPrefix(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function parseIpv6(value: string): bigint | undefined {
  let text = value.toLowerCase().split("%", 1)[0]!;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const ipv4 = parseIpv4(text.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === undefined) return undefined;
    text = `${text.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const pieces = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (pieces.length !== 8 || pieces.some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) return undefined;
  return pieces.reduce((result, piece) => (result << 16n) | BigInt(`0x${piece}`), 0n);
}

function ipv6InPrefix(value: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function ipv4Text(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function embeddedIpv4(value: bigint, shift: bigint): number {
  return Number((value >> shift) & 0xffffffffn) >>> 0;
}

function blockedEmbeddedIpv4Reason(value: number, mechanism: string): string | undefined {
  const reason = blockedKnowledgeAddressReason(ipv4Text(value));
  return reason ? `${mechanism}-${reason}` : undefined;
}

const SIX_TO_FOUR_PREFIX = 0x2002n << 112n; // RFC 3056: 2002:V4ADDR::/48
const TEREDO_PREFIX = 0x20010000n << 96n; // RFC 4380: server IPv4 + complemented client IPv4
const NAT64_WELL_KNOWN_PREFIX = 0x0064ff9bn << 96n; // RFC 6052: 64:ff9b::/96
const NAT64_LOCAL_USE_PREFIX = 0x0064ff9b0001n << 80n; // RFC 8215: local-use translation space

export function blockedKnowledgeAddressReason(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) {
    const value = parseIpv4(address)!;
    const ranges: Array<[number, number, string]> = [
      [0x00000000, 8, "unspecified"],
      [0x0a000000, 8, "private"],
      [0x64400000, 10, "shared-private"],
      [0x7f000000, 8, "loopback"],
      [0xa9fe0000, 16, "link-local"],
      [0xac100000, 12, "private"],
      [0xc0000000, 24, "reserved"],
      [0xc0a80000, 16, "private"],
      [0xc6120000, 15, "benchmark"],
      [0xe0000000, 4, "multicast"],
      [0xf0000000, 4, "reserved"]
    ];
    return ranges.find(([base, prefix]) => ipv4InPrefix(value, base, prefix))?.[2];
  }
  if (family === 6) {
    const value = parseIpv6(address)!;
    if (value === 0n) return "unspecified";
    if (value === 1n) return "loopback";
    if (value <= 0xffffffffn) {
      return blockedKnowledgeAddressReason(ipv4Text(Number(value) >>> 0));
    }
    if ((value >> 32n) === 0xffffn) {
      return blockedKnowledgeAddressReason(ipv4Text(embeddedIpv4(value, 0n)));
    }
    if (ipv6InPrefix(value, SIX_TO_FOUR_PREFIX, 16)) {
      return blockedEmbeddedIpv4Reason(embeddedIpv4(value, 80n), "6to4");
    }
    if (ipv6InPrefix(value, TEREDO_PREFIX, 32)) {
      const serverReason = blockedEmbeddedIpv4Reason(embeddedIpv4(value, 64n), "teredo-server");
      if (serverReason) return serverReason;
      const client = (~embeddedIpv4(value, 0n)) >>> 0;
      return blockedEmbeddedIpv4Reason(client, "teredo-client");
    }
    if (ipv6InPrefix(value, NAT64_WELL_KNOWN_PREFIX, 96)) {
      return blockedEmbeddedIpv4Reason(embeddedIpv4(value, 0n), "nat64");
    }
    if (ipv6InPrefix(value, NAT64_LOCAL_USE_PREFIX, 48)) {
      // The local-use prefix does not mandate one embedding layout, so reject the whole local translation space.
      return "nat64-local-use";
    }
    const isatapMarker = embeddedIpv4(value, 32n);
    if (isatapMarker === 0x00005efe || isatapMarker === 0x02005efe) {
      const isatapReason = blockedEmbeddedIpv4Reason(embeddedIpv4(value, 0n), "isatap");
      if (isatapReason) return isatapReason;
    }
    const ranges: Array<[bigint, number, string]> = [
      [BigInt("0xfc00") << 112n, 7, "private"],
      [BigInt("0xfe80") << 112n, 10, "link-local"],
      [BigInt("0xfec0") << 112n, 10, "site-local"],
      [BigInt("0xff00") << 112n, 8, "multicast"]
    ];
    return ranges.find(([base, prefix]) => ipv6InPrefix(value, base, prefix))?.[2];
  }
  return "invalid";
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function defaultRequest(url: URL, address: LookupAddress, signal: AbortSignal): Promise<KnowledgeUrlHttpResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("knowledge URL request aborted"));
      return;
    }
    const options: HttpsRequestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
        host: url.host,
        "user-agent": "local-agent-workbench-knowledge-fetcher/1"
      },
      agent: false,
      maxHeaderSize: 32 * 1024
    };
    if (url.protocol === "https:" && !isIP(url.hostname)) options.servername = url.hostname;
    const request = (url.protocol === "https:" ? https : http).request(options as RequestOptions, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        abort: () => response.destroy()
      });
    });
    const abort = () => request.destroy(new Error("knowledge URL request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function contentType(headers: IncomingHttpHeaders): string {
  const raw = headerValue(headers, "content-type")?.trim().toLowerCase();
  if (!raw) throw new Error("knowledge URL response is missing content-type");
  const [mediaType, ...parameters] = raw.split(";").map((part) => part.trim());
  if (!ALLOWED_CONTENT_TYPES.has(mediaType!)) {
    throw new Error(`knowledge URL content-type ${mediaType} is not allowed`);
  }
  const charset = parameters.find((parameter) => parameter.startsWith("charset="))?.slice("charset=".length).replaceAll(/["']/g, "");
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    throw new Error(`knowledge URL charset ${charset} is not supported`);
  }
  return mediaType!;
}

export class RestrictedKnowledgeUrlFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly lookup: KnowledgeUrlLookup;
  private readonly request: KnowledgeUrlRequest;

  constructor(options: RestrictedKnowledgeUrlFetcherOptions = {}) {
    this.timeoutMs = Math.max(100, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxBytes = Math.max(1_024, Math.min(10 * 1024 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES));
    this.maxRedirects = Math.max(0, Math.min(10, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
    this.lookup = options.lookup ?? defaultLookup;
    this.request = options.request ?? defaultRequest;
  }

  private async addresses(url: URL): Promise<LookupAddress[]> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await this.lookup(hostname);
    if (addresses.length === 0) throw new Error(`knowledge URL host ${hostname} did not resolve`);
    for (const address of addresses) {
      const reason = blockedKnowledgeAddressReason(address.address);
      if (reason) throw new Error(`knowledge URL host ${hostname} resolved to blocked ${reason} address ${address.address}`);
    }
    return [...addresses].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  }

  private async execute(requested: URL, signal: AbortSignal): Promise<KnowledgeFetchedUrl> {
    let current = requested;
    const redirects: string[] = [];
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (signal.aborted) throw new Error("knowledge URL request timed out");
      const addresses = await this.addresses(current);
      if (signal.aborted) throw new Error("knowledge URL request timed out");
      const response = await this.request(current, addresses[0]!, signal);
      if (signal.aborted) {
        response.abort();
        throw new Error("knowledge URL request timed out");
      }
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        response.abort();
        if (redirectCount >= this.maxRedirects) throw new Error(`knowledge URL exceeds ${this.maxRedirects} redirects`);
        const location = headerValue(response.headers, "location");
        if (!location) throw new Error("knowledge URL redirect is missing location");
        current = normalizedUrl(new URL(location, current));
        redirects.push(current.href);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.abort();
        throw new Error(`knowledge URL returned HTTP ${response.statusCode}`);
      }
      const encoding = headerValue(response.headers, "content-encoding")?.trim().toLowerCase();
      if (encoding && encoding !== "identity") {
        response.abort();
        throw new Error(`knowledge URL content-encoding ${encoding} is not allowed`);
      }
      const mediaType = contentType(response.headers);
      const declaredLength = Number(headerValue(response.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
        response.abort();
        throw new Error(`knowledge URL response exceeds ${this.maxBytes} bytes`);
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      try {
        for await (const chunk of response.body) {
          if (signal.aborted) throw new Error("knowledge URL request timed out");
          const bytes = Buffer.from(chunk);
          byteLength += bytes.length;
          if (byteLength > this.maxBytes) throw new Error(`knowledge URL response exceeds ${this.maxBytes} bytes`);
          chunks.push(bytes);
        }
      } catch (error) {
        response.abort();
        throw error;
      }
      const body = Buffer.concat(chunks);
      let html: string;
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        throw new Error("knowledge URL response is not valid UTF-8");
      }
      return {
        requestedUrl: requested.href,
        finalUrl: current.href,
        redirects,
        contentType: mediaType,
        byteLength,
        contentSha256: createHash("sha256").update(body).digest("hex"),
        html,
        fetchedAt: new Date().toISOString()
      };
    }
  }

  async fetch(value: string): Promise<KnowledgeFetchedUrl> {
    const requested = normalizedUrl(value);
    const controller = new AbortController();
    return new Promise<KnowledgeFetchedUrl>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`knowledge URL request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      void this.execute(requested, controller.signal).then(resolve, reject).finally(() => clearTimeout(timeout));
    });
  }
}
