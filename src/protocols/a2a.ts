import { randomUUID } from "node:crypto";
import {
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
  type Task
} from "@a2a-js/sdk";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { EmployeeInvocationResult } from "../workbench/types.js";
import { WorkbenchService } from "../workbench/service.js";

function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain"
  };
}

function dataPart(value: unknown): Part {
  return {
    content: { $case: "data", value },
    metadata: undefined,
    filename: "",
    mediaType: "application/json"
  };
}

function agentMessage(contextId: string, taskId: string, value: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(value)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

function readInput(message: Message): JsonObject {
  const data = message.parts
    .map((part) => part.content)
    .find((content) => content?.$case === "data");
  if (data?.$case === "data" && typeof data.value === "object" && data.value !== null && !Array.isArray(data.value)) {
    return data.value as JsonObject;
  }
  const text = message.parts
    .map((part) => part.content?.$case === "text" ? part.content.value : "")
    .filter(Boolean)
    .join("\n");
  return { message: text || "Complete the requested task." };
}

function isEmployeeResult(value: unknown): value is EmployeeInvocationResult {
  return typeof value === "object" && value !== null && "session" in value && "message" in value;
}

function resultSummary(value: Awaited<ReturnType<WorkbenchService["invokePublication"]>>): {
  status: string;
  message: string;
  data: JsonValue;
} {
  if (isEmployeeResult(value)) {
    return {
      status: value.status,
      message: value.message,
      data: {
        runId: value.runId,
        status: value.status,
        message: value.message,
        output: value.output ?? null
      }
    };
  }
  const outputs = Object.fromEntries(
    Object.entries(value.run.nodes).map(([nodeId, node]) => [nodeId, node.output ?? { error: node.error ?? null }])
  ) as JsonObject;
  return {
    status: value.run.status,
    message: `Workflow ${value.run.workflow} finished with status ${value.run.status}.`,
    data: {
      runId: value.run.id,
      status: value.run.status,
      outputs
    }
  };
}

class WorkbenchPublicationExecutor implements AgentExecutor {
  constructor(
    private readonly publicationId: string,
    private readonly service: WorkbenchService
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const task: Task = {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: agentMessage(contextId, taskId, "The local workbench accepted the request."),
        timestamp: new Date().toISOString()
      },
      artifacts: [],
      history: [userMessage],
      metadata: { publicationId: this.publicationId }
    };
    eventBus.publish(AgentEvent.task(task));

    try {
      const rawResult = await this.service.invokePublication(this.publicationId, readInput(userMessage), {
        kind: "a2a",
        label: "A2A task",
        contextId,
        taskId
      });
      const result = resultSummary(rawResult);
      const failed = result.status === "failed";
      const blocked = result.status === "blocked";
      const artifact: Artifact = {
        artifactId: randomUUID(),
        name: blocked ? "Domain block" : failed ? "Technical failure" : "Workbench result",
        description: blocked
          ? "The run completed with a valid domain Block result."
          : failed
            ? "The run encountered a technical failure."
            : "Structured output from the local workbench.",
        parts: [textPart(result.message), dataPart(result.data)],
        metadata: { workbenchStatus: result.status, domainBlock: blocked },
        extensions: []
      };
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined
      }));
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: failed ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED,
          message: agentMessage(contextId, taskId, result.message),
          timestamp: new Date().toISOString()
        },
        metadata: blocked ? { workbenchStatus: "blocked" } : undefined
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          message: agentMessage(contextId, taskId, message),
          timestamp: new Date().toISOString()
        },
        metadata: { workbenchStatus: "failed" }
      }));
    }
  }

  async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    throw new TaskNotCancelableError("Workbench v1 does not support safe cancellation propagation.");
  }
}

export function buildAgentCard(
  service: WorkbenchService,
  publicationId: string,
  baseUrl: string,
  options: { allowArchived?: boolean } = {}
): AgentCard {
  const publication = service.getPublication(publicationId);
  if (publication.status !== "active" && !options.allowArchived) {
    throw new Error(`publication ${publicationId} is archived`);
  }
  const target = publication.target.kind === "employee"
    ? service.getEmployee(publication.target.id)
    : service.getWorkflow(publication.target.id);
  if (target.status !== "active" && !options.allowArchived) {
    throw new Error(`${publication.target.kind} ${publication.target.id} is archived`);
  }
  const skillName = publication.target.kind === "employee"
    ? service.getEmployee(publication.target.id).identity.displayName
    : service.getWorkflow(publication.target.id).id;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/a2a/${publication.id}`;
  return {
    name: publication.name,
    description: publication.description,
    supportedInterfaces: [{
      url: endpoint,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: "1.0"
    }],
    provider: { organization: "Local Agent Workbench", url: baseUrl },
    version: String(publication.version),
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [{
      id: `${publication.target.kind}-${publication.target.id}`,
      name: skillName,
      description: "description" in target ? target.description : publication.description,
      tags: [publication.target.kind, "local", "workbench"],
      examples: publication.target.kind === "employee"
        ? [`Ask ${publication.name} to complete a task.`]
        : [`Run ${publication.name} with structured input.`],
      inputModes: ["text/plain", "application/json"],
      outputModes: ["text/plain", "application/json"],
      securityRequirements: []
    }],
    signatures: []
  };
}

export function createA2ARequestHandler(
  service: WorkbenchService,
  publicationId: string,
  baseUrl: string
): DefaultRequestHandler {
  const card = buildAgentCard(service, publicationId, baseUrl);
  return new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new WorkbenchPublicationExecutor(publicationId, service)
  );
}
