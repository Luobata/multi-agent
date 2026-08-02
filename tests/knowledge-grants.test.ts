import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/core/types.js";
import type { KnowledgeChangeRequest, KnowledgeProfileGrant } from "../src/knowledge/types.js";
import { WorkbenchService } from "../src/workbench/service.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-knowledge-grants-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function createGrantProfiles(service: WorkbenchService): Promise<void> {
  for (const profileId of ["grant-alpha", "grant-beta", "grant-gamma"]) {
    await service.createKnowledgeProfile({
      id: profileId,
      description: `${profileId} authorization scope.`,
      rules: [{
        id: `${profileId}-rule`,
        selector: { domains: ["operations"] },
        activation: "core",
        priority: 1,
        required: false,
        budget: { maxCollections: 1, maxChunks: 1, maxTokens: 200 }
      }]
    });
  }
}

function proposedGrants(change: KnowledgeChangeRequest): KnowledgeProfileGrant[] {
  return (change.preview.proposed as unknown as { knowledgeGrants: KnowledgeProfileGrant[] }).knowledgeGrants;
}

function grantPayload(grants: KnowledgeProfileGrant[]): JsonValue {
  return JSON.parse(JSON.stringify(grants)) as JsonValue;
}

describe("knowledge Profile grant set changes", () => {
  it("updates only an overridden Employee grant and preserves retained grants through preview and apply", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createGrantProfiles(service);
    const employee = await service.createEmployee({
      id: "grant-worker",
      identity: {
        displayName: "Grant Worker",
        background: "Exercises governed grants.",
        responsibilities: ["Use authorized knowledge"]
      },
      knowledgeProfileIds: ["grant-alpha", "grant-beta"],
      knowledgeGrants: [
        {
          profileId: "grant-alpha",
          reason: "Alpha operational need.",
          grantedBy: "alpha-owner",
          grantedAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
          reviewCycleDays: 30,
          lastReviewedAt: "2025-12-01T00:00:00.000Z"
        },
        {
          profileId: "grant-beta",
          reason: "Beta operational need.",
          grantedBy: "beta-owner",
          grantedAt: "2025-02-01T00:00:00.000Z",
          expiresAt: "2028-02-01T00:00:00.000Z",
          reviewCycleDays: 120,
          lastReviewedAt: "2025-11-15T00:00:00.000Z"
        }
      ]
    });
    const originalBeta = structuredClone(employee.knowledgeGrants[1]!);

    const retain = await service.createKnowledgeChangeRequest({
      title: "Retain Alpha grant",
      reason: "Review only the Alpha grant.",
      operation: {
        type: "employee-profiles.set",
        targetId: employee.id,
        payload: {
          profileIds: ["grant-alpha", "grant-beta"],
          reason: "Global compatibility value.",
          grantedBy: "global-reviewer",
          reviewCycleDays: 90,
          grantOverrides: [{
            profileId: "grant-alpha",
            reason: "Alpha retained after review.",
            grantedBy: "alpha-reviewer",
            lastReviewedAt: "2026-03-01T00:00:00.000Z"
          }]
        }
      }
    });
    expect(retain.operation.payload?.grantOverrides).toHaveLength(2);
    expect(proposedGrants(retain)).toEqual([
      {
        profileId: "grant-alpha",
        reason: "Alpha retained after review.",
        grantedBy: "alpha-reviewer",
        grantedAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        reviewCycleDays: 90,
        lastReviewedAt: "2026-03-01T00:00:00.000Z",
        source: "explicit"
      },
      originalBeta
    ]);
    await service.approveKnowledgeChangeRequest(retain.id, "access-owner");
    expect(grantPayload(service.getEmployee(employee.id).knowledgeGrants)).toEqual(grantPayload(proposedGrants(retain)));

    await expect(service.createKnowledgeChangeRequest({
      title: "Add incomplete Gamma grant",
      reason: "New grants need complete ownership metadata.",
      operation: {
        type: "employee-profiles.set",
        targetId: employee.id,
        payload: {
          profileIds: ["grant-alpha", "grant-beta", "grant-gamma"],
          grantOverrides: [{ profileId: "grant-gamma", lastReviewedAt: "2026-03-02T00:00:00.000Z" }]
        }
      }
    })).rejects.toThrow(/grant-gamma reason is required for a new profile/);

    const add = await service.createKnowledgeChangeRequest({
      title: "Add Gamma grant",
      reason: "Exercise the compatible global metadata for a new Profile.",
      operation: {
        type: "employee-profiles.set",
        targetId: employee.id,
        payload: {
          profileIds: ["grant-alpha", "grant-beta", "grant-gamma"],
          reason: "Gamma operational need.",
          grantedBy: "gamma-owner",
          reviewCycleDays: 60
        }
      }
    });
    expect(proposedGrants(add).slice(0, 2)).toEqual(service.getEmployee(employee.id).knowledgeGrants);
    expect(proposedGrants(add)[2]).toMatchObject({
      profileId: "grant-gamma",
      reason: "Gamma operational need.",
      grantedBy: "gamma-owner",
      reviewCycleDays: 60,
      source: "explicit"
    });
    expect(proposedGrants(add)[2]?.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await service.approveKnowledgeChangeRequest(add.id, "access-owner");

    const beforeRevoke = service.getEmployee(employee.id).knowledgeGrants;
    const revoke = await service.createKnowledgeChangeRequest({
      title: "Revoke Alpha grant",
      reason: "Remove Alpha without rewriting retained grants.",
      operation: {
        type: "employee-profiles.set",
        targetId: employee.id,
        payload: {
          profileIds: ["grant-beta", "grant-gamma"],
          reason: "Legacy revoke form value must not fan out.",
          grantedBy: "revoke-reviewer",
          expiresAt: "2030-01-01T00:00:00.000Z",
          reviewCycleDays: 365
        }
      }
    });
    expect(proposedGrants(revoke)).toEqual(beforeRevoke.slice(1));
    await service.approveKnowledgeChangeRequest(revoke.id, "access-owner");
    expect(service.getEmployee(employee.id).knowledgeGrants).toEqual(beforeRevoke.slice(1));
  });

  it("keeps project-role grant overrides isolated and removes grants without rewriting survivors", async () => {
    const service = await WorkbenchService.open({ dataRoot: temporaryRoot() });
    await createGrantProfiles(service);
    const employee = await service.createEmployee({
      id: "project-grant-worker",
      identity: {
        displayName: "Project Grant Worker",
        background: "Exercises project-role grants.",
        responsibilities: ["Use project knowledge"]
      }
    });
    const projectRoot = temporaryRoot();
    await service.createProject({
      id: "grant-project",
      rootPath: projectRoot,
      descriptorPath: path.join(projectRoot, "multi-agent.project.yaml"),
      roles: [{
        id: "operator",
        displayName: "Operator",
        description: "Operate with governed knowledge.",
        instructions: "Use only authorized knowledge.",
        knowledgeProfileIds: ["grant-alpha", "grant-beta", "grant-gamma"]
      }]
    });
    const binding = await service.saveProjectBinding("grant-project", {
      roles: [{
        roleId: "operator",
        employeeId: employee.id,
        knowledgeProfileIds: ["grant-alpha", "grant-beta"],
        knowledgeGrants: [
          {
            profileId: "grant-alpha",
            reason: "Project Alpha need.",
            grantedBy: "project-alpha-owner",
            grantedAt: "2025-04-01T00:00:00.000Z",
            expiresAt: "2027-04-01T00:00:00.000Z",
            reviewCycleDays: 45,
            lastReviewedAt: "2025-12-04T00:00:00.000Z"
          },
          {
            profileId: "grant-beta",
            reason: "Project Beta need.",
            grantedBy: "project-beta-owner",
            grantedAt: "2025-05-01T00:00:00.000Z",
            expiresAt: "2028-05-01T00:00:00.000Z",
            reviewCycleDays: 180,
            lastReviewedAt: "2025-12-05T00:00:00.000Z"
          }
        ]
      }]
    });
    const originalBeta = structuredClone(binding.roles[0]!.knowledgeGrants[1]!);

    const retain = await service.createKnowledgeChangeRequest({
      title: "Retain project Alpha grant",
      reason: "Review only the project Alpha grant.",
      operation: {
        type: "project-role-profiles.set",
        projectId: "grant-project",
        roleId: "operator",
        payload: {
          profileIds: ["grant-alpha", "grant-beta"],
          grantOverrides: [{
            profileId: "grant-alpha",
            reason: "Project Alpha retained.",
            grantedBy: "project-reviewer",
            reviewCycleDays: 75,
            lastReviewedAt: "2026-03-03T00:00:00.000Z"
          }]
        }
      }
    });
    expect(proposedGrants(retain)[1]).toEqual(originalBeta);
    await service.approveKnowledgeChangeRequest(retain.id, "project-access-owner");
    expect(service.getProjectBinding("grant-project").roles[0]?.knowledgeGrants).toEqual(proposedGrants(retain));

    await expect(service.createKnowledgeChangeRequest({
      title: "Add incomplete project Gamma grant",
      reason: "Reject incomplete project-role grant metadata.",
      operation: {
        type: "project-role-profiles.set",
        projectId: "grant-project",
        roleId: "operator",
        payload: { profileIds: ["grant-alpha", "grant-beta", "grant-gamma"] }
      }
    })).rejects.toThrow(/grant-gamma reason is required for a new profile/);

    const beforeNarrow = service.getProjectBinding("grant-project").roles[0]!.knowledgeGrants;
    const narrow = await service.createKnowledgeChangeRequest({
      title: "Narrow project grants",
      reason: "Remove project Alpha without changing Beta.",
      operation: {
        type: "project-role-profiles.set",
        projectId: "grant-project",
        roleId: "operator",
        payload: {
          profileIds: ["grant-beta"],
          reason: "Legacy narrow form value must not fan out.",
          grantedBy: "project-narrow-reviewer",
          reviewCycleDays: 365
        }
      }
    });
    expect(proposedGrants(narrow)).toEqual([beforeNarrow[1]]);
    await service.approveKnowledgeChangeRequest(narrow.id, "project-access-owner");
    expect(service.getProjectBinding("grant-project").roles[0]?.knowledgeGrants).toEqual([beforeNarrow[1]]);
  });
});
