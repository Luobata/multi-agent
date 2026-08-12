import { describe, expect, it } from "vitest";
import type { EmployeeDefinition } from "../src/workbench/types.js";
import {
  employeeRuntimeResources,
  ExclusiveRuntimeResourceQueue,
  MIDSCENE_BROWSER_RESOURCE
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
    const releaseFirst = await queue.acquire([MIDSCENE_BROWSER_RESOURCE]);
    const second = queue.acquire([MIDSCENE_BROWSER_RESOURCE]).then((release) => {
      order.push("second");
      return release;
    });
    const third = queue.acquire([MIDSCENE_BROWSER_RESOURCE]).then((release) => {
      order.push("third");
      return release;
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();
  });
});
