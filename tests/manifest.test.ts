import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { ArchitectureRegistry } from "../src/architectures/types.js";
import { loadManifest } from "../src/config/loadManifest.js";
import { compilePlan, formatPlanMermaid } from "../src/core/plan.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";

const temporaryDirectories: string[] = [];

function copyTemplate(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-manifest-"));
  temporaryDirectories.push(directory);
  fs.cpSync(path.resolve("templates/review-council"), directory, { recursive: true });
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("manifest compilation", () => {
  it("compiles independent reviewers into one parallel wave and the chair into the next", () => {
    const directory = copyTemplate();
    const loaded = loadManifest(path.join(directory, "multi-agent.yaml"));
    const plan = compilePlan(loaded, "review-council");

    expect(plan.data.waves).toEqual([
      ["product-review", "design-review", "test-review"],
      ["final-decision"]
    ]);
    expect(formatPlanMermaid(plan)).toContain("product_review --> final_decision");
    expect(plan.nodes[0]?.with).toEqual({ __previousAttemptError: "" });
  });

  it("reports cycles as an architecture error", () => {
    const directory = copyTemplate();
    const manifestPath = path.join(directory, "multi-agent.yaml");
    const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.workflows["review-council"].config.nodes[0].needs = ["final-decision"];
    fs.writeFileSync(manifestPath, YAML.stringify(manifest));

    expect(() => loadManifest(manifestPath)).toThrow(/dependency cycle/);
  });

  it("rejects prompt paths that escape the manifest directory", () => {
    const directory = copyTemplate();
    const manifestPath = path.join(directory, "multi-agent.yaml");
    const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.roles.designer.instructions = "../outside.md";
    fs.writeFileSync(manifestPath, YAML.stringify(manifest));

    expect(() => loadManifest(manifestPath)).toThrow(/must stay inside/);
  });

  it("rejects malformed output schemas during validation", () => {
    const directory = copyTemplate();
    fs.writeFileSync(path.join(directory, "schemas", "reviewer-output.schema.json"), "{not-json");

    expect(() => loadManifest(path.join(directory, "multi-agent.yaml"))).toThrow(/not a valid JSON Schema/);
  });

  it("rejects unknown skills and invalid skill configuration", () => {
    const directory = copyTemplate();
    const manifestPath = path.join(directory, "multi-agent.yaml");
    const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.roles.designer.skills = ["unknown-skill"];
    manifest.roles["product-manager"].skills[0].config.includeAlternatives = "yes";
    fs.writeFileSync(manifestPath, YAML.stringify(manifest));

    expect(() => loadManifest(manifestPath)).toThrow(/unknown skill|skill requirement-analysis config is invalid/);
  });

  it("loads a custom provider adapter through an injected registry", () => {
    const directory = copyTemplate();
    const manifestPath = path.join(directory, "multi-agent.yaml");
    const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.providers["local-mock"] = {
      adapter: "remote-model",
      endpoint: "https://models.example.test/invoke",
      outputProtocol: "json"
    };
    fs.writeFileSync(manifestPath, YAML.stringify(manifest));

    expect(() => loadManifest(manifestPath)).toThrow(/unregistered adapter remote-model/);

    const providers: ProviderRegistry = new Map([
      [
        "remote-model",
        {
          id: "remote-model",
          validate: ({ definition }) =>
            typeof (definition as unknown as { endpoint?: unknown }).endpoint === "string" ? [] : ["endpoint is required"],
          invoke: async () => ({ stdout: "{}", stderr: "", durationMs: 1 })
        }
      ]
    ]);
    expect(loadManifest(manifestPath, { providers }).manifest.providers["local-mock"]?.adapter).toBe("remote-model");
  });

  it("loads a custom architecture through an injected registry", () => {
    const directory = copyTemplate();
    const manifestPath = path.join(directory, "multi-agent.yaml");
    const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.workflows["review-council"].architecture = "custom-council";
    fs.writeFileSync(manifestPath, YAML.stringify(manifest));

    expect(() => loadManifest(manifestPath)).toThrow(/unregistered architecture custom-council/);

    const architectures: ArchitectureRegistry = new Map([
      [
        "custom-council",
        {
          id: "custom-council",
          validate: () => [],
          compile: (loaded, workflow) => ({
            architecture: "custom-council",
            workflow,
            nodes: [{ id: "custom-node", role: "chair", provider: loaded.manifest.roles.chair!.provider, needs: [], with: {} }],
            data: {}
          }),
          formatText: () => "custom",
          formatMermaid: () => "flowchart LR",
          execute: async () => undefined
        }
      ]
    ]);
    const loaded = loadManifest(manifestPath, { architectures });
    expect(compilePlan(loaded, "review-council", architectures).architecture).toBe("custom-council");
  });
});
