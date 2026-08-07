import { describe, it, expect } from "vitest";
import { summarizerContent } from "../src/memory/extractor.js";

describe("summarizerContent", () => {
  it("returns a plain string output unchanged", () => {
    expect(summarizerContent("已按历史阶梯执行改价")).toBe("已按历史阶梯执行改价");
  });

  it("prefers the summary field of a structured (codex JSON) output", () => {
    expect(summarizerContent({ summary: "改价走阶梯规则", extra: 1 })).toBe("改价走阶梯规则");
  });

  it("trims whitespace from a summary field", () => {
    expect(summarizerContent({ summary: "  经验  " })).toBe("经验");
  });

  it("falls back to JSON.stringify when there is no usable summary field", () => {
    expect(summarizerContent({ note: "no summary here" })).toBe(JSON.stringify({ note: "no summary here" }));
  });

  it("ignores a non-string or empty summary field and stringifies", () => {
    expect(summarizerContent({ summary: "" })).toBe(JSON.stringify({ summary: "" }));
    expect(summarizerContent({ summary: 42 })).toBe(JSON.stringify({ summary: 42 }));
  });

  it("returns empty string for null/undefined output", () => {
    expect(summarizerContent(undefined)).toBe("");
    expect(summarizerContent(null)).toBe("");
  });
});
