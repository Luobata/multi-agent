import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  cacheDir: fileURLToPath(new URL(".vite-cache/vitest", import.meta.url)),
  test: {
    // Git/Codex worktrees contain historical copies of this same suite. Running them from the
    // primary checkout duplicates tests, exercises stale manifests, and can race on loopback ports.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "e2e/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      ".multi-agent/**"
    ]
  }
});
