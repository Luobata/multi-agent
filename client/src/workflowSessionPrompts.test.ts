import { describe, expect, it } from "vitest";
import {
  activeWorkflowPublications,
  buildWorkflowSessionPrompts,
  workflowInputExample
} from "./workflowSessionPrompts";
import type { GraphWorkflow, Publication } from "./types";

function workflow(overrides: Partial<GraphWorkflow> = {}): GraphWorkflow {
  return {
    id: "review-team",
    version: 2,
    status: "active",
    architecture: "graph",
    description: "并行检查并汇总评审结论。",
    nodes: [{ id: "internal-review", employeeId: "private-reviewer", needs: [], with: {} }],
    maxConcurrency: 2,
    failFast: false,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides
  };
}

function publication(id: string, overrides: Partial<Publication> = {}): Publication {
  return {
    id,
    version: 1,
    status: "active",
    name: id,
    description: "Review publication",
    target: { kind: "workflow", id: "review-team" },
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides
  };
}

describe("workflow session prompts", () => {
  it("builds a schema-aware object input example", () => {
    const input = workflowInputExample(workflow({
      inputSchema: {
        type: "object",
        required: ["message", "attempts", "mode", "target"],
        properties: {
          message: { type: "string" },
          attempts: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["strict", "fast"] },
          target: {
            type: "object",
            properties: { url: { type: "string", format: "uri" } }
          }
        }
      }
    }));

    expect(input).toEqual({
      message: "请描述要交给该编排的任务",
      attempts: 1,
      mode: "strict",
      target: { url: "https://example.com" }
    });
  });

  it("uses a useful message fallback for an open or unsupported schema", () => {
    expect(workflowInputExample(workflow({ inputSchema: { type: "object", additionalProperties: true } })))
      .toEqual({ message: "请描述要交给该编排的任务" });
    expect(workflowInputExample(workflow({ inputSchema: { type: "string" } })))
      .toEqual({ message: "请描述要交给该编排的任务" });
  });

  it("selects only active publications for the workflow in stable name order", () => {
    const matches = activeWorkflowPublications("review-team", [
      publication("z-package", { name: "乙入口" }),
      publication("archived", { status: "archived" }),
      publication("employee", { target: { kind: "employee", id: "review-team" } }),
      publication("other", { target: { kind: "workflow", id: "other-team" } }),
      publication("a-package", { name: "甲入口" })
    ]);

    expect(matches.map((item) => item.id)).toEqual(["a-package", "z-package"]);
  });

  it("prefers an asynchronous publication and emits the mandatory monitor contract", () => {
    const result = buildWorkflowSessionPrompts(
      workflow(),
      publication("review-agent", { name: "联合评审 Agent" }),
      { message: "检查当前改动" }
    );
    const invocation = JSON.parse(result.mcpJson) as { tool: string; arguments: Record<string, unknown> };

    expect(result).toMatchObject({ mode: "publication", tool: "start_publication", targetId: "review-agent" });
    expect(invocation).toMatchObject({
      tool: "start_publication",
      arguments: {
        publicationId: "review-agent",
        input: { message: "检查当前改动" },
        project: "当前项目名",
        contextId: "当前会话 ID（可选）"
      }
    });
    expect(result.invocationPrompt).toContain("Publication ID `review-agent`");
    expect(result.invocationPrompt).toContain("循环调用 `wait_workflow_progress`");
    expect(result.invocationPrompt).toContain("`terminal=false`");
    expect(result.invocationPrompt).toContain("`resume_workflow_monitor(runId)`");
    expect(result.agentsMarkdown).toContain("## 协作编排");
    expect(result.agentsMarkdown).toContain("仅讨论需求、方案或设计时，不要自动启动协作编排");
    expect(result.agentsMarkdown).toContain("`start_publication` 启动 Publication `review-agent`");
    expect(result.agentsMarkdown).toContain("不得结束当前回合");
  });

  it("falls back to asynchronous start_workflow without exposing internal nodes or prompts", () => {
    const result = buildWorkflowSessionPrompts(workflow());
    const invocation = JSON.parse(result.mcpJson) as { tool: string; arguments: Record<string, unknown> };

    expect(result).toMatchObject({ mode: "workflow", tool: "start_workflow", targetId: "review-team" });
    expect(invocation).toMatchObject({
      tool: "start_workflow",
      arguments: { workflowId: "review-team" }
    });
    expect(result.agentsMarkdown).toContain("`start_workflow` 启动 Workflow `review-team`");
    expect(result.invocationPrompt).toContain("heartbeat");
    expect(`${result.agentsMarkdown}\n${result.invocationPrompt}\n${result.mcpJson}`).not.toContain("internal-review");
    expect(`${result.agentsMarkdown}\n${result.invocationPrompt}\n${result.mcpJson}`).not.toContain("private-reviewer");
    expect(`${result.agentsMarkdown}\n${result.invocationPrompt}\n${result.mcpJson}`).not.toContain("systemPrompt");
  });
});
