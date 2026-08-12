import type { EmployeeDefinition } from "./types.js";

export const MIDSCENE_BROWSER_RESOURCE = "midscene-browser";

function enabledSkillIds(employee: EmployeeDefinition): Set<string> {
  return new Set(employee.skills.flatMap((binding) => {
    if (typeof binding === "string") return [binding];
    return binding.enabled === false ? [] : [binding.id];
  }));
}

/** Maps capabilities to scarce runtime adapters, not Employees to worker slots. */
export function employeeRuntimeResources(employee: EmployeeDefinition): string[] {
  const skills = enabledSkillIds(employee);
  return skills.has("browser-e2e-validation") ? [MIDSCENE_BROWSER_RESOURCE] : [];
}

/** Fair, process-local exclusive queue for adapters that cannot be shared concurrently. */
export class ExclusiveRuntimeResourceQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(resources: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const resource of [...new Set(resources)].sort()) {
      releases.push(await this.acquireOne(resource));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  private async acquireOne(resource: string): Promise<() => void> {
    const predecessor = this.tails.get(resource) ?? Promise.resolve();
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.tails.set(resource, tail);
    await predecessor.catch(() => undefined);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      openGate();
      if (this.tails.get(resource) === tail) this.tails.delete(resource);
    };
  }
}
