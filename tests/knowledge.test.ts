import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-knowledge-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function rule(
  id: string,
  collectionId: string,
  activation: "core" | "conditional" | "on-demand" = "core"
) {
  return {
    id,
    selector: { knowledgeBaseIds: ["workbench-handbook"], collectionIds: [collectionId], maxClassification: "internal" as const },
    activation,
    priority: 10,
    required: false,
    budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1_200 }
  };
}

describe("Knowledge control plane and runtime", () => {
  it("routes only published relevant Collections and persists the Knowledge Plan with prompt evidence", async () => {
    const root = temporaryRoot();
    const service = await WorkbenchService.open({ dataRoot: root });
    await service.createKnowledgeBase({
      id: "workbench-handbook",
      displayName: "Workbench Handbook",
      description: "Product and engineering operating knowledge.",
      domain: "workbench",
      classification: "internal",
      collections: [
        { id: "product", displayName: "Product", description: "Product acceptance and scope.", authority: "canonical", tags: ["产品", "验收"] },
        { id: "engineering", displayName: "Engineering", description: "Build and runtime internals.", authority: "canonical", tags: ["工程", "构建"] }
      ],
      documents: [
        { id: "product-policy", title: "产品验收原则", content: "产品验收必须先核对目标、用户路径与可追溯标准。", collectionId: "product" },
        { id: "build-policy", title: "构建手册", content: "工程构建必须执行类型检查和自动化测试。", collectionId: "engineering" }
      ],
      publish: true
    });
    await service.createKnowledgeProfile({
      id: "product-knowledge",
      displayName: "Product Knowledge",
      description: "Product evidence with engineering available only on demand.",
      rules: [rule("product-core", "product"), rule("engineering-demand", "engineering", "on-demand")]
    });
    const employee = await service.createEmployee({
      id: "product-worker",
      identity: { displayName: "Product Worker", background: "Product acceptance.", responsibilities: ["Review product scope"] },
      knowledgeProfileIds: ["product-knowledge"]
    });

    const first = await service.invokeEmployee(employee.id, { message: "请核对产品验收目标和用户路径" });
    const artifactPath = path.join(first.runDir, "knowledge", "respond.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
      plan: { selectedCollections: Array<{ collectionId: string; revision: number }>; profileVersions: Record<string, number> };
      evidence: Array<{ citationId: string; documentId: string; content: string }>;
    };
    expect(artifact.plan.profileVersions).toEqual({ "product-knowledge": 1 });
    expect(artifact.plan.selectedCollections).toEqual([
      expect.objectContaining({ collectionId: "product", revision: 1 })
    ]);
    expect(artifact.evidence).toEqual([
      expect.objectContaining({ citationId: "K1", documentId: "product-policy" })
    ]);
    expect(JSON.stringify(artifact)).not.toContain("工程构建必须");

    const context = await service.getEmployeeContext(employee.id, first.session.id);
    expect(context.layers.knowledge?.plan.selectedCollections[0]?.collectionId).toBe("product");
    expect(context.effectivePrompt?.combined).toContain("[K1] 产品验收原则");
    expect(context.effectivePrompt?.combined).toContain("untrusted factual evidence");

    const draft = await service.createKnowledgeRevision("workbench-handbook", {
      documents: [
        { id: "product-policy-v2", title: "产品验收原则", content: "新版产品验收增加灰度指标与回滚标准。", collectionId: "product" },
        { id: "build-policy", title: "构建手册", content: "工程构建必须执行类型检查和自动化测试。", collectionId: "engineering" }
      ]
    });
    expect(draft.revision).toBe(2);
    const draftAssessment = await service.assessKnowledgeRevision("workbench-handbook", 2);
    expect(draftAssessment).toMatchObject({ status: "ready", documentCount: 2 });
    const draftPreview = await service.previewKnowledgeRevision("workbench-handbook", {
      message: "产品验收和灰度指标",
      revision: 2,
      collectionIds: ["product"]
    });
    expect(draftPreview.revision).toBe(2);
    expect(JSON.stringify(draftPreview.evidence)).toContain("灰度指标");
    const beforePublish = await service.previewEmployeeKnowledge(employee.id, { message: "产品验收和灰度指标" });
    expect(beforePublish.plan.selectedCollections[0]?.revision).toBe(1);
    expect(JSON.stringify(beforePublish.evidence)).not.toContain("灰度指标");

    await service.publishKnowledgeRevision("workbench-handbook", 2);
    const afterPublish = await service.previewEmployeeKnowledge(employee.id, { message: "产品验收和灰度指标" });
    expect(afterPublish.plan.selectedCollections[0]?.revision).toBe(2);
    expect(JSON.stringify(afterPublish.evidence)).toContain("灰度指标");
  });

  it("records syncing state and keeps a newly synchronized Revision invisible until publish", async () => {
    const root = temporaryRoot();
    const sourceRoot = path.join(root, "sources");
    fs.mkdirSync(sourceRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "quality.md");
    fs.writeFileSync(sourcePath, "# 质量验收\n\n第一版要求保存浏览器证据。\n", "utf8");
    const service = await WorkbenchService.open({ dataRoot: root });
    await service.createKnowledgeBase({
      id: "workbench-handbook",
      description: "Synchronized quality knowledge.",
      domain: "workbench",
      collections: [{ id: "quality", displayName: "Quality", description: "Quality evidence.", authority: "canonical", tags: ["质量", "浏览器"] }],
      sources: [{ id: "quality-source", kind: "file", location: sourcePath, collectionId: "quality" }]
    });
    await service.createKnowledgeProfile({
      id: "quality-knowledge",
      description: "Published quality evidence only.",
      rules: [rule("quality-core", "quality")]
    });
    const employee = await service.createEmployee({
      id: "quality-worker",
      identity: { displayName: "Quality Worker", background: "Quality acceptance.", responsibilities: ["Verify evidence"] },
      knowledgeProfileIds: ["quality-knowledge"]
    });

    const collect = service.knowledge.contentStore.collectSources.bind(service.knowledge.contentStore);
    let release = () => {};
    let signalStarted = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    vi.spyOn(service.knowledge.contentStore, "collectSources").mockImplementation(async (knowledgeBase) => {
      signalStarted();
      await gate;
      return collect(knowledgeBase);
    });
    const syncing = service.syncKnowledgeBase("workbench-handbook");
    await started;
    expect(service.getKnowledgeBase("workbench-handbook").syncStatus).toBe("syncing");
    release();
    expect((await syncing).revision).toBe(1);
    expect(service.getKnowledgeBase("workbench-handbook")).toMatchObject({ latestRevision: 1, syncStatus: "idle" });
    expect(service.getKnowledgeBase("workbench-handbook").publishedRevision).toBeUndefined();

    const unpublished = await service.previewEmployeeKnowledge(employee.id, { message: "质量验收浏览器证据" });
    expect(unpublished.plan.selectedCollections).toEqual([]);
    expect(unpublished.plan.exclusions).toContainEqual(expect.objectContaining({ reason: "knowledge base has no published revision" }));

    await service.publishKnowledgeRevision("workbench-handbook");
    const first = await service.previewEmployeeKnowledge(employee.id, { message: "质量验收浏览器证据" });
    expect(JSON.stringify(first.evidence)).toContain("第一版要求");
    fs.writeFileSync(sourcePath, "# 质量验收\n\n第二版要求保存浏览器、接口和持久化证据。\n", "utf8");
    vi.restoreAllMocks();
    await service.syncKnowledgeBase("workbench-handbook");
    const stillPublished = await service.previewEmployeeKnowledge(employee.id, { message: "质量验收持久化证据" });
    expect(stillPublished.plan.selectedCollections[0]?.revision).toBe(1);
    expect(JSON.stringify(stillPublished.evidence)).not.toContain("第二版要求");
    await service.publishKnowledgeRevision("workbench-handbook", 2);

    const reopened = await WorkbenchService.open({ dataRoot: root });
    const current = await reopened.previewEmployeeKnowledge(employee.id, { message: "质量验收持久化证据" });
    expect(current.plan.selectedCollections[0]?.revision).toBe(2);
    expect(JSON.stringify(current.evidence)).toContain("第二版要求");
  });

  it("adds project-role Profiles only to the project assignment and rejects unbounded Profiles", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createKnowledgeBase({
      id: "workbench-handbook",
      description: "Role-scoped knowledge.",
      domain: "workbench",
      collections: [
        { id: "product", displayName: "Product", description: "Product goals.", authority: "canonical", tags: ["产品"] },
        { id: "quality", displayName: "Quality", description: "Quality acceptance.", authority: "canonical", tags: ["质量", "验收"] }
      ],
      documents: [
        { id: "product-goals", title: "产品目标", content: "产品目标需要覆盖用户价值。", collectionId: "product" },
        { id: "quality-gates", title: "质量验收", content: "质量验收需要真实行为证据。", collectionId: "quality" }
      ],
      publish: true
    });
    await service.createKnowledgeProfile({ id: "product-knowledge", description: "Product only.", rules: [rule("product", "product")] });
    await service.createKnowledgeProfile({ id: "quality-knowledge", description: "Quality only.", rules: [rule("quality", "quality")] });
    await expect(service.createKnowledgeProfile({
      id: "unbounded",
      description: "Must not silently select the whole catalog.",
      rules: [{
        id: "all-internal",
        selector: { maxClassification: "internal" },
        activation: "core",
        priority: 0,
        required: false,
        budget: { maxCollections: 12, maxChunks: 20, maxTokens: 16_000 }
      }]
    })).rejects.toThrow(/must constrain a knowledge base, domain, product, project, or collection/);

    const employee = await service.createEmployee({
      id: "product-worker",
      identity: { displayName: "Product Worker", background: "Product owner.", responsibilities: ["Define product goals"] },
      knowledgeProfileIds: ["product-knowledge"]
    });
    await service.createProject({
      id: "quality-review",
      name: "Quality Review",
      rootPath: temporaryRoot(),
      descriptorPath: "/tmp/quality-review/multi-agent.project.yaml",
      roles: [{
        id: "reviewer",
        displayName: "Quality Reviewer",
        description: "Review product quality.",
        requiredSkills: [],
        optionalSkills: [],
        knowledgeProfileIds: ["quality-knowledge"],
        instructions: "Use project quality evidence."
      }]
    });
    await service.saveProjectBinding("quality-review", {
      roles: [{ roleId: "reviewer", employeeId: employee.id, knowledgeProfileIds: ["quality-knowledge"] }]
    });

    const impact = service.getKnowledgeImpactSnapshot();
    const handbookImpact = impact.knowledgeBases.find((item) => item.knowledgeBaseId === "workbench-handbook");
    expect(handbookImpact?.profileMatches.map((item) => item.profileId)).toEqual(["product-knowledge", "quality-knowledge"]);
    expect(handbookImpact?.employees).toEqual([
      expect.objectContaining({ employeeId: employee.id, viaProfileIds: ["product-knowledge"] })
    ]);
    expect(handbookImpact?.projectRoles).toEqual([
      expect.objectContaining({ projectId: "quality-review", roleId: "reviewer", viaProfileIds: ["quality-knowledge"] })
    ]);

    const direct = await service.invokeEmployee(employee.id, { message: "核对产品目标和质量验收" });
    const directContext = await service.getEmployeeContext(employee.id, direct.session.id);
    expect(directContext.layers.knowledge?.plan.profileVersions).toEqual({ "product-knowledge": 1 });
    expect(directContext.layers.knowledge?.plan.selectedCollections.map((item) => item.collectionId)).toEqual(["product"]);

    const assigned = await service.invokeProjectRole("quality-review", "reviewer", { message: "核对产品目标和质量验收" });
    const assignedContext = await service.getEmployeeContext(employee.id, assigned.session.id);
    expect(assignedContext.layers.knowledge?.plan.profileVersions).toEqual({ "product-knowledge": 1, "quality-knowledge": 1 });
    expect(new Set(assignedContext.layers.knowledge?.plan.selectedCollections.map((item) => item.collectionId))).toEqual(new Set(["product", "quality"]));
    expect(assignedContext.effectivePrompt?.combined).toContain("质量验收需要真实行为证据");
    expect(service.getEmployee(employee.id).knowledgeProfileIds).toEqual(["product-knowledge"]);

    await service.archiveKnowledgeProfile("quality-knowledge");
    const archivedInvocation = await service.invokeProjectRole("quality-review", "reviewer", { message: "核对质量验收" });
    const archivedProfileContext = await service.getEmployeeContext(employee.id, archivedInvocation.session.id);
    expect(archivedProfileContext.layers.knowledge?.plan.exclusions).toContainEqual(expect.objectContaining({
      profileId: "quality-knowledge",
      reason: "knowledge profile is archived"
    }));
    expect((await service.restoreKnowledgeProfile("quality-knowledge")).status).toBe("active");

    await service.archiveKnowledgeBase("workbench-handbook");
    const archivedBase = await service.previewEmployeeKnowledge(employee.id, { message: "核对产品目标" });
    expect(archivedBase.plan.selectedCollections).toEqual([]);
    expect(archivedBase.plan.exclusions).toContainEqual(expect.objectContaining({
      knowledgeBaseId: "workbench-handbook",
      reason: "knowledge base is archived"
    }));
    expect((await service.restoreKnowledgeBase("workbench-handbook")).status).toBe("active");
  });

  it("blocks empty Revisions from publishing and reports deterministic quality warnings", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createKnowledgeBase({
      id: "empty-handbook",
      description: "A catalog record awaiting content.",
      domain: "operations",
      collections: [
        { id: "general", displayName: "General", description: "General operations.", authority: "canonical", tags: [] }
      ]
    });
    const revision = await service.createKnowledgeRevision("empty-handbook", { documents: [] });
    const assessment = await service.assessKnowledgeRevision("empty-handbook", revision.revision);
    expect(assessment.status).toBe("blocked");
    expect(assessment.warnings).toContainEqual(expect.objectContaining({ code: "empty-revision", severity: "blocker" }));
    await expect(service.publishKnowledgeRevision("empty-handbook", revision.revision)).rejects.toThrow(/is blocked/);
  });

  it("keeps LLM-proposed knowledge changes inert until a human approves the frozen plan", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createKnowledgeBase({
      id: "governed-handbook",
      description: "Governed publishing knowledge.",
      domain: "operations",
      collections: [{ id: "general", displayName: "General", description: "General operations.", authority: "canonical", tags: [] }],
      documents: [{ id: "guide-v1", title: "Guide", content: "First published guide.", collectionId: "general" }],
      publish: true
    });
    const draft = await service.createKnowledgeRevision("governed-handbook", {
      documents: [{ id: "guide-v2", title: "Guide", content: "Second reviewed guide.", collectionId: "general" }]
    });

    const change = await service.createKnowledgeChangeRequest({
      title: "发布第二版手册",
      reason: "草稿试跑已经完成，等待内容负责人确认。",
      requestedBy: "knowledge-steward",
      operation: {
        type: "knowledge-revision.publish",
        targetId: "governed-handbook",
        payload: { revision: draft.revision }
      }
    });
    expect(change).toMatchObject({ status: "awaiting-approval", risk: "high" });
    expect(change.preview.assessment?.status).toBe("ready");
    expect(service.getKnowledgeBase("governed-handbook").publishedRevision).toBe(1);

    const applied = await service.approveKnowledgeChangeRequest(change.id, "content-owner", "批准发布");
    expect(applied.status).toBe("applied");
    expect(applied.approval).toMatchObject({ actor: "content-owner", decision: "approved" });
    expect(service.getKnowledgeBase("governed-handbook").publishedRevision).toBe(2);
  });

  it("invalidates approval when the target version changes after proposal", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await service.createKnowledgeBase({
      id: "policy-handbook",
      description: "Policy knowledge.",
      domain: "operations",
      collections: [{ id: "general", displayName: "General", description: "General operations.", authority: "canonical", tags: [] }]
    });
    const change = await service.createKnowledgeChangeRequest({
      title: "更新目录说明",
      reason: "让目录说明更清晰。",
      operation: {
        type: "knowledge-base.update",
        targetId: "policy-handbook",
        payload: { description: "A clearer policy knowledge description." }
      }
    });
    await service.updateKnowledgeBase("policy-handbook", { description: "Another editor changed this first." });

    await expect(service.approveKnowledgeChangeRequest(change.id)).rejects.toThrow(/expected v1, current version is 2/);
    expect(service.getKnowledgeChangeRequest(change.id).status).toBe("needs-reapproval");
  });

  it("rejects mismatched create targets and audits human cancellation", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await expect(service.createKnowledgeChangeRequest({
      title: "建立知识库",
      reason: "测试类型化目标约束。",
      operation: {
        type: "knowledge-base.create",
        targetId: "declared-base",
        payload: {
          id: "different-base",
          description: "Mismatched payload.",
          domain: "operations",
          collections: []
        }
      }
    })).rejects.toThrow(/does not match payload id/);

    await service.createKnowledgeBase({
      id: "cancel-base",
      description: "Cancellation audit target.",
      domain: "operations",
      collections: [{
        id: "general",
        displayName: "General",
        description: "General cancellation audit knowledge.",
        authority: "canonical",
        tags: []
      }]
    });
    const change = await service.createKnowledgeChangeRequest({
      title: "更新说明",
      reason: "等待人工决定。",
      operation: {
        type: "knowledge-base.update",
        targetId: "cancel-base",
        payload: { description: "Proposed description." }
      }
    });
    const cancelled = await service.cancelKnowledgeChangeRequest(change.id, "content-owner", "不再需要");
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellation: { actor: "content-owner", comment: "不再需要" }
    });
    expect(service.getKnowledgeBase("cancel-base").description).toBe("Cancellation audit target.");
  });

  it("enforces project-internal Employees through their assigned project role only", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    const employee = await service.createEmployee({
      id: "internal-steward",
      identity: {
        displayName: "Internal Steward",
        background: "Project-only knowledge administration.",
        responsibilities: ["Propose governed knowledge changes"],
        metadata: { internalProjectId: "project-a", internalProjectRoleId: "knowledge-steward" }
      }
    });
    for (const projectId of ["project-a", "project-b"]) {
      await service.createProject({
        id: projectId,
        rootPath: temporaryRoot(),
        descriptorPath: `/tmp/${projectId}/multi-agent.project.yaml`,
        roles: [
          { id: "knowledge-steward", displayName: "Knowledge Steward", description: "Manage knowledge.", instructions: "Use governed tools only." },
          { id: "other-role", displayName: "Other Role", description: "A different internal role.", instructions: "Do other work." }
        ]
      });
    }
    await service.saveProjectBinding("project-a", {
      roles: [{ roleId: "knowledge-steward", employeeId: employee.id }]
    });
    await expect(service.saveProjectBinding("project-b", {
      roles: [{ roleId: "knowledge-steward", employeeId: employee.id }]
    })).rejects.toThrow(/internal to project project-a/);
    await expect(service.saveProjectBinding("project-a", {
      roles: [{ roleId: "other-role", employeeId: employee.id }]
    })).rejects.toThrow(/internal to project role knowledge-steward/);
    await expect(service.invokeEmployee(employee.id, { message: "Manage knowledge" })).rejects.toThrow(/invoke it through a project role/);
    await expect(service.updateEmployee(employee.id, {
      identity: { ...employee.identity, metadata: {} }
    })).rejects.toThrow(/internal project scope project-a is immutable/);
    await expect(service.createPublication({
      id: "internal-publication",
      name: "Internal Steward",
      target: { kind: "employee", id: employee.id }
    })).rejects.toThrow(/cannot be published directly/);
    await expect(service.createWorkflow({
      id: "internal-workflow",
      nodes: [{ id: "steward", employeeId: employee.id }]
    })).rejects.toThrow(/cannot be used in a global workflow/);
    const result = await service.invokeProjectRole("project-a", "knowledge-steward", { message: "Inspect governed changes" });
    expect(result.session.assignment).toMatchObject({ projectId: "project-a", roleId: "knowledge-steward" });
  });
});
