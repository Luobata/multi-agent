import { describe, expect, it } from "vitest";
import type { EmployeeDefinition } from "../src/workbench/types.js";
import {
  employeeRuntimeResources,
  ExclusiveRuntimeResourceQueue,
  MIDSCENE_BROWSER_RESOURCE,
  nodeMutationResources,
  WORKSPACE_MUTATION_RESOURCE_PREFIX
} from "../src/workbench/runtimeResources.js";

function employee(skills: EmployeeDefinition["skills"]): EmployeeDefinition {
  return { skills } as EmployeeDefinition;
}

describe("workbench runtime resources", () => {
  it("maps only enabled browser validation skills to the shared Midscene session", () => {
    expect(employeeRuntimeResources(employee([
      { id: "browser-e2e-validation", config: {}, enabled: true }
    ]))).toEqual([MIDSCENE_BROWSER_RESOURCE]);
    expect(employeeRuntimeResources(employee([
      { id: "browser-e2e-validation", config: {}, enabled: false }
    ]))).toEqual([]);
    expect(employeeRuntimeResources(employee(["read-repository"]))).toEqual([]);
  });

  it("serves one shared resource in acquisition order", async () => {
    const queue = new ExclusiveRuntimeResourceQueue();
    const order: string[] = [];
    const waits: string[][] = [];
    const releaseFirst = await queue.acquire([MIDSCENE_BROWSER_RESOURCE]);
    const second = queue.acquire([MIDSCENE_BROWSER_RESOURCE], (resources) => { waits.push(resources); }).then((release) => {
      order.push("second");
      return release;
    });
    const third = queue.acquire([MIDSCENE_BROWSER_RESOURCE], (resources) => { waits.push(resources); }).then((release) => {
      order.push("third");
      return release;
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    expect(waits).toEqual([[MIDSCENE_BROWSER_RESOURCE], [MIDSCENE_BROWSER_RESOURCE]]);
    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();
  });

  it("maps code and integration nodes to the physical workspace mutation lease", () => {
    const node = (workKind: string) => ({
      id: workKind,
      role: "worker",
      provider: "mock",
      needs: [],
      with: { __workKind: workKind }
    });
    expect(nodeMutationResources(node("code"), "/tmp/candidate")).toEqual([
      `${WORKSPACE_MUTATION_RESOURCE_PREFIX}/tmp/candidate`
    ]);
    expect(nodeMutationResources(node("integration"), "/tmp/candidate")).toEqual([
      `${WORKSPACE_MUTATION_RESOURCE_PREFIX}/tmp/candidate`
    ]);
    expect(nodeMutationResources(node("test"), "/tmp/candidate")).toEqual([]);
  });
});
