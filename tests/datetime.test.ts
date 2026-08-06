// tests/datetime.test.ts
import { describe, it, expect } from "vitest";
import { formatDateTime } from "../src/config/datetime.js";

describe("formatDateTime", () => {
  it("formats ISO 8601 to YYYY-MM-DD HH:mm:ss", () => {
    // 用带偏移的固定时刻，断言各字段存在且形态正确
    const out = formatDateTime("2026-08-06T22:11:05.000Z");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("returns input unchanged when not a valid date", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("returns input unchanged for empty string", () => {
    expect(formatDateTime("")).toBe("");
  });
});
