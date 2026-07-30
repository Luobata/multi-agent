import { TemplateRenderError } from "./errors.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function resolvePath(context: unknown, expression: string): unknown {
  let current = context;
  for (const segment of expression.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, context: unknown): string {
  const missing = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, expression: string) => {
    const value = resolvePath(context, expression);
    if (value === undefined) {
      missing.add(expression);
      return `{{${expression}}}`;
    }
    return stringifyTemplateValue(value);
  });
  if (missing.size > 0) throw new TemplateRenderError([...missing]);
  return rendered;
}
