import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkbenchService,
  type ConfigurationProposal,
  type ConfigurationProposalCreateInput,
  type EmployeeCreateInput,
  type SkillCreateInput
} from "../src/index.js";

const directories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-configuration-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function proposalInput(overrides: Partial<ConfigurationProposalCreateInput> = {}): ConfigurationProposalCreateInput {
  return {
    title: "聚焦配置职责",
    reason: "让员工提示词与当前交付边界一致。",
    operations: [{
      type: "prompts.set",
      rationale: "明确要求保留证据。",
      risk: "medium",
      payload: {
        systemPrompt: "Preserve evidence and report uncertainty.",
        requestPrompt: "Complete the scoped request and return JSON."
      }
    }],
    sourceRunId: "run-configuration-control",
    ...overrides
  };
}

function reviewDecision(
  proposal: Pick<ConfigurationProposal, "reviewRevision" | "reviewHash">,
  decision: "accepted" | "rejected",
  comment?: string
) {
  return {
    decision,
    expectedReviewRevision: proposal.reviewRevision,
    expectedReviewHash: proposal.reviewHash,
    ...(comment ? { comment } : {})
  };
}

async function fixture() {
  const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
  await service.createSkill({
    id: "retained-skill",
    displayName: "Retained Skill",
    description: "A version-pinned test Skill.",
    instructions: "Retained Skill v1 instructions."
  });
  const employee = await service.createEmployee({
    id: "draft-target",
    identity: { displayName: "Draft Target", background: "Handles scoped work.", responsibilities: ["Deliver"] },
    systemPrompt: "Original system prompt.",
    requestPrompt: "Original request prompt.",
    skills: ["retained-skill"],
    permissions: { write: "none", tools: [] }
  });
  await service.updateSkill("retained-skill", { instructions: "Retained Skill v2 instructions." });
  const controlTools = [
    "configuration_control_snapshot",
    "configuration_proposal_list",
    "configuration_proposal_get",
    "configuration_proposal_create"
  ];
  await service.createProject({
    id: "local-agent-workbench",
    rootPath: service.store.dataRoot,
    descriptorPath: path.join(service.store.dataRoot, "multi-agent.project.yaml"),
    roles: [{
      id: "configuration-steward",
      displayName: "Configuration Steward",
      description: "Draft governed Employee configuration proposals.",
      instructions: "Use only the restricted configuration tools.",
      permissions: { write: "none", tools: controlTools }
    }]
  });
  const steward = await service.createEmployee({
    id: "configuration-steward",
    identity: {
      displayName: "Configuration Steward",
      background: "A project-internal control Employee.",
      responsibilities: ["Draft configuration proposals"],
      metadata: {
        internalProjectId: "local-agent-workbench",
        internalProjectRoleId: "configuration-steward"
      }
    },
    scope: { kind: "project", projectId: "local-agent-workbench", projectVersion: 1 },
    providerId: "codex-configuration-control",
    permissions: { write: "none", tools: controlTools }
  });
  await service.saveProjectBinding("local-agent-workbench", {
    roles: [{ roleId: "configuration-steward", employeeId: steward.id }]
  });
  const timestamp = "2026-08-04T00:00:00.000Z";
  await service.store.mutate((state) => {
    state.sessions["session-configuration-control"] = {
      id: "session-configuration-control",
      employeeId: steward.id,
      employeeVersion: steward.version,
      assignment: {
        projectId: "local-agent-workbench",
        projectVersion: 1,
        projectBindingVersion: 1,
        roleId: "configuration-steward"
      },
      title: "Configure draft-target",
      status: "active",
      context: {
        kind: "employee-configuration",
        employeeId: "draft-target",
        expectedEmployeeVersion: 1
      },
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.invocations["inv-configuration-control"] = {
      id: "inv-configuration-control",
      target: { kind: "employee", id: steward.id, version: steward.version },
      source: {
        kind: "workbench",
        project: "local-agent-workbench",
        projectRole: "configuration-steward",
        projectBindingVersion: 1
      },
      status: "running",
      phase: "provider",
      requestSummary: "[Employee target: draft-target · expected v1] Draft a configuration proposal",
      requestContext: {
        kind: "employee-configuration",
        employeeId: "draft-target",
        expectedEmployeeVersion: 1
      },
      runId: "run-configuration-control",
      sessionId: "session-configuration-control",
      instanceIds: [],
      executionSnapshot: {
        workflow: { id: "project-local-agent-workbench-configuration-steward", version: 1, architecture: "graph" },
        employees: [{ roleId: "respond", employeeId: steward.id, employeeVersion: steward.version }]
      },
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
      transitions: [{ at: timestamp, status: "running", phase: "provider" }]
    };
  });
  const attest = async (proposalId: string) => service.store.mutate((state) => {
    const invocation = state.invocations["inv-configuration-control"]!;
    invocation.status = "completed";
    invocation.phase = "done";
    invocation.completedAt = timestamp;
    invocation.updatedAt = timestamp;
    invocation.transitions.push({ at: timestamp, status: "completed", phase: "done" });
    const session = state.sessions["session-configuration-control"]!;
    session.messages.push({
      id: `attestation-${proposalId}`,
      role: "employee",
      content: `Created ${proposalId}`,
      at: timestamp,
      runId: invocation.runId,
      output: { message: "Proposal created.", proposalIds: [proposalId] }
    });
    return state.configurationProposals[proposalId]!;
  });
  return { service, employee, attest };
}

describe("Employee configuration proposals", () => {
  it("keeps AI drafting and item decisions write-free, then applies accepted items as exactly one Employee version", async () => {
    const { service, attest } = await fixture();
    await service.createProject({
      id: "pinned-project",
      rootPath: service.store.dataRoot,
      descriptorPath: path.join(service.store.dataRoot, "multi-agent.project.yaml"),
      roles: [{ id: "worker", displayName: "Worker", description: "Pinned worker.", instructions: "Work." }]
    });
    await service.saveProjectBinding("pinned-project", { roles: [{ roleId: "worker", employeeId: "draft-target" }] });
    const invocation = await service.invokeEmployee("draft-target", { message: "Open a pinned session" });

    const proposal = await service.createConfigurationProposal(proposalInput({
      operations: [
        proposalInput().operations[0]!,
        {
          type: "permissions.set",
          rationale: "AI suggests project writes, which the reviewer will reject.",
          risk: "high",
          payload: { permissions: { write: "project", tools: ["Read", "Edit"] } }
        }
      ]
    }));
    await attest(proposal.id);

    expect(proposal.status).toBe("awaiting-review");
    expect(proposal.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.source).toMatchObject({
      invocationId: "inv-configuration-control",
      projectId: "local-agent-workbench",
      projectVersion: 1,
      projectRoleId: "configuration-steward",
      projectBindingVersion: 1,
      employeeId: "configuration-steward",
      employeeVersion: 1,
      sessionId: "session-configuration-control",
      runId: "run-configuration-control"
    });
    expect(proposal.reviewItems.map((item) => item.operationType)).toEqual(["prompts.set", "permissions.set"]);
    expect(service.getEmployee("draft-target")).toMatchObject({ version: 1, systemPrompt: "Original system prompt.", permissions: { write: "none" } });

    const firstReview = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[0]!.id,
      reviewDecision(proposal, "accepted")
    );
    const ready = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[1]!.id,
      reviewDecision(firstReview, "rejected")
    );
    expect(ready.status).toBe("ready-to-apply");
    expect(ready.progress).toEqual({ total: 2, reviewed: 2, accepted: 1, rejected: 1, pending: 0 });
    expect(service.getEmployee("draft-target").version).toBe(1);

    const applied = await service.applyConfigurationProposal(proposal.id, {
      expectedReviewRevision: ready.reviewRevision,
      expectedReviewHash: ready.reviewHash
    });
    expect(applied).toMatchObject({
      status: "applied",
      result: { employeeId: "draft-target", employeeVersion: 2 },
      application: {
        actor: "local-owner",
        reviewRevision: 2,
        acceptedReviewItemIds: [proposal.reviewItems[0]!.id],
        fromEmployeeVersion: 1,
        toEmployeeVersion: 2
      }
    });
    expect(service.getEmployee("draft-target")).toMatchObject({
      version: 2,
      systemPrompt: "Preserve evidence and report uncertainty.",
      requestPrompt: "Complete the scoped request and return JSON.",
      permissions: { write: "none", tools: [] }
    });
    expect(service.getEmployeeVersions("draft-target")).toHaveLength(2);
    expect(service.getSession(invocation.session.id).employeeVersion).toBe(1);
    expect(service.getProjectBinding("pinned-project").roles[0]?.employeeVersion).toBe(1);
  });

  it("marks version or plan drift as needs-reapproval without rebasing or writing a second version", async () => {
    const { service, attest } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput());
    await attest(proposal.id);
    const ready = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[0]!.id,
      reviewDecision(proposal, "accepted")
    );
    await service.updateEmployee("draft-target", { description: "A concurrent human edit." });

    await expect(service.applyConfigurationProposal(proposal.id, {
      expectedReviewRevision: ready.reviewRevision,
      expectedReviewHash: ready.reviewHash
    })).rejects.toThrow(/needs reapproval/);

    expect(service.getConfigurationProposal(proposal.id)).toMatchObject({ status: "needs-reapproval" });
    expect(service.getEmployee("draft-target")).toMatchObject({
      version: 2,
      description: "A concurrent human edit.",
      systemPrompt: "Original system prompt."
    });
    expect(service.getEmployeeVersions("draft-target")).toHaveLength(2);
  });

  it("quarantines a proposal when its source Run reaches a terminal failure without attestation", async () => {
    const { service } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput());
    await service.store.mutate((state) => {
      const invocation = state.invocations[proposal.source.invocationId]!;
      invocation.status = "failed";
      invocation.phase = "failed";
      invocation.error = "Provider output validation failed";
      invocation.completedAt = "2026-08-04T00:01:00.000Z";
      invocation.updatedAt = invocation.completedAt;
      invocation.transitions.push({ at: invocation.completedAt, status: "failed", phase: "failed" });
    });

    await expect(service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[0]!.id,
      reviewDecision(proposal, "accepted")
    )).rejects.toThrow(/source run is failed; create a fresh proposal/);
    expect(service.getConfigurationProposal(proposal.id)).toMatchObject({
      status: "needs-reapproval",
      validation: { valid: false }
    });
    expect(service.getEmployee("draft-target").version).toBe(1);
  });

  it("quarantines a completed source Run when its Session attestation is still missing after the crash grace period", async () => {
    const { service } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput());
    await service.store.mutate((state) => {
      const invocation = state.invocations[proposal.source.invocationId]!;
      invocation.status = "completed";
      invocation.phase = "done";
      invocation.completedAt = "2000-01-01T00:00:00.000Z";
      invocation.updatedAt = invocation.completedAt;
      invocation.transitions.push({ at: invocation.completedAt, status: "completed", phase: "done" });
    });

    await expect(service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[0]!.id,
      reviewDecision(proposal, "accepted")
    )).rejects.toThrow(/completed without attestation; create a fresh proposal/);
    expect(service.getConfigurationProposal(proposal.id)).toMatchObject({
      status: "needs-reapproval",
      validation: { valid: false }
    });
  });

  it("uses append-only latest decisions and never treats a fully rejected proposal as applicable", async () => {
    const { service, attest } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput());
    await attest(proposal.id);
    const itemId = proposal.reviewItems[0]!.id;
    const accepted = await service.decideConfigurationReviewItem(
      proposal.id,
      itemId,
      reviewDecision(proposal, "accepted")
    );
    const rejected = await service.decideConfigurationReviewItem(
      proposal.id,
      itemId,
      reviewDecision(accepted, "rejected", "Keep the current prompts.")
    );

    expect(rejected.decisions).toHaveLength(2);
    expect(rejected.progress).toEqual({ total: 1, reviewed: 1, accepted: 0, rejected: 1, pending: 0 });
    expect(rejected.status).toBe("awaiting-review");
    expect(rejected.validation).toEqual({ valid: false, errors: ["至少接受一项配置变更后才能应用。"] });
    await expect(service.applyConfigurationProposal(proposal.id, {
      expectedReviewRevision: rejected.reviewRevision,
      expectedReviewHash: rejected.reviewHash
    })).rejects.toThrow(/awaiting-review/);
    expect(service.getEmployee("draft-target").version).toBe(1);
  });

  it("refuses to apply when another reviewer changes the final decision snapshot", async () => {
    const { service, attest } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput({
      operations: [
        proposalInput().operations[0]!,
        {
          type: "permissions.set",
          rationale: "Allow project writes only if a human explicitly confirms it.",
          risk: "high",
          payload: { permissions: { write: "project", tools: ["Read", "Edit"] } }
        }
      ]
    }));
    await attest(proposal.id);
    const firstReview = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[0]!.id,
      reviewDecision(proposal, "accepted")
    );
    const firstFinalSnapshot = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[1]!.id,
      reviewDecision(firstReview, "rejected")
    );
    await expect(service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[1]!.id,
      reviewDecision(firstReview, "accepted")
    )).rejects.toThrow(/review changed; reload and confirm/);
    const changedSnapshot = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[1]!.id,
      reviewDecision(firstFinalSnapshot, "accepted")
    );

    await expect(service.applyConfigurationProposal(proposal.id, {
      expectedReviewRevision: firstFinalSnapshot.reviewRevision,
      expectedReviewHash: firstFinalSnapshot.reviewHash
    })).rejects.toThrow(/review changed; reload and confirm/);
    expect(service.getEmployee("draft-target")).toMatchObject({ version: 1, permissions: { write: "none" } });

    await service.applyConfigurationProposal(proposal.id, {
      expectedReviewRevision: changedSnapshot.reviewRevision,
      expectedReviewHash: changedSnapshot.reviewHash
    });
    expect(service.getEmployee("draft-target")).toMatchObject({ version: 2, permissions: { write: "project" } });
  });

  it("derives risk floors in Core and rejects semantic operations that do not change the Employee", async () => {
    const { service } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "permissions.set",
        rationale: "Expand project access.",
        risk: "low",
        payload: { permissions: { write: "project", tools: ["Read", "Edit"] } }
      }]
    }));

    expect(proposal.operations[0]?.risk).toBe("high");
    expect(proposal.reviewItems[0]?.risk).toBe("high");

    await expect(service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "prompts.set",
        rationale: "Repeat the current prompts.",
        risk: "low",
        payload: {
          systemPrompt: "Original system prompt.",
          requestPrompt: "Original request prompt."
        }
      }]
    }))).rejects.toThrow(/does not change the current Employee/);
    expect(service.getEmployee("draft-target").version).toBe(1);
  });

  it("keeps retained Skill pins unless the proposal explicitly requests a version upgrade", async () => {
    const { service } = await fixture();
    expect(service.listSkills(true).find((skill) => skill.id === "retained-skill")?.version).toBe(2);
    expect(service.getEmployee("draft-target").skillVersions).toEqual({ "retained-skill": 1 });

    const retained = await service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "skills.set",
        rationale: "Change configuration without upgrading the retained Skill.",
        risk: "high",
        payload: { skills: [{ id: "retained-skill", config: { mode: "strict" } }] }
      }]
    }));
    expect(retained.operations[0]).toMatchObject({ payload: { skillVersions: { "retained-skill": 1 } } });
    expect(retained.reviewItems[0]?.after).toMatchObject({ skillVersions: { "retained-skill": 1 } });

    const upgraded = await service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "skills.set",
        rationale: "Explicitly adopt the reviewed Skill revision.",
        risk: "high",
        payload: {
          skills: [{ id: "retained-skill", config: { mode: "strict" } }],
          skillVersions: { "retained-skill": 2 }
        }
      }]
    }));
    expect(upgraded.reviewItems[0]?.after).toMatchObject({ skillVersions: { "retained-skill": 2 } });
    await expect(service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "skills.set",
        rationale: "Invalid unbound version pin.",
        risk: "high",
        payload: {
          skills: ["retained-skill"],
          skillVersions: { "not-bound": 1 }
        }
      }]
    }))).rejects.toThrow(/reference unbound Skills: not-bound/);
  });

  it("rejects arbitrary fields, unknown Providers, invalid Schemas, and Knowledge-shaped operations in Core", async () => {
    const { service } = await fixture();
    await expect(service.createConfigurationProposal(proposalInput({ sourceRunId: "ghost-run" })))
      .rejects.toThrow(/configuration control run not found/);
    await expect(service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "runtime.set",
        rationale: "Unknown runtime.",
        risk: "high",
        payload: { providerId: "missing-provider", maxAttempts: 1 }
      }]
    }))).rejects.toThrow(/unknown provider/);
    await expect(service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "output-contract.set",
        rationale: "Invalid schema.",
        risk: "high",
        payload: { outputSchema: { type: "not-a-json-schema-type" } }
      }]
    }))).rejects.toThrow(/valid JSON Schema/);
    await expect(service.createConfigurationProposal(proposalInput({
      operations: [{
        type: "prompts.set",
        rationale: "Contains an arbitrary path.",
        risk: "medium",
        payload: { systemPrompt: "Valid.", requestPrompt: "Valid.", path: "/knowledgeProfileIds" }
      } as never]
    }))).rejects.toThrow(/unsupported fields: path/);
    await expect(service.createConfigurationProposal(proposalInput({
      operations: [{ type: "employee-profiles.set", rationale: "Not configuration.", risk: "high", payload: {} } as never]
    }))).rejects.toThrow(/unsupported type/);
    expect(service.listConfigurationProposals()).toHaveLength(0);
    expect(service.getEmployee("draft-target").version).toBe(1);
  });

  it("migrates legacy state without configuration proposal storage and restores the restricted Provider", async () => {
    const root = temporaryRoot();
    await WorkbenchService.open({ dataRoot: root });
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown> & { providers: Record<string, unknown> };
    delete state.configurationProposals;
    delete state.providers["codex-configuration-control"];
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const reopened = await WorkbenchService.open({ dataRoot: root });
    expect(reopened.listConfigurationProposals()).toEqual([]);
    expect(reopened.listProviders().find((provider) => provider.id === "codex-configuration-control")?.definition)
      .toMatchObject({
        adapter: "codex",
        runtimeProfiles: ["configuration-proposal-only"],
        filesystemIsolation: "workspace-read-only",
        approvalPolicy: "never"
      });
  });

  it("strips forged runtime profiles from persisted custom Providers and rejects legacy incompatible bindings at invocation", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    await service.putProvider("legacy-custom", { adapter: "mock", model: "legacy-custom" });
    const employee = await service.createEmployee({
      id: "legacy-steward",
      identity: {
        displayName: "Legacy Steward",
        background: "A persisted pre-certification Employee.",
        responsibilities: ["Draft proposals"]
      },
      providerId: "legacy-custom",
      permissions: { write: "none", tools: [] }
    });
    const project = await service.createProject({
      id: "legacy-control-project",
      rootPath: root,
      descriptorPath: path.join(root, "multi-agent.project.yaml"),
      roles: [{
        id: "configuration-steward",
        displayName: "Configuration Steward",
        description: "Requires a certified proposal-only runtime.",
        instructions: "Draft only.",
        requiredProviderProfiles: ["configuration-proposal-only"]
      }]
    });
    const timestamp = "2026-08-04T00:00:00.000Z";
    await service.store.mutate((state) => {
      state.providers["legacy-custom"]!.runtimeProfiles = ["configuration-proposal-only"];
      const binding = {
        projectId: project.id,
        projectVersion: project.version,
        version: 1,
        roles: [{
          roleId: "configuration-steward",
          employeeId: employee.id,
          employeeVersion: employee.version,
          skills: [],
          skillVersions: {},
          knowledgeProfileIds: [],
          knowledgeGrants: [],
          updatePolicy: "locked" as const
        }],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.projectBindings[project.id] = { current: binding, versions: [binding] };
    });

    const reopened = await WorkbenchService.open({ dataRoot: root });
    expect(reopened.listProviders().find((provider) => provider.id === "legacy-custom")?.definition.runtimeProfiles)
      .toBeUndefined();
    await expect(reopened.invokeProjectRole(project.id, "configuration-steward", { message: "Do not execute this Provider" }))
      .rejects.toThrow(/lacks required runtime profiles: configuration-proposal-only/);
    await expect(reopened.putProvider("legacy-custom", { adapter: "mock", model: "repaired-custom" }))
      .resolves.toBeUndefined();
  });

  it("safely quarantines a persisted legacy proposal that has no review CAS or verifiable Run provenance", async () => {
    const { service } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput());
    const statePath = path.join(service.store.dataRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      configurationProposals: Record<string, Record<string, unknown> & { source: Record<string, unknown> }>;
    };
    const legacy = state.configurationProposals[proposal.id]!;
    delete legacy.reviewRevision;
    delete legacy.reviewHash;
    delete legacy.source.invocationId;
    delete legacy.source.projectVersion;
    delete legacy.source.projectBindingVersion;
    delete legacy.source.employeeId;
    delete legacy.source.employeeVersion;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const reopened = await WorkbenchService.open({ dataRoot: service.store.dataRoot });
    const migrated = reopened.getConfigurationProposal(proposal.id);
    expect(migrated).toMatchObject({
      status: "needs-reapproval",
      reviewRevision: 0,
      progress: { total: 1, reviewed: 0, pending: 1 },
      validation: { valid: false }
    });
    expect(migrated.reviewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(migrated.error).toMatch(/no verifiable source Run/);
    await expect(reopened.cancelConfigurationProposal(proposal.id, "local-owner", "Legacy proposal replaced"))
      .resolves.toMatchObject({ status: "cancelled", cancellation: { actor: "local-owner" } });
  });

  it("preserves an applied historical outcome while flagging corrupted audit provenance on reopen", async () => {
    const { service, attest } = await fixture();
    const proposal = await service.createConfigurationProposal(proposalInput());
    await attest(proposal.id);
    const ready = await service.decideConfigurationReviewItem(
      proposal.id,
      proposal.reviewItems[0]!.id,
      reviewDecision(proposal, "accepted")
    );
    await service.applyConfigurationProposal(proposal.id, {
      expectedReviewRevision: ready.reviewRevision,
      expectedReviewHash: ready.reviewHash
    });
    const statePath = path.join(service.store.dataRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      configurationProposals: Record<string, Record<string, unknown> & { source: Record<string, unknown> }>;
    };
    delete state.configurationProposals[proposal.id]!.source.invocationId;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const reopened = await WorkbenchService.open({ dataRoot: service.store.dataRoot });
    expect(reopened.getConfigurationProposal(proposal.id)).toMatchObject({
      status: "applied",
      validation: { valid: false },
      error: expect.stringMatching(/historical outcome was preserved but its audit evidence is incomplete/)
    });
    expect(reopened.getEmployee("draft-target")).toMatchObject({ version: 2, systemPrompt: "Preserve evidence and report uncertainty." });
  });

  it("installs the real steward template at the current project version and explicitly repins after project upgrades", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await expect(service.putProvider("forged-configuration-control", {
      adapter: "mock",
      runtimeProfiles: ["configuration-proposal-only"]
    })).rejects.toThrow(/runtimeProfiles are reserved for system-managed Provider definitions/);
    await expect(service.putProvider("codex-configuration-control", { adapter: "mock" }))
      .rejects.toThrow(/system-managed runtime profiles and cannot be replaced/);
    const root = path.resolve(".");
    const skill = JSON.parse(fs.readFileSync(
      path.join(root, "templates/workbench/configuration-control-conversation.skill.json"),
      "utf8"
    )) as SkillCreateInput;
    const employeeInput = JSON.parse(fs.readFileSync(
      path.join(root, "templates/workbench/configuration-steward.employee.json"),
      "utf8"
    )) as EmployeeCreateInput;
    await service.createSkill(skill);
    await service.createProject({
      id: "local-agent-workbench",
      rootPath: root,
      descriptorPath: path.join(root, "multi-agent.project.yaml"),
      roles: [{ id: "placeholder", displayName: "Placeholder", description: "Before the steward role exists.", instructions: "Wait." }]
    });
    await service.updateProject("local-agent-workbench", {
      id: "local-agent-workbench",
      rootPath: root,
      descriptorPath: path.join(root, "multi-agent.project.yaml"),
      roles: [{
        id: "configuration-steward",
        displayName: "Configuration Steward",
        description: "Draft configurations.",
        instructions: "Use governed tools.",
        requiredSkills: [skill.id],
        requiredProviderProfiles: ["configuration-proposal-only"],
        permissions: { write: "none", tools: employeeInput.permissions?.tools }
      }]
    });

    const incompatible = await service.createEmployee({
      ...employeeInput,
      id: "incompatible-configuration-steward",
      identity: { ...employeeInput.identity, displayName: "Incompatible Configuration Steward" },
      providerId: "mock"
    });
    await expect(service.saveProjectBinding("local-agent-workbench", {
      roles: [{ roleId: "configuration-steward", employeeId: incompatible.id }]
    })).rejects.toThrow(/lacks required runtime profiles: configuration-proposal-only/);

    const steward = await service.createEmployee(employeeInput);
    expect(steward.scope).toEqual({ kind: "project", projectId: "local-agent-workbench", projectVersion: 2 });
    await service.saveProjectBinding("local-agent-workbench", {
      roles: [{ roleId: "configuration-steward", employeeId: steward.id }]
    });
    await expect(service.invokeEmployee(steward.id, { message: "Bypass the project role" }))
      .rejects.toThrow(/invoke it through a project role/);

    await service.updateProject("local-agent-workbench", {
      id: "local-agent-workbench",
      description: "Project policy version three.",
      rootPath: root,
      descriptorPath: path.join(root, "multi-agent.project.yaml"),
      roles: [{
        id: "configuration-steward",
        displayName: "Configuration Steward",
        description: "Draft configurations with the new project policy.",
        instructions: "Use governed tools and preserve evidence.",
        requiredSkills: [skill.id],
        requiredProviderProfiles: ["configuration-proposal-only"],
        permissions: { write: "none", tools: employeeInput.permissions?.tools }
      }]
    });
    await expect(service.saveProjectBinding("local-agent-workbench", {
      roles: [{ roleId: "configuration-steward", employeeId: steward.id }]
    })).rejects.toThrow(/fixed to project local-agent-workbench v2, not v3/);

    const repinned = await service.repinEmployeeProject(steward.id);
    expect(repinned).toMatchObject({ version: 2, scope: { kind: "project", projectId: "local-agent-workbench", projectVersion: 3 } });
    await expect(service.saveProjectBinding("local-agent-workbench", {
      roles: [{ roleId: "configuration-steward", employeeId: steward.id }]
    })).resolves.toMatchObject({ projectVersion: 3 });
  });
});
