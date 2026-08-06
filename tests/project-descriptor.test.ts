import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadProjectDescriptor } from "../src/workbench/projectDescriptor.js";

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

  it("connects every current Employee through a bounded project role", async () => {
    const root = path.resolve(".");
    const project = await loadProjectDescriptor({ rootPath: root, descriptorPath: "multi-agent.project.yaml" });
    const expectedAssignments = [
      ["product-manager", "xiaomiwang-product-manager"],
      ["product-designer", "lin-mo-product-designer"],
      ["frontend-developer", "mihuhu-frontend-engineer"],
      ["backend-developer", "huotuizhu-product-manager"],
      ["fullstack-developer", "yaoxi-programmer"],
      ["test-engineer", "xiaomixiang-tester"],
      ["knowledge-steward", "local-agent-workbench-knowledge-steward"],
      ["configuration-steward", "local-agent-workbench-configuration-steward"]
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
