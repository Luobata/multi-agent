import path from "node:path";
import type { ExecutionPlanNode } from "../core/types.js";
import type { EmployeeDefinition } from "./types.js";

export const MIDSCENE_BROWSER_RESOURCE = "midscene-browser";
export const WORKSPACE_MUTATION_RESOURCE_PREFIX = "workspace-mutation:";

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

/** Serializes mutation-capable Supervisor nodes that share one physical checkout/worktree. */
export function nodeMutationResources(node: ExecutionPlanNode, providerCwd: string | undefined): string[] {
  const workKind = typeof node.metadata?.workKind === "string"
    ? node.metadata.workKind
    : typeof node.with.__workKind === "string"
      ? node.with.__workKind
      : undefined;
  if (workKind !== "code" && workKind !== "integration") return [];
  return [`${WORKSPACE_MUTATION_RESOURCE_PREFIX}${path.resolve(providerCwd ?? ".")}`];
}

/** Fair, process-local exclusive queue for adapters that cannot be shared concurrently. */
export class ExclusiveRuntimeResourceQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(resources: string[], onWait?: (resources: string[]) => void | Promise<void>): Promise<() => void> {
    const releases: Array<() => void> = [];
    const normalized = [...new Set(resources)].sort();
    if (normalized.some((resource) => this.tails.has(resource))) await onWait?.(normalized);
    for (const resource of normalized) {
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
