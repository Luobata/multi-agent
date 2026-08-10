import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git/Codex worktrees contain historical copies of this same suite. Running them from the
    // primary checkout duplicates tests, exercises stale manifests, and can race on loopback ports.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      ".multi-agent/**"
    ]
  }
});
