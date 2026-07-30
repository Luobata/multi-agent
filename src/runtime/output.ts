import fs from "node:fs";
import { Ajv, type ErrorObject } from "ajv";
import type { JsonValue, OutputProtocol, RoleVerdictDefinition } from "../core/types.js";

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("provider returned no output");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) return trimmed.slice(objectStart, objectEnd + 1);
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) return trimmed.slice(arrayStart, arrayEnd + 1);
  return trimmed;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("provider returned no output");

  // Provider envelopes can legitimately contain fenced code inside JSON string
  // fields. Parse the complete payload before looking for a fenced JSON reply;
  // otherwise a CSS/Markdown fence in `result` can be mistaken for the envelope.
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return JSON.parse(extractJsonText(trimmed)) as unknown;
  }
}

function asJsonValue(value: unknown): JsonValue {
  JSON.stringify(value);
  return value as JsonValue;
}

export function parseProviderOutput(protocol: OutputProtocol, stdout: string): JsonValue {
  if (protocol === "raw") return { text: stdout };
  const parsed = parseJsonText(stdout);
  if (protocol === "json") return asJsonValue(parsed);

  if (typeof parsed === "object" && parsed !== null) {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.structured_output !== undefined) return asJsonValue(envelope.structured_output);
    if (typeof envelope.result === "string") return asJsonValue(parseJsonText(envelope.result));
  }
  throw new Error("claude-json output did not contain structured_output or a JSON result");
}

export function readJsonSchema(schemaPath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`JSON Schema must be an object: ${schemaPath}`);
  }
  return parsed as Record<string, unknown>;
}

export function validateStructuredOutput(schema: Record<string, unknown>, output: JsonValue, label: string): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (validate(output)) return;
  const issues = (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
  throw new Error(`${label} output schema validation failed: ${issues.join("; ")}`);
}

function readPath(value: JsonValue, expression: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of expression.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function statusFromVerdict(output: JsonValue, verdict: RoleVerdictDefinition | undefined): "passed" | "blocked" {
  if (!verdict) return "passed";
  const actual = readPath(output, verdict.path);
  if (verdict.pass.some((candidate) => Object.is(candidate, actual))) return "passed";
  if (verdict.block.some((candidate) => Object.is(candidate, actual))) return "blocked";
  throw new Error(`verdict ${verdict.path} has unsupported value ${JSON.stringify(actual)}`);
}
