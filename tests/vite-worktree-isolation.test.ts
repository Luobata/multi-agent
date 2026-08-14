import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import clientConfig from "../client/vite.config.js";
import testConfig from "../vitest.config.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("Vite configuration isolation", () => {
  it("uses runner config loading and worktree-local caches", () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const script of ["build:client", "dev:client", "test"]) expect(scripts[script]).toContain("--configLoader runner");
    for (const cacheDir of [clientConfig.cacheDir, testConfig.cacheDir]) {
      expect(typeof cacheDir).toBe("string");
      expect(path.relative(repositoryRoot, cacheDir as string)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect(cacheDir).toContain(`${path.sep}.vite-cache${path.sep}`);
      expect(cacheDir).not.toContain(`${path.sep}node_modules${path.sep}`);
    }
  });
});
