import { createHash } from "node:crypto";
import type { JsonObject } from "../core/types.js";
import type { KnowledgeDocumentInput } from "./types.js";
import type { KnowledgeFetchedUrl } from "./urlFetcher.js";

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    if (normalized === "nbsp") return " ";
    const radix = normalized.startsWith("#x") ? 16 : 10;
    const digits = normalized.replace(/^#x?/, "");
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function plainText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replaceAll(/\s+/g, " ")
    .trim();
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || undefined;
}

function absoluteHttpUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function fragmentLinks(fragment: string, base: string): string[] {
  const links: string[] = [];
  const pattern = /<a\b([^>]*)>/gi;
  for (const match of fragment.matchAll(pattern)) {
    const link = absoluteHttpUrl(attributeValue(match[1] ?? "", "href"), base);
    if (link) links.push(link);
  }
  return [...new Set(links)].sort();
}

function normalizeMarkdown(value: string): string {
  const lines = value
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replaceAll(/[\t ]+/g, " ").trim());
  const normalized: string[] = [];
  for (const line of lines) {
    if (!line && normalized.at(-1) === "") continue;
    normalized.push(line);
  }
  return normalized.join("\n").trim();
}

export function htmlFragmentToMarkdown(fragment: string, baseUrl: string): string {
  let value = fragment;
  value = value.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, body: string) =>
    `\n\n\`\`\`\n${decodeEntities(body.replace(/<[^>]*>/g, "")).trim()}\n\`\`\`\n\n`
  );
  value = value.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_match, body: string) => `\`${plainText(body)}\``);
  value = value.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attributes: string, body: string) => {
    const text = plainText(body);
    const link = absoluteHttpUrl(attributeValue(attributes, "href"), baseUrl);
    return link && text ? `[${text}](${link})` : text;
  });
  value = value.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, body: string) =>
    `\n\n${"#".repeat(Number(level))} ${plainText(body)}\n\n`
  );
  value = value.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_match, body: string) => `\n- ${plainText(body)}\n`);
  value = value.replace(/<br\s*\/?\s*>/gi, "\n");
  value = value.replace(/<\/(?:p|div|section|article|aside|main|header|footer|nav|ul|ol|table|tr|blockquote)\s*>/gi, "\n\n");
  value = value.replace(/<(?:p|div|section|article|aside|main|header|footer|nav|ul|ol|table|tr|blockquote)\b[^>]*>/gi, "\n\n");
  value = value.replace(/<td\b[^>]*>/gi, " ").replace(/<\/td\s*>/gi, " | ");
  value = value.replace(/<[^>]*>/g, "");
  return normalizeMarkdown(decodeEntities(value));
}

function slug(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "section";
}

function documentId(sourceRef: string): string {
  return `web-${createHash("sha256").update(sourceRef).digest("hex").slice(0, 20)}`;
}

function sourceRefWithAnchor(value: string, anchor: string): string {
  const parsed = new URL(value);
  parsed.hash = anchor;
  return parsed.href;
}

function documentMetadata(
  fetched: KnowledgeFetchedUrl,
  content: string,
  headingLevel: number,
  headingPath: string[],
  anchor: string | undefined,
  links: string[]
): JsonObject {
  return {
    sourceKind: "url",
    sourceUrl: fetched.requestedUrl,
    finalUrl: fetched.finalUrl,
    pageContentSha256: fetched.contentSha256,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    headingLevel,
    headingPath,
    ...(anchor ? { anchor } : {}),
    links
  };
}

interface HeadingMatch {
  level: 2 | 3;
  attributes: string;
  title: string;
  index: number;
  end: number;
}

export function webpageToKnowledgeDocuments(
  fetched: KnowledgeFetchedUrl,
  collectionId: string
): KnowledgeDocumentInput[] {
  const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(fetched.html)?.[1] ?? "")
    || plainText(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(fetched.html)?.[1] ?? "")
    || `${new URL(fetched.finalUrl).hostname}${new URL(fetched.finalUrl).pathname}`;
  const sanitized = fetched.html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(sanitized)?.[1] ?? sanitized;
  const headings: HeadingMatch[] = [];
  const headingPattern = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;
  for (const match of body.matchAll(headingPattern)) {
    const headingTitle = plainText(match[3] ?? "");
    if (!headingTitle || match.index === undefined) continue;
    headings.push({
      level: Number(match[1]) as 2 | 3,
      attributes: match[2] ?? "",
      title: headingTitle,
      index: match.index,
      end: match.index + match[0].length
    });
  }

  const documents: KnowledgeDocumentInput[] = [];
  const prefixEnd = headings[0]?.index ?? body.length;
  const prefix = body.slice(0, prefixEnd);
  const prefixMarkdown = htmlFragmentToMarkdown(prefix, fetched.finalUrl);
  let introId: string | undefined;
  if (prefixMarkdown || headings.length === 0) {
    const content = prefixMarkdown || `# ${title}`;
    const sourceRef = fetched.finalUrl;
    introId = documentId(sourceRef);
    documents.push({
      id: introId,
      title,
      content,
      collectionId,
      sourceRef,
      order: 0,
      references: [],
      metadata: documentMetadata(fetched, content, 1, [title], undefined, fragmentLinks(prefix, fetched.finalUrl))
    });
  }

  const usedAnchors = new Map<string, number>();
  let currentH2: { id: string; title: string } | undefined;
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const declaredAnchor = attributeValue(heading.attributes, "id");
    const baseAnchor = declaredAnchor ?? slug(heading.title);
    const count = (usedAnchors.get(baseAnchor) ?? 0) + 1;
    usedAnchors.set(baseAnchor, count);
    const anchor = count === 1 ? baseAnchor : `${baseAnchor}-${count}`;
    const sourceRef = sourceRefWithAnchor(fetched.finalUrl, anchor);
    const id = documentId(sourceRef);
    const fragment = body.slice(heading.end, headings[index + 1]?.index ?? body.length);
    const markdown = htmlFragmentToMarkdown(fragment, fetched.finalUrl);
    const content = `${"#".repeat(heading.level)} ${heading.title}${markdown ? `\n\n${markdown}` : ""}`;
    const headingPath = heading.level === 2
      ? [heading.title]
      : currentH2 ? [currentH2.title, heading.title] : [heading.title];
    const parentId = heading.level === 3 ? currentH2?.id ?? introId : introId;
    documents.push({
      id,
      title: heading.title,
      content,
      collectionId,
      sourceRef,
      order: documents.length,
      parentId,
      references: [],
      metadata: documentMetadata(fetched, content, heading.level, headingPath, anchor, fragmentLinks(fragment, fetched.finalUrl))
    });
    if (heading.level === 2) currentH2 = { id, title: heading.title };
  }

  if (documents.length === 0) throw new Error("knowledge URL did not contain readable HTML content");
  return documents;
}
