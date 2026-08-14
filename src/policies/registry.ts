import { softwareDeliveryPolicyPackV1 } from "./softwareDelivery.js";
import type { CompiledPolicyPack } from "./types.js";

const packs = new Map([["software-delivery@1", softwareDeliveryPolicyPackV1]]);

export function compilePolicyPack(ref?: { id: string; version: number }): CompiledPolicyPack | undefined {
  if (!ref || ref.id === "none") return undefined;
  const pack = packs.get(`${ref.id}@${ref.version}`);
  if (!pack) throw new Error(`policy pack not found: ${ref.id}@${ref.version}`);
  return structuredClone(pack);
}

export function legacySupervisorPolicyPack(): CompiledPolicyPack {
  return structuredClone(softwareDeliveryPolicyPackV1);
}
