import { describe, expect, it } from "vitest";
import { assertKnowledgeControlPlane } from "./App";
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
      .toThrow(/运行核心版本早于请求分流策略/);
  });
});
