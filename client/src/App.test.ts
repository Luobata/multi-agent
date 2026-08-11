import { describe, expect, it } from "vitest";
import { assertKnowledgeControlPlane, pageFromHash, readNavigationMemory, rememberNavigationHash } from "./App";
import type { Bootstrap } from "./types";

function bootstrap(): Bootstrap {
  return {
    providers: [],
    skills: [],
    architectureTemplates: [],
    employees: [],
    workflows: [],
    sessions: [],
    publications: [],
    projects: [],
    projectBindings: [],
    activity: { invocations: [], instances: [] }
  };
}

describe("Workbench capability compatibility", () => {
  it("rejects a stale daemon instead of rendering Profile ids as missing", () => {
    expect(() => assertKnowledgeControlPlane(bootstrap())).toThrow(/运行核心版本早于知识控制台/);
  });

  it("accepts bootstrap snapshots that include the knowledge control plane", () => {
    expect(() => assertKnowledgeControlPlane({ ...bootstrap(), knowledgeBases: [], knowledgeProfiles: [], entrancePolicies: [] })).not.toThrow();
  });

  it("rejects a stale daemon that does not expose task entrance policies", () => {
    expect(() => assertKnowledgeControlPlane({ ...bootstrap(), knowledgeBases: [], knowledgeProfiles: [] }))
      .toThrow(/运行核心版本早于工作启动策略/);
  });
});

describe("multi-project console routes", () => {
  it("parses top-level management pages", () => {
    expect(pageFromHash("#dashboard")).toEqual({ page: "dashboard" });
    expect(pageFromHash("#projects")).toEqual({ page: "projects" });
    expect(pageFromHash("#spaces")).toEqual({ page: "projects" });
    expect(pageFromHash("#archive")).toEqual({ page: "archive" });
    expect(pageFromHash("#settings")).toEqual({ page: "settings" });
    expect(pageFromHash("#employees?item=mihuhu%2Fv2")).toEqual({ page: "employees", recordId: "mihuhu/v2" });
  });

  it("keeps project and requirement ids in nested routes", () => {
    expect(pageFromHash("#projects/prj-workbench")).toEqual({ page: "project", spaceId: "prj-workbench" });
    expect(pageFromHash("#projects/prj-workbench/board")).toEqual({ page: "board", spaceId: "prj-workbench" });
    expect(pageFromHash("#spaces/prj-workbench")).toEqual({ page: "project", spaceId: "prj-workbench" });
    expect(pageFromHash("#spaces/prj-workbench/board")).toEqual({ page: "board", spaceId: "prj-workbench" });
    expect(pageFromHash("#requirements/req%20101")).toEqual({ page: "requirement", requirementId: "req 101" });
    expect(pageFromHash("#runs?run=run%2F101")).toEqual({ page: "runs", runId: "run/101" });
    expect(pageFromHash("#requirements/req%20101?section=acceptance")).toEqual({ page: "requirement", requirementId: "req 101", section: "acceptance" });
    expect(pageFromHash("#requirements/req-1?section=unknown")).toEqual({ page: "requirement", requirementId: "req-1" });
  });

  it("persists the exact dossier link under its top-level navigation entry", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    };
    let memory = rememberNavigationHash({}, { page: "requirement", requirementId: "req-1", section: "acceptance" }, "#requirements/req-1?section=acceptance", storage);
    memory = rememberNavigationHash(memory, { page: "runs", runId: "run-1" }, "#runs?run=run-1", storage);
    expect(memory.board).toBe("requirements/req-1?section=acceptance");
    expect(readNavigationMemory(storage)).toMatchObject({
      board: "requirements/req-1?section=acceptance",
      runs: "runs?run=run-1"
    });
  });
});
