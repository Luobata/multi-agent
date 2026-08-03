import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildEmployeeGrantProposalPayload, EmployeeKnowledgeGrantModal } from "./employeeKnowledgeGrant";
import type { Employee, KnowledgeProfile } from "./types";

const timestamp = "2026-08-01T00:00:00.000Z";
const employee: Employee = {
  id: "knowledge-worker",
  version: 4,
  status: "active",
  identity: { displayName: "Knowledge Worker", background: "Knowledge operations", responsibilities: ["Use governed knowledge"] },
  description: "Uses governed knowledge.",
  systemPrompt: "Use evidence.",
  requestPrompt: "Complete the task.",
  capabilities: [],
  scope: { kind: "global" },
  skills: [],
  skillVersions: {},
  knowledgeProfileIds: ["existing-profile"],
  providerId: "mock",
  outputSchema: { type: "object" },
  maxAttempts: 1,
  permissions: { write: "none", tools: [] },
  contextPolicy: { historyLimit: 20 },
  presentation: {},
  createdAt: timestamp,
  updatedAt: timestamp
};

const profiles: KnowledgeProfile[] = [
  { id: "existing-profile", version: 2, status: "active", displayName: "现有知识", description: "Existing", rules: [], createdAt: timestamp, updatedAt: timestamp },
  { id: "new-profile", version: 1, status: "active", displayName: "新增知识", description: "New", rules: [], createdAt: timestamp, updatedAt: timestamp }
];

describe("employee knowledge grant proposal", () => {
  it("adds metadata only for newly selected profiles", () => {
    expect(buildEmployeeGrantProposalPayload(employee, {
      selectedProfileIds: ["existing-profile", "new-profile"],
      reason: "  岗位需要  ",
      grantedBy: "  access-owner  ",
      expiresAtDate: "2027-08-01",
      reviewCycleDays: "90"
    })).toEqual({
      profileIds: ["existing-profile", "new-profile"],
      grantOverrides: [{
        profileId: "new-profile",
        reason: "岗位需要",
        grantedBy: "access-owner",
        expiresAt: "2027-08-01T00:00:00.000Z",
        reviewCycleDays: 90
      }]
    });
  });

  it("removes profiles without rewriting retained grant metadata", () => {
    expect(buildEmployeeGrantProposalPayload(employee, {
      selectedProfileIds: [],
      reason: "不再需要",
      grantedBy: "access-owner"
    })).toEqual({ profileIds: [] });
  });

  it("states that the modal creates a proposal rather than changing access directly", () => {
    const html = renderToStaticMarkup(<EmployeeKnowledgeGrantModal employee={employee} knowledgeProfiles={profiles} onClose={vi.fn()} onCreated={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("CONTROLLED PROPOSAL ONLY");
    expect(html).toContain("这里只生成待人工审批的授权提案");
    expect(html).toContain("不会直接修改员工档案");
    expect(html).toContain("现有知识");
    expect(html).toContain("新增知识");
  });

  it("keeps a missing assigned profile visible so it can be removed by proposal", () => {
    const html = renderToStaticMarkup(<EmployeeKnowledgeGrantModal employee={{ ...employee, knowledgeProfileIds: ["missing-profile"] }} knowledgeProfiles={profiles} onClose={vi.fn()} onCreated={vi.fn()} notify={vi.fn()} />);

    expect(html).toContain("missing-profile");
    expect(html).toContain("引用缺失");
  });
});
