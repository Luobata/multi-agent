import { describe, expect, it } from "vitest";
import { parseProviderOutput, statusFromVerdict, validateStructuredOutput } from "../src/runtime/output.js";

describe("provider output contracts", () => {
  it("unwraps Claude-compatible structured output", () => {
    const value = parseProviderOutput(
      "claude-json",
      JSON.stringify({ type: "result", structured_output: { verdict: "Pass", summary: "ok" } })
    );
    expect(value).toEqual({ verdict: "Pass", summary: "ok" });
  });

  it("prefers the complete Claude envelope when its result contains a code fence", () => {
    const structured = {
      message: "A structured design result",
      implementationBrief: "Use the supplied tokens"
    };
    const value = parseProviderOutput(
      "claude-json",
      JSON.stringify({
        type: "result",
        result: "```css\n.panel { color: var(--ink); }\n```",
        structured_output: structured
      })
    );
    expect(value).toEqual(structured);
  });

  it("extracts the final structured result from Claude streaming progress", () => {
    const value = parseProviderOutput("claude-stream-json", [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 42 }),
      JSON.stringify({ type: "result", subtype: "success", structured_output: { verdict: "pass", summary: "streamed" } })
    ].join("\n"));
    expect(value).toEqual({ verdict: "pass", summary: "streamed" });
  });

  it("extracts the final agent message from Codex JSONL progress", () => {
    const value = parseProviderOutput("codex-stream-json", [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "working" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "```json\n{\"message\":\"done\"}\n```" } }),
      JSON.stringify({ type: "turn.completed" })
    ].join("\n"));
    expect(value).toEqual({ message: "done" });
  });

  it("keeps domain Block separate from schema failure", () => {
    const output = { verdict: "Block", summary: "Missing runtime evidence" } as const;
    validateStructuredOutput(
      {
        type: "object",
        required: ["verdict", "summary"],
        properties: { verdict: { enum: ["Pass", "Block"] }, summary: { type: "string" } }
      },
      output,
      "review"
    );
    expect(statusFromVerdict(output, { path: "verdict", pass: ["Pass"], block: ["Block"] })).toBe("blocked");
  });

  it("accepts JSON Pointer verdict paths emitted by versioned Employee records", () => {
    const output = {
      verdict: "Pass",
      nested: { "review/status": ["Block", "Pass"] }
    };

    expect(statusFromVerdict(output, { path: "/verdict", pass: ["Pass"], block: ["Block"] })).toBe("passed");
    expect(statusFromVerdict(output, { path: "/nested/review~1status/0", pass: ["Pass"], block: ["Block"] })).toBe("blocked");
  });
});
