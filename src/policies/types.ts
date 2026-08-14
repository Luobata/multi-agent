import type { JsonObject } from "../core/types.js";

export interface CompiledPolicyPack {
  ref: { id: string; version: number };
  digest: string;
  assignment: JsonObject;
  gates: JsonObject;
  context: JsonObject;
}
