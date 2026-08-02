import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RestrictedKnowledgeUrlFetcher,
  WorkbenchService,
  blockedKnowledgeAddressReason,
  type KnowledgeFetchedUrl,
  type KnowledgeUrlHttpResponse
} from "../src/index.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-knowledge-import-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function* responseBody(value = ""): AsyncIterable<Uint8Array> {
  if (value) yield Buffer.from(value);
}

function httpResponse(
  statusCode: number,
  headers: IncomingHttpHeaders,
  body = ""
): KnowledgeUrlHttpResponse {
  return { statusCode, headers, body: responseBody(body), abort: vi.fn() };
}

function fetchedPage(html: string, fetchedAt = "2026-01-01T00:00:00.000Z"): KnowledgeFetchedUrl {
  const bytes = Buffer.from(html);
  return {
    requestedUrl: "https://public.example/handbook",
    finalUrl: "https://public.example/handbook",
    redirects: [],
    contentType: "text/html",
    byteLength: bytes.length,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    html,
    fetchedAt
  };
}

const firstPage = fetchedPage(`<!doctype html>
<html><head><title>Deployment Handbook</title></head><body>
<p>Deployment safety and rollback evidence.</p>
<h2 id="Rollout-Plan">Rollout Plan</h2>
<p>Use staged deployment safety checks. <a href="https://kb.example/policy">Policy</a></p>
<h3 id="rollback">Rollback</h3>
<p>Rollback deployment incidents with traceable evidence.</p>
</body></html>`);

const secondPage = fetchedPage(`<!doctype html>
<html><head><title>Deployment Handbook</title></head><body>
<p>Deployment safety, canary, and rollback evidence.</p>
<h2 id="Rollout-Plan">Rollout Plan</h2>
<p>Use staged canary deployment safety checks. <a href="https://kb.example/policy">Policy</a></p>
<h3 id="rollback">Rollback</h3>
<p>Rollback canary deployment incidents with traceable evidence.</p>
</body></html>`, "2026-01-02T00:00:00.000Z");

async function createUrlImportFixture(fetcher: { fetch: (url: string) => Promise<KnowledgeFetchedUrl> }) {
  const service = await WorkbenchService.open({ dataRoot: temporaryRoot(), knowledgeUrlFetcher: fetcher });
  await service.createKnowledgeBase({
    id: "operations-handbook",
    description: "Governed operations knowledge.",
    domain: "operations",
    collections: [{
      id: "runbooks",
      displayName: "Runbooks",
      description: "Deployment and rollback runbooks.",
      authority: "canonical",
      tags: ["deployment", "rollback"]
    }],
    documents: [
      {
        id: "deployment-policy",
        title: "Deployment Safety Policy",
        content: "Deployment safety requires staged rollout and rollback evidence.",
        collectionId: "runbooks",
        sourceRef: "https://kb.example/policy",
        order: 0
      },
      {
        id: "incident-guide",
        title: "Rollback Incident Guide",
        content: "Rollback deployment incidents and preserve traceable evidence.",
        collectionId: "runbooks",
        sourceRef: "https://kb.example/incidents",
        order: 1
      }
    ],
    publish: true
  });
  await service.createKnowledgeProfile({
    id: "operations-knowledge",
    description: "Published operations knowledge.",
    rules: [{
      id: "operations-core",
      selector: { knowledgeBaseIds: ["operations-handbook"], collectionIds: ["runbooks"] },
      activation: "core",
      priority: 10,
      required: false,
      budget: { maxCollections: 1, maxChunks: 10, maxTokens: 4_000 }
    }]
  });
  const employee = await service.createEmployee({
    id: "operations-worker",
    identity: {
      displayName: "Operations Worker",
      background: "Runs deployment operations.",
      responsibilities: ["Use published runbooks"]
    },
    knowledgeProfileIds: ["operations-knowledge"]
  });
  return { service, employee };
}

describe("restricted knowledge URL fetcher", () => {
  it("blocks loopback, private, link-local, multicast, and embedded IPv4 addresses before requesting", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.10.20",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::127.0.0.1",
      "2002:0a00:0001::",
      "2001:0000:4136:e378:8000:63bf:f5ff:fffe",
      "2001:0000:0a00:0001:8000:63bf:3fff:fdd2",
      "64:ff9b::a00:1",
      "64:ff9b:1::a00:1",
      "2001:db8::5efe:a00:1",
      "fc00::5efe:cb00:7108"
    ]) {
      expect(blockedKnowledgeAddressReason(address), address).toBeDefined();
    }
    expect(blockedKnowledgeAddressReason("203.0.113.8")).toBeUndefined();
    expect(blockedKnowledgeAddressReason("2001:db8::8")).toBeUndefined();
    expect(blockedKnowledgeAddressReason("2002:cb00:7108::")).toBeUndefined();
    expect(blockedKnowledgeAddressReason("2001:0000:4136:e378:8000:63bf:3fff:fdd2")).toBeUndefined();
    expect(blockedKnowledgeAddressReason("64:ff9b::cb00:7108")).toBeUndefined();

    const request = vi.fn(async () => httpResponse(200, { "content-type": "text/html" }, "<p>safe</p>"));
    const fetcher = new RestrictedKnowledgeUrlFetcher({
      lookup: async () => [{ address: "10.0.0.8", family: 4 }],
      request
    });
    await expect(fetcher.fetch("https://internal.example/private")).rejects.toThrow(/blocked private address/);
    expect(request).not.toHaveBeenCalled();

    const transitionRequest = vi.fn(async () => httpResponse(200, { "content-type": "text/html" }, "<p>unsafe</p>"));
    for (const address of [
      "2002:0a00:0001::",
      "2001:0000:4136:e378:8000:63bf:f5ff:fffe",
      "64:ff9b::a00:1"
    ]) {
      const transitionFetcher = new RestrictedKnowledgeUrlFetcher({
        lookup: async () => [{ address, family: 6 }],
        request: transitionRequest
      });
      await expect(transitionFetcher.fetch("https://transition.example/private"), address)
        .rejects.toThrow(/blocked .*private address/);
    }
    expect(transitionRequest).not.toHaveBeenCalled();
  });

  it("revalidates every redirect target and enforces content type and declared size", async () => {
    const redirectRequest = vi.fn(async () => httpResponse(302, { location: "http://127.0.0.1/admin" }));
    const redirectFetcher = new RestrictedKnowledgeUrlFetcher({
      lookup: async () => [{ address: "203.0.113.9", family: 4 }],
      request: redirectRequest
    });
    await expect(redirectFetcher.fetch("https://public.example/start")).rejects.toThrow(/blocked loopback address/);
    expect(redirectRequest).toHaveBeenCalledTimes(1);

    const typeFetcher = new RestrictedKnowledgeUrlFetcher({
      lookup: async () => [{ address: "203.0.113.9", family: 4 }],
      request: async () => httpResponse(200, { "content-type": "application/json" }, "{}")
    });
    await expect(typeFetcher.fetch("https://public.example/data")).rejects.toThrow(/content-type application\/json is not allowed/);

    const sizeFetcher = new RestrictedKnowledgeUrlFetcher({
      maxBytes: 1_024,
      lookup: async () => [{ address: "203.0.113.9", family: 4 }],
      request: async () => httpResponse(200, { "content-type": "text/html", "content-length": "2048" })
    });
    await expect(sizeFetcher.fetch("https://public.example/large")).rejects.toThrow(/exceeds 1024 bytes/);
  });
});

describe("knowledge URL import governance", () => {
  it("freezes preview content, upgrades only selected relations, and keeps approved drafts unpublished", async () => {
    let current = firstPage;
    const fetch = vi.fn(async () => current);
    const { service, employee } = await createUrlImportFixture({ fetch });

    const preview = await service.previewKnowledgeUrl({
      knowledgeBaseId: "operations-handbook",
      collectionId: "runbooks",
      url: firstPage.requestedUrl
    });
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.documents).toHaveLength(3);
    expect(preview.documents.map((document) => document.order)).toEqual([0, 1, 2]);
    expect(preview.documents[1]).toMatchObject({
      title: "Rollout Plan",
      parentId: preview.documents[0]?.id,
      metadata: { anchor: "Rollout-Plan", headingPath: ["Rollout Plan"] }
    });
    expect(preview.documents[2]).toMatchObject({
      title: "Rollback",
      parentId: preview.documents[1]?.id,
      metadata: { anchor: "rollback", headingPath: ["Rollout Plan", "Rollback"] }
    });
    expect(preview.relationCandidates.length).toBeGreaterThan(1);
    expect(preview.relationCandidates).toHaveLength(Math.min(5, preview.relationCandidates.length));
    expect(preview.relationCandidates.every((candidate) => candidate.persisted === false)).toBe(true);
    expect(service.getKnowledgeBase("operations-handbook").latestRevision).toBe(1);

    const selected = preview.relationCandidates.find((candidate) => candidate.targetDocumentId === "deployment-policy");
    expect(selected).toBeDefined();
    const proposal = await service.proposeKnowledgeUrl({
      knowledgeBaseId: "operations-handbook",
      collectionId: "runbooks",
      url: firstPage.requestedUrl,
      previewHash: preview.previewHash,
      title: "Import deployment handbook",
      reason: "The public runbook was reviewed.",
      selectedRelations: [{ candidateId: selected!.id, type: "supports", note: "Reviewed by the content owner." }]
    });
    expect(proposal).toMatchObject({ status: "awaiting-approval", risk: "medium" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.getKnowledgeBase("operations-handbook").latestRevision).toBe(1);

    await service.approveKnowledgeChangeRequest(proposal.id, "content-owner", "Approved frozen import");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.getKnowledgeBase("operations-handbook")).toMatchObject({ latestRevision: 2, publishedRevision: 1 });
    const draft = await service.knowledge.contentStore.readRevision("operations-handbook", 2);
    const explicit = draft.documents.flatMap((document) => document.references.map((reference) => ({ document, reference })));
    expect(explicit).toHaveLength(1);
    expect(explicit[0]?.reference).toMatchObject({ type: "supports", targetDocumentId: "deployment-policy" });
    expect(JSON.stringify(explicit)).not.toContain("incident-guide");

    const wiki = await service.getKnowledgeWiki("operations-handbook", 2);
    expect(wiki.visibility).toBe("draft");
    expect(wiki.references).toHaveLength(1);
    expect(wiki.documents.find((item) => item.document.id === "deployment-policy")?.backlinks)
      .toContainEqual(expect.objectContaining({ type: "supports" }));
    expect(wiki.candidateRelations.every((candidate) => candidate.persisted === false)).toBe(true);

    const employeeView = await service.previewEmployeeKnowledge(employee.id, { message: "canary deployment handbook" });
    expect(employeeView.plan.selectedCollections[0]?.revision).toBe(1);
    expect(JSON.stringify(employeeView.evidence)).not.toContain("Rollout Plan");

    current = secondPage;
    const updatePreview = await service.previewKnowledgeUrl({
      knowledgeBaseId: "operations-handbook",
      collectionId: "runbooks",
      url: firstPage.requestedUrl
    });
    const updateProposal = await service.proposeKnowledgeUrl({
      knowledgeBaseId: "operations-handbook",
      collectionId: "runbooks",
      url: firstPage.requestedUrl,
      previewHash: updatePreview.previewHash,
      title: "Refresh deployment handbook",
      reason: "The same source URL now includes canary guidance."
    });
    await service.approveKnowledgeChangeRequest(updateProposal.id, "content-owner");
    const refreshed = await service.knowledge.contentStore.readRevision("operations-handbook", 3);
    const imported = refreshed.documents.filter((document) => document.metadata?.sourceKind === "url");
    expect(imported).toHaveLength(3);
    expect(JSON.stringify(imported)).toContain("canary");
    expect(refreshed.documents.flatMap((document) => document.references)).toHaveLength(1);
  });

  it("rejects a proposal when re-fetching changes the frozen preview hash", async () => {
    let current = firstPage;
    const fetch = vi.fn(async () => current);
    const { service } = await createUrlImportFixture({ fetch });
    const preview = await service.previewKnowledgeUrl({
      knowledgeBaseId: "operations-handbook",
      collectionId: "runbooks",
      url: firstPage.requestedUrl
    });
    current = secondPage;
    await expect(service.proposeKnowledgeUrl({
      knowledgeBaseId: "operations-handbook",
      collectionId: "runbooks",
      url: firstPage.requestedUrl,
      previewHash: preview.previewHash,
      title: "Import changed page",
      reason: "This stale preview must not be accepted."
    })).rejects.toThrow(/changed after preview/);
    expect(service.listKnowledgeChangeRequests()).toEqual([]);
    expect(service.getKnowledgeBase("operations-handbook").latestRevision).toBe(1);
  });
});

describe("knowledge authorization perspective and review", () => {
  it("reports deterministic activation, recent Run evidence, legacy grants, and reminder-only expiry reviews", async () => {
    const root = temporaryRoot();
    let service = await WorkbenchService.open({ dataRoot: root });
    await service.createKnowledgeBase({
      id: "perspective-handbook",
      description: "Perspective evidence.",
      domain: "operations",
      collections: [
        { id: "core", displayName: "Core", description: "Core deployment policy.", authority: "canonical", tags: ["deployment"] },
        { id: "optional", displayName: "Optional", description: "Optional billing policy.", authority: "reference", tags: ["billing"] }
      ],
      documents: [
        { id: "core-policy", title: "Deployment policy", content: "Deployment requires traceable evidence.", collectionId: "core" },
        { id: "billing-policy", title: "Billing policy", content: "Billing requires reconciliation.", collectionId: "optional" }
      ],
      publish: true
    });
    await service.createKnowledgeProfile({
      id: "perspective-knowledge",
      description: "Core plus on-demand policy.",
      rules: [
        {
          id: "core-rule",
          selector: { knowledgeBaseIds: ["perspective-handbook"], collectionIds: ["core"] },
          activation: "core",
          priority: 10,
          required: false,
          budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1_200 }
        },
        {
          id: "optional-rule",
          selector: { knowledgeBaseIds: ["perspective-handbook"], collectionIds: ["optional"] },
          activation: "on-demand",
          priority: 1,
          required: false,
          budget: { maxCollections: 1, maxChunks: 3, maxTokens: 1_200 }
        }
      ]
    });
    const employee = await service.createEmployee({
      id: "perspective-worker",
      identity: {
        displayName: "Perspective Worker",
        background: "Uses contextual knowledge.",
        responsibilities: ["Inspect evidence"]
      },
      knowledgeProfileIds: ["perspective-knowledge"],
      knowledgeGrants: [{
        profileId: "perspective-knowledge",
        reason: "Needs deployment policy.",
        grantedBy: "operations-owner",
        grantedAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-12-31T00:00:00.000Z",
        reviewCycleDays: 90,
        lastReviewedAt: "2025-09-01T00:00:00.000Z"
      }]
    });
    const run = await service.invokeEmployee(employee.id, { message: "Review deployment evidence" });
    const perspective = await service.getEmployeeKnowledgePerspective(employee.id, {
      message: "Review deployment evidence",
      evidenceLimit: 5
    });
    expect(perspective.eligible.map((item) => item.collection.id)).toEqual(["core", "optional"]);
    expect(perspective.activated.map((item) => item.collection.id)).toEqual(["core"]);
    expect(perspective.eligible[0]).toMatchObject({
      knowledgeBaseId: "perspective-handbook",
      collection: { id: "core", displayName: "Core" },
      matches: [{
        profileId: "perspective-knowledge",
        profileVersion: 1,
        ruleId: "core-rule",
        activation: "core",
        reason: expect.stringContaining("profile rule core-rule")
      }]
    });
    expect(perspective.selected.map((item) => item.collectionId)).toEqual(["core"]);
    expect(perspective.exclusions).toContainEqual(expect.objectContaining({
      collectionId: "optional",
      reason: "on-demand metadata did not match the request"
    }));
    expect(perspective.recentEvidence).toContainEqual(expect.objectContaining({
      runId: run.runId,
      evidence: [expect.objectContaining({ documentId: "core-policy" })]
    }));
    expect(perspective.evidenceWindow).toMatchObject({
      policy: "recent-work-instances-v1",
      limit: 5,
      scannedInstances: 1,
      matchedRuns: 1
    });

    const reviews = service.listKnowledgeGrantReviews({ asOf: "2026-01-15T00:00:00.000Z", dueSoonDays: 30 });
    expect(reviews.policy).toBe("reminder-only-v1");
    expect(reviews.items).toContainEqual(expect.objectContaining({
      subject: { kind: "employee", employeeId: employee.id },
      status: "overdue",
      reminderOnly: true,
      grant: expect.objectContaining({ profileId: "perspective-knowledge", expiresAt: "2025-12-31T00:00:00.000Z" })
    }));
    const afterExpiry = await service.previewEmployeeKnowledge(employee.id, { message: "Review deployment evidence" });
    expect(afterExpiry.plan.selectedCollections.map((item) => item.collectionId)).toEqual(["core"]);

    await service.createProject({
      id: "perspective-project",
      rootPath: temporaryRoot(),
      descriptorPath: "/tmp/perspective-project/multi-agent.project.yaml",
      roles: [{
        id: "operator",
        displayName: "Operator",
        description: "Operate the project.",
        instructions: "Use project evidence.",
        knowledgeProfileIds: ["perspective-knowledge"]
      }]
    });
    await service.saveProjectBinding("perspective-project", {
      roles: [{
        roleId: "operator",
        employeeId: employee.id,
        knowledgeProfileIds: ["perspective-knowledge"],
        knowledgeGrants: [{
          profileId: "perspective-knowledge",
          reason: "Project operator needs the policy.",
          grantedBy: "project-owner",
          grantedAt: "2025-10-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
          reviewCycleDays: 120,
          lastReviewedAt: "2025-10-15T00:00:00.000Z"
        }]
      }]
    });
    expect(service.getProjectBinding("perspective-project").roles[0]?.knowledgeGrants).toEqual([
      expect.objectContaining({
        reason: "Project operator needs the policy.",
        grantedBy: "project-owner",
        grantedAt: "2025-10-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
        reviewCycleDays: 120,
        lastReviewedAt: "2025-10-15T00:00:00.000Z",
        source: "explicit"
      })
    ]);
    expect(service.listKnowledgeGrantReviews({
      asOf: "2026-01-15T00:00:00.000Z",
      dueSoonDays: 30
    }).items).toContainEqual(expect.objectContaining({
      subject: {
        kind: "project-role",
        employeeId: employee.id,
        projectId: "perspective-project",
        roleId: "operator"
      },
      status: "due-soon",
      reminderOnly: true
    }));

    await service.createEmployee({
      id: "legacy-worker",
      identity: {
        displayName: "Legacy Worker",
        background: "Predates grant metadata.",
        responsibilities: ["Read policy"]
      },
      knowledgeProfileIds: ["perspective-knowledge"]
    });
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      employees: Record<string, { current: Record<string, unknown>; versions: Array<Record<string, unknown>> }>;
    };
    delete state.employees["legacy-worker"]?.current.knowledgeGrants;
    for (const version of state.employees["legacy-worker"]?.versions ?? []) delete version.knowledgeGrants;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    service = await WorkbenchService.open({ dataRoot: root });
    expect(service.getEmployee("legacy-worker").knowledgeGrants).toEqual([expect.objectContaining({
      profileId: "perspective-knowledge",
      reason: "Legacy knowledgeProfileIds assignment",
      grantedBy: "legacy-migration",
      source: "legacy"
    })]);

    await expect(service.createKnowledgeChangeRequest({
      title: "Refresh legacy grant",
      reason: "Missing mutation reason must fail.",
      operation: {
        type: "employee-profiles.set",
        targetId: "legacy-worker",
        payload: { profileIds: ["perspective-knowledge"], grantedBy: "operations-owner" }
      }
    })).rejects.toThrow(/knowledge grant reason is required/);
    const change = await service.createKnowledgeChangeRequest({
      title: "Refresh legacy grant",
      reason: "Record explicit grant ownership.",
      operation: {
        type: "employee-profiles.set",
        targetId: "legacy-worker",
        payload: {
          profileIds: ["perspective-knowledge"],
          reason: "Continued operational need.",
          grantedBy: "operations-owner",
          expiresAt: "2026-12-31T00:00:00.000Z",
          reviewCycleDays: 180
        }
      }
    });
    expect(change).toMatchObject({ status: "awaiting-approval", risk: "critical" });
    expect(service.getEmployee("legacy-worker").knowledgeGrants[0]?.source).toBe("legacy");
    await service.approveKnowledgeChangeRequest(change.id, "access-owner");
    expect(service.getEmployee("legacy-worker").knowledgeGrants).toEqual([expect.objectContaining({
      reason: "Continued operational need.",
      grantedBy: "operations-owner",
      source: "explicit"
    })]);
  });
});
