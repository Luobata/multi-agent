import { graphArchitectureAdapter } from "./graph.js";
import { supervisorArchitectureAdapter } from "./supervisor.js";
import type { ArchitectureAdapter, ArchitectureRegistry } from "./types.js";

export function createDefaultArchitectureRegistry(): ArchitectureRegistry {
  return new Map([
    [graphArchitectureAdapter.id, graphArchitectureAdapter],
    [supervisorArchitectureAdapter.id, supervisorArchitectureAdapter]
  ]);
}

export function registerArchitectureAdapter(
  registry: ArchitectureRegistry,
  adapter: ArchitectureAdapter
): ArchitectureRegistry {
  if (registry.has(adapter.id)) throw new Error(`architecture adapter already registered: ${adapter.id}`);
  registry.set(adapter.id, adapter);
  return registry;
}
