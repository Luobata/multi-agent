/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEME_STORAGE_KEY, applyTheme, readTheme } from "./theme";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
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
