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
});
