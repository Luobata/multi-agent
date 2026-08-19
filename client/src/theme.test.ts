/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_THEME, THEME_STORAGE_KEY, applyTheme, readTheme } from "./theme";

/** styles.css 是聚合入口：按其中 @import 顺序拼接 styles/ 切片，还原与拆分前逐字节等价的全量样式文本。 */
const readStylesCss = () => {
  const entry = readFileSync(`${process.cwd()}/client/src/styles.css`, "utf8");
  const slices = [...entry.matchAll(/@import "\.\/styles\/([^"]+)";/g)];
  if (slices.length === 0) return entry;
  return slices.map((match) => readFileSync(`${process.cwd()}/client/src/styles/${match[1]}`, "utf8")).join("");
};

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
  it("uses a multi-weight local CJK stack and stable weight for strong dossier titles", () => {
    const tokens = readFileSync(`${process.cwd()}/client/src/tokens.css`, "utf8");
    const styles = readStylesCss();
    expect(tokens).toMatch(/--font-display-strong:\s*"PingFang SC",\s*"Hiragino Sans GB",\s*"Microsoft YaHei"/);
    expect(styles).toMatch(/\.dossier-title-row h2\s*\{[^}]*font-family:\s*var\(--font-display-strong\);[^}]*font-weight:\s*700;/s);
  });

  it("defines every global design token referenced by component styles", () => {
    const tokens = readFileSync(`${process.cwd()}/client/src/tokens.css`, "utf8");
    const styles = readStylesCss();
    const definitions = new Set([...(tokens + styles).matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
    const localComponentProperties = new Set(["depth", "dossier-accent", "node-accent", "role-accent"]);
    const unresolved = [...new Set([...styles.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]))]
      .filter((token) => !definitions.has(token) && !localComponentProperties.has(token))
      .sort();
    expect(unresolved).toEqual([]);
  });

  it("defaults to crayon when nothing stored", () => {
    expect(readTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("crayon");
  });

  it("returns the stored theme when valid", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "pixel");
    expect(readTheme()).toBe("pixel");
  });

  it("falls back to default on an unknown stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "banana");
    expect(readTheme()).toBe("crayon");
  });

  it("applyTheme sets the data-theme attribute and persists", () => {
    applyTheme("pixel");
    expect(document.documentElement.getAttribute("data-theme")).toBe("pixel");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("pixel");
  });
});
