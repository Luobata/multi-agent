import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchService, createDaemonApp } from "../src/index.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("daemon bootstrap performance guard", () => {
  it("projects every bootstrap field from one consistent Workbench snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-bootstrap-"));
    directories.push(root);
    const service = await WorkbenchService.open({ dataRoot: root });
    const expected = {
      providers: service.listProviders(),
      skills: service.listSkills(true),
      knowledgeBases: service.listKnowledgeBases(true),
      knowledgeProfiles: service.listKnowledgeProfiles(true),
      knowledgeChanges: service.listKnowledgeChangeRequests(),
      workflowChanges: service.listWorkflowChangeRequests(),
      configurationProposals: service.listConfigurationProposals(),
      architectureTemplates: service.listArchitectureTemplates(),
      gateValidators: service.listGateValidators(),
      employees: service.listEmployees(true),
      employeeTemplates: service.listEmployeeTemplates(true),
      managementPolicies: service.listManagementPolicies(true),
      entrancePolicies: service.listEntrancePolicies(true),
      workflows: service.listWorkflows(true),
      sessions: service.listSessions(),
      publications: service.listPublications(true),
      projects: service.listProjects(true),
      projectBindings: service.listProjectBindings(),
      passiveProjectAccesses: service.listPassiveProjectAccesses(),
      humanDecisionRequests: service.listHumanDecisionRequests(),
      activity: service.getActivitySnapshot()
    };
    const snapshot = vi.spyOn(service, "snapshot");
    const app = createDaemonApp(service, { staticDir: path.join(root, "missing-client") });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bootstrap`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: expected });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
