import { describe, expect, it } from "vitest";
import { TemplateRenderError } from "../src/core/errors.js";
import { renderTemplate } from "../src/core/template.js";

describe("strict templates", () => {
  it("renders objects and hyphenated dependency ids", () => {
    expect(
      renderTemplate("{{needs.product-review.output}}", {
        needs: { "product-review": { output: { verdict: "Pass" } } }
      })
    ).toBe('{\n  "verdict": "Pass"\n}');
  });

  it("rejects missing context instead of sending a partial prompt", () => {
    expect(() => renderTemplate("Review {{input.requirement}} for {{input.user}}", { input: { requirement: "R" } })).toThrow(
      TemplateRenderError
    );
  });
});
