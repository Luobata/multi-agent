import type { JsonObject, JsonValue, Publication, Workflow } from "./types";

export type WorkflowInvocationMode = "publication" | "workflow";

export interface WorkflowSessionPrompts {
  mode: WorkflowInvocationMode;
  tool: "invoke_publication" | "run_workflow";
  targetId: string;
  input: JsonObject;
  humanPrompt: string;
  mcpJson: string;
}

const DEFAULT_MESSAGE = "请描述要交给该编排的任务";
const MAX_SCHEMA_DEPTH = 5;
const MAX_EXAMPLE_PROPERTIES = 8;
const publicationNameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function placeholderForKey(key: string): string {
  if (/^(?:message|prompt|task|request|description)$/iu.test(key)) return DEFAULT_MESSAGE;
  if (/(?:workspace|project).*(?:path|root)|(?:path|root|directory)$/iu.test(key)) return "/absolute/path/to/project";
  if (/(?:url|uri)$/iu.test(key)) return "https://example.com";
  if (/(?:email)$/iu.test(key)) return "name@example.com";
  if (/(?:id)$/iu.test(key)) return "example-id";
  return `请填写 ${key}`;
}

function explicitSchemaExample(schema: JsonObject): JsonValue | undefined {
  for (const key of ["example", "default", "const"] as const) {
    if (schema[key] !== undefined) return schema[key];
  }
  for (const key of ["examples", "enum"] as const) {
    const candidates = schema[key];
    if (Array.isArray(candidates) && candidates.length > 0) return candidates[0];
  }
  return undefined;
}

function exampleFromSchema(schema: JsonObject, key = "value", depth = 0): JsonValue | undefined {
  const explicit = explicitSchemaExample(schema);
  if (explicit !== undefined) return explicit;
  if (depth >= MAX_SCHEMA_DEPTH) return placeholderForKey(key);

  for (const variantKey of ["oneOf", "anyOf"] as const) {
    const variants = schema[variantKey];
    if (!Array.isArray(variants)) continue;
    const variant = variants.map(objectValue).find(Boolean);
    if (variant) return exampleFromSchema(variant, key, depth + 1);
  }

  const declaredType = Array.isArray(schema.type)
    ? schema.type.find((value) => value !== "null")
    : schema.type;
  const properties = objectValue(schema.properties);

  if (declaredType === "object" || properties) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [];
    const propertyNames = Object.keys(properties ?? {});
    const names = [...new Set([...required, ...propertyNames])].slice(0, MAX_EXAMPLE_PROPERTIES);
    if (names.length === 0) return depth === 0 ? undefined : {};
    return Object.fromEntries(names.map((propertyName) => {
      const propertySchema = objectValue(properties?.[propertyName]);
      return [propertyName, propertySchema
        ? exampleFromSchema(propertySchema, propertyName, depth + 1) ?? placeholderForKey(propertyName)
        : placeholderForKey(propertyName)];
    }));
  }

  if (declaredType === "array" || schema.items !== undefined) {
    const itemSchema = objectValue(schema.items);
    return itemSchema ? [exampleFromSchema(itemSchema, key, depth + 1) ?? placeholderForKey(key)] : [];
  }
  if (declaredType === "boolean") return true;
  if (declaredType === "integer" || declaredType === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (declaredType === "null") return null;
  if (declaredType === "string") {
    if (schema.format === "date") return "2026-01-01";
    if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
    if (schema.format === "email") return "name@example.com";
    if (schema.format === "uri" || schema.format === "url") return "https://example.com";
    return placeholderForKey(key);
  }
  return depth === 0 ? undefined : placeholderForKey(key);
}

export function workflowInputExample(workflow: Workflow): JsonObject {
  const generated = exampleFromSchema(workflow.inputSchema ?? {});
  return objectValue(generated) ?? { message: DEFAULT_MESSAGE };
}

export function activeWorkflowPublications(workflowId: string, publications: Publication[]): Publication[] {
  return publications
    .filter((publication) => publication.status === "active"
      && publication.target.kind === "workflow"
      && publication.target.id === workflowId)
    .sort((left, right) => publicationNameCollator.compare(left.name, right.name) || left.id.localeCompare(right.id));
}

export function buildWorkflowSessionPrompts(
  workflow: Workflow,
  publication?: Publication,
  input: JsonObject = workflowInputExample(workflow)
): WorkflowSessionPrompts {
  const activePublication = publication?.status === "active"
    && publication.target.kind === "workflow"
    && publication.target.id === workflow.id
    ? publication
    : undefined;
  const mode: WorkflowInvocationMode = activePublication ? "publication" : "workflow";
  const tool = activePublication ? "invoke_publication" : "run_workflow";
  const targetId = activePublication?.id ?? workflow.id;
  const targetArgument = activePublication
    ? { publicationId: activePublication.id }
    : { workflowId: workflow.id };
  const invocation = {
    tool,
    arguments: {
      ...targetArgument,
      input,
      project: "当前项目名",
      contextId: "当前会话 ID（可选）"
    }
  };
  const routeDescription = activePublication
    ? `通过调用包「${activePublication.name}」调用 Publication ID \`${activePublication.id}\``
    : `当前没有活动调用包，使用 \`run_workflow\` 直接调试 Workflow ID \`${workflow.id}\``;

  return {
    mode,
    tool,
    targetId,
    input,
    humanPrompt: [
      `请使用 \`local_agent_workbench\` MCP 服务执行协作编排「${workflow.id}」。`,
      "",
      `- 调用方式：${routeDescription}`,
      `- 编排目标：${workflow.description}`,
      "- 输入示例：",
      "```json",
      JSON.stringify(input, null, 2),
      "```",
      "- 将 project 替换为当前项目名；只有需要关联连续调用时才填写稳定的 contextId。",
      "",
      `请调用 \`${tool}\`。完成后返回运行状态和 runId，汇总最终结论；如结果为 blocked 或 failed，请说明阻塞或故障原因。`
    ].join("\n"),
    mcpJson: JSON.stringify(invocation, null, 2)
  };
}
