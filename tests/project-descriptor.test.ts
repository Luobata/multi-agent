import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { ensureProjectDescriptor, loadProjectDescriptor } from "../src/workbench/projectDescriptor.js";

const directories: string[] = [];

function temporaryProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-project-descriptor-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project descriptor", () => {
  it("scaffolds a valid starter descriptor after explicit MCP onboarding", async () => {
    const root = temporaryProject();

    const ensured = await ensureProjectDescriptor({
      rootPath: root,
      createDescriptorIfMissing: true,
      projectIdHint: "vibe-docing",
      projectNameHint: "Vibe Docing"
    });
    const project = await loadProjectDescriptor({ rootPath: root });
    const realRoot = fs.realpathSync(root);

    expect(ensured).toEqual({ descriptorPath: path.join(realRoot, "multi-agent.project.yaml"), created: true });
    expect(project).toMatchObject({
      id: "vibe-docing",
      name: "Vibe Docing",
      rootPath: realRoot,
      connector: { kind: "mcp", config: { discovery: "passive" } },
      roles: [{ id: "project-member", permissions: { write: "project" } }]
    });
  });

  it("never overwrites an existing descriptor during MCP onboarding", async () => {
    const root = temporaryProject();
    const descriptorPath = path.join(root, "multi-agent.project.yaml");
    const existing = [
      "# keep this project-owned declaration",
      "version: 1",
      "project:",
      "  id: existing-project",
      "roles:",
      "  reviewer:",
      "    instructions: Keep the existing policy."
    ].join("\n");
    fs.writeFileSync(descriptorPath, existing, "utf8");

    const ensured = await ensureProjectDescriptor({
      rootPath: root,
      createDescriptorIfMissing: true,
      projectIdHint: "replacement"
    });

    expect(ensured).toEqual({ descriptorPath: path.join(fs.realpathSync(root), "multi-agent.project.yaml"), created: false });
    expect(fs.readFileSync(descriptorPath, "utf8")).toBe(existing);
  });

  it("refuses to scaffold a descriptor outside the project root", async () => {
    const root = temporaryProject();
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.yaml`);

    await expect(ensureProjectDescriptor({
      rootPath: root,
      descriptorPath: `../${path.basename(outside)}`,
      createDescriptorIfMissing: true
    })).rejects.toThrow(/must stay inside the project root/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("refuses to scaffold through a symlinked directory outside the project root", async () => {
    const root = temporaryProject();
    const outside = temporaryProject();
    fs.symlinkSync(outside, path.join(root, "external"), "dir");

    await expect(ensureProjectDescriptor({
      rootPath: root,
      descriptorPath: "external/multi-agent.project.yaml",
      createDescriptorIfMissing: true
    })).rejects.toThrow(/must stay inside the project root/);
    expect(fs.existsSync(path.join(outside, "multi-agent.project.yaml"))).toBe(false);
  });

  it("refuses to treat an outside file symlink as an existing project descriptor", async () => {
    const root = temporaryProject();
    const outside = temporaryProject();
    const outsideDescriptor = path.join(outside, "outside.yaml");
    fs.writeFileSync(outsideDescriptor, "outside project data", "utf8");
    fs.symlinkSync(outsideDescriptor, path.join(root, "multi-agent.project.yaml"), "file");

    await expect(ensureProjectDescriptor({
      rootPath: root,
      createDescriptorIfMissing: true
    })).rejects.toThrow(/must stay inside the project root/);
    expect(fs.readFileSync(outsideDescriptor, "utf8")).toBe("outside project data");
  });

  it("resolves project-owned policy and output-schema references without copying them into YAML", async () => {
    const root = temporaryProject();
    fs.mkdirSync(path.join(root, "agent", "policies"), { recursive: true });
    fs.mkdirSync(path.join(root, "agent", "schemas"), { recursive: true });
    fs.writeFileSync(path.join(root, "agent", "policies", "tester.md"), "PROJECT_TEST_POLICY", "utf8");
    fs.writeFileSync(path.join(root, "agent", "schemas", "tester.json"), JSON.stringify({
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } }
    }), "utf8");
    fs.writeFileSync(path.join(root, "multi-agent.project.yaml"), [
      "version: 1",
      "project:",
      "  id: cart-review",
      "  name: Cart Review",
      "  scope: repository",
      "connector:",
      "  kind: worktree-review",
      "roles:",
      "  tester:",
      "    displayName: Tester",
      "    description: Browser acceptance",
      "    requiredSkills: [browser-e2e-validation]",
      "    policyRef: agent/policies/tester.md",
      "    outputSchemaRef: agent/schemas/tester.json",
      "    permissions:",
      "      write: none"
    ].join("\n"), "utf8");

    const project = await loadProjectDescriptor({ rootPath: root });

    expect(project).toMatchObject({
      id: "cart-review",
      name: "Cart Review",
      scope: "repository",
      connector: { kind: "worktree-review" }
    });
    expect(project.roles[0]).toMatchObject({
      id: "tester",
      requiredSkills: ["browser-e2e-validation"],
      instructions: "PROJECT_TEST_POLICY",
      permissions: { write: "none" }
    });
    expect(project.roles[0]?.outputSchema?.required).toEqual(["message"]);
  });

  it("rejects policy references that escape the project root", async () => {
    const root = temporaryProject();
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.md`);
    fs.writeFileSync(outside, "not project-owned", "utf8");
    directories.push(outside);
    fs.writeFileSync(path.join(root, "multi-agent.project.yaml"), [
      "version: 1",
      "project:",
      "  id: unsafe-project",
      "roles:",
      "  tester:",
      `    policyRef: ../${path.basename(outside)}`
    ].join("\n"), "utf8");

    await expect(loadProjectDescriptor({ rootPath: root })).rejects.toThrow(/must stay inside the project root/);
  });

  it("requires e2e evidence in the tester project role output contract", async () => {
    // The cart-fe descriptor's policyRef docs are not vendored in this repo, so
    // loadProjectDescriptor cannot resolve them; assert the inline outputSchema
    // deliverable directly via the same YAML parser the loader uses.
    const descriptor = YAML.parse(
      fs.readFileSync(path.resolve("templates/workbench/cart-fe-workflow-review.project.yaml"), "utf8")
    ) as { roles: Record<string, { outputSchema?: any }> };
    const tester = descriptor.roles.tester;
    expect(tester?.outputSchema?.required).toEqual(["verdict", "summary", "e2eEvidence"]);
    expect(tester?.outputSchema?.properties?.e2eEvidence?.items?.properties?.method?.enum)
      .toEqual(["browser", "http-behavior", "automation-run"]);
  });

  it("connects the review project to the conversational requirement steward", async () => {
    const descriptor = YAML.parse(
      fs.readFileSync(path.resolve("templates/workbench/cart-fe-workflow-review.project.yaml"), "utf8")
    ) as { roles: Record<string, { outputSchema?: any; permissions?: { write?: string } }> };
    const binding = JSON.parse(
      fs.readFileSync(path.resolve("templates/workbench/cart-fe-workflow-review.binding.json"), "utf8")
    ) as { roles: Array<{ roleId: string; employeeId: string }> };

    expect(descriptor.roles["requirement-steward"]).toMatchObject({
      permissions: { write: "none" },
      outputSchema: expect.objectContaining({ required: ["message", "nextAction", "draft"] })
    });
    expect(binding.roles).toContainEqual(expect.objectContaining({
      roleId: "requirement-steward",
      employeeId: "xiaomiwang-product-manager"
    }));
  });

  it("seeds the frontend project Employee on the Codex Provider", () => {
    const employee = JSON.parse(
      fs.readFileSync(path.resolve("templates/workbench/mihuhu-frontend-engineer.employee.json"), "utf8")
    ) as { providerId?: string; identity?: { metadata?: { providerPersona?: string } } };

    expect(employee.providerId).toBe("codex");
    expect(employee.identity?.metadata?.providerPersona).toBe("codex");
  });

  it("connects every current Employee through a bounded project role", async () => {
    const root = path.resolve(".");
    const project = await loadProjectDescriptor({ rootPath: root, descriptorPath: "multi-agent.project.yaml" });
    const expectedAssignments = [
      ["product-manager", "xiaomiwang-product-manager"],
      ["requirement-steward", "xiaomiwang-product-manager"],
      ["product-designer", "lin-mo-product-designer"],
      ["frontend-developer", "mihuhu-frontend-engineer"],
      ["backend-developer", "huotuizhu-product-manager"],
      ["fullstack-developer", "yaoxi-programmer"],
      ["test-engineer", "xiaomixiang-tester"],
      ["knowledge-steward", "local-agent-workbench-knowledge-steward"],
      ["configuration-steward", "local-agent-workbench-configuration-steward"],
      ["gate-steward", "local-agent-workbench-gate-steward"]
    ];

    expect(project).toMatchObject({
      id: "local-agent-workbench",
      rootPath: root,
      connector: { kind: "repository-development", config: { sourceRoots: ["src", "client"] } }
    });
    expect(project.roles.map((role) => role.id)).toEqual(expectedAssignments.map(([roleId]) => roleId));

    const frontend = project.roles.find((role) => role.id === "frontend-developer");
    expect(frontend).toMatchObject({
      knowledgeProfileIds: ["workbench-engineering-knowledge", "workbench-design-knowledge"],
      permissions: {
        write: "project",
        tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]
      }
    });
    expect(frontend?.instructions).toContain("所有前端实现任务");

    const designer = project.roles.find((role) => role.id === "product-designer");
    expect(designer).toMatchObject({
      requiredSkills: ["hallmark", "interaction-state-completeness"],
      optionalSkills: ["healing-pixel-dossier"],
      permissions: { write: "none" }
    });

    const requirementSteward = project.roles.find((role) => role.id === "requirement-steward");
    expect(requirementSteward).toMatchObject({
      requiredSkills: ["humanizer-zh"],
      permissions: { write: "none" },
      outputSchema: expect.objectContaining({ required: ["message", "nextAction", "draft"] })
    });

    const knowledgeSteward = project.roles.find((role) => role.id === "knowledge-steward");
    expect(knowledgeSteward).toMatchObject({
      requiredSkills: ["knowledge-control-conversation"],
      requiredProviderProfiles: ["knowledge-proposal-only"],
      knowledgeProfileIds: [],
      permissions: {
        write: "none",
        tools: expect.arrayContaining(["knowledge_control_snapshot", "knowledge_change_propose"])
      }
    });
    expect(knowledgeSteward?.permissions?.tools).not.toContain("knowledge_change_approve");

    const configurationSteward = project.roles.find((role) => role.id === "configuration-steward");
    expect(configurationSteward).toMatchObject({
      requiredSkills: ["configuration-control-conversation"],
      requiredProviderProfiles: ["configuration-proposal-only"],
      knowledgeProfileIds: [],
      permissions: {
        write: "none",
        tools: [
          "configuration_control_snapshot",
          "configuration_proposal_list",
          "configuration_proposal_get",
          "configuration_proposal_create"
        ]
      }
    });
    expect(configurationSteward?.permissions?.tools).not.toEqual(expect.arrayContaining([
      "configuration_proposal_review",
      "configuration_proposal_apply",
      "update_employee"
    ]));

    const testEngineer = project.roles.find((role) => role.id === "test-engineer");
    expect(testEngineer?.outputSchema?.required).toEqual(["verdict", "summary", "e2eEvidence"]);
    expect((testEngineer?.outputSchema?.properties as any)?.e2eEvidence?.items?.properties?.method?.enum)
      .toEqual(["browser", "http-behavior", "automation-run"]);

    const binding = JSON.parse(
      fs.readFileSync(path.join(root, "templates/workbench/local-agent-workbench.binding.json"), "utf8")
    ) as { roles: Array<{ roleId: string; employeeId: string }> };
    expect(binding.roles.map(({ roleId, employeeId }) => [roleId, employeeId])).toEqual(expectedAssignments);
  });
});
