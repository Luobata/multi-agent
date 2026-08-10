import type { JsonObject, JsonValue, Publication, Workflow } from "./types";

export type WorkflowInvocationMode = "publication" | "workflow";

export interface WorkflowSessionPrompts {
  mode: WorkflowInvocationMode;
  tool: "start_publication" | "start_workflow";
  targetId: string;
  input: JsonObject;
  agentsMarkdown: string;
  invocationPrompt: string;
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
  const tool = activePublication ? "start_publication" : "start_workflow";
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
    ? `通过调用包「${activePublication.name}」异步启动 Publication ID \`${activePublication.id}\``
    : `当前没有活动调用包，使用 \`start_workflow\` 异步启动 Workflow ID \`${workflow.id}\``;
  const agentsRouteRule = activePublication
    ? `默认通过 \`start_publication\` 启动 Publication \`${activePublication.id}\`（${activePublication.name}），不要自行拆解其内部 Workflow、节点或 Prompt。`
    : `默认通过 \`start_workflow\` 启动 Workflow \`${workflow.id}\`。`;
  const monitorRules = [
    "启动回执返回后，立即保存 `invocation.id`、`runId` 和 `monitor.initialCursor`。",
    "随后循环调用 `wait_workflow_progress`：传入 `invocationId`、上一次的 `nextCursor`，并使用不超过 55 秒的 `timeoutMs`（推荐 30000）。",
    "每次状态变化或 heartbeat 都向用户转述 `progressReport`，然后把 cursor 更新为 `nextCursor`。",
    "只要 `terminal=false`，就不得结束当前回合或给出最终答复；继续等待。只有 `terminal=true` 才交付最终摘要。",
    "等待发生临时传输错误时，使用同一 `invocationId` 和 cursor 重试，不得重新启动 Workflow。若原回合或连接已经结束，使用 `resume_workflow_monitor(runId)` 取得新回执后继续同一循环。"
  ];

  return {
    mode,
    tool,
    targetId,
    input,
    agentsMarkdown: [
      "## 协作编排",
      "",
      "- 当用户明确要求“推进开发、交付、拆解并分工”，或任务确实需要多个项目角色协作时，使用 `local_agent_workbench` MCP。",
      "- 仅讨论需求、方案或设计时，不要自动启动协作编排。",
      `- ${agentsRouteRule}`,
      "- `project` 使用当前项目名称。新任务不传 `contextId`；只有继续同一次协作编排时，才复用稳定的 `contextId`。",
      ...monitorRules.map((rule) => `- ${rule}`),
      "- 终态时汇总运行状态和 `runId`；结果为 `blocked` 或 `failed` 时，明确说明阻塞或故障原因。",
      "- 如果 MCP 或目标入口不可用，应报告配置问题，不要在本地伪造协作结果。"
    ].join("\n"),
    invocationPrompt: [
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
      `请先调用 \`${tool}\`，然后严格执行以下监听协议：`,
      ...monitorRules.map((rule, index) => `${index + 1}. ${rule}`),
      "终态后返回运行状态和 runId，汇总最终结论；如结果为 blocked 或 failed，请说明阻塞或故障原因。"
    ].join("\n"),
    mcpJson: JSON.stringify(invocation, null, 2)
  };
}
