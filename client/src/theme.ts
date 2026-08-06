export type ThemeName = "crayon" | "pixel";

export const DEFAULT_THEME: ThemeName = "crayon";
export const THEME_STORAGE_KEY = "workbench-theme";

const THEMES: readonly ThemeName[] = ["crayon", "pixel"];

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function readTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; ignore storage failures (private mode, quota).
  }
}
