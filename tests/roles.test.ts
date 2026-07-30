import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/config/loadManifest.js";
import { renderRoleSystemPrompt, resolveRoleProfile } from "../src/core/roles.js";

const config = path.resolve("templates/review-council/multi-agent.yaml");

describe("role profile composition", () => {
  it("composes identity, responsibilities, skill instructions, config, and effective tools", () => {
    const loaded = loadManifest(config);
    const profile = resolveRoleProfile(loaded, "product-manager");
    const prompt = renderRoleSystemPrompt(profile, {
      input: {},
      role: { id: "product-manager" },
      run: { artifactDir: "/tmp/artifacts" }
    });

    expect(profile.definition.identity.displayName).toBe("Product Manager");
    expect(profile.effectiveTools).toEqual(["read-repository"]);
    expect(prompt).toContain("An independent product reviewer");
    expect(prompt).toContain("Separate explicit requirements from assumptions");
    expect(prompt).toContain("Requirement Analysis");
    expect(prompt).toContain("product-acceptance");
    expect(prompt).toContain("Keep product evidence independent");
  });
});
