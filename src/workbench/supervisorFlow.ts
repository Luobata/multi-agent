import type {
  SupervisorFlowDefinition,
  SupervisorFlowInput,
  SupervisorFlowStage,
  SupervisorGate
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${ID_PATTERN.source}`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function defaultSupervisorFlow(): SupervisorFlowDefinition {
  return {
    version: 1,
    stages: [
      { id: "plan", kind: "supervisor", title: "Plan" },
      { id: "delegation-loop", kind: "delegation-loop", title: "Delegation loop" },
      { id: "delivery", kind: "delivery", title: "Delivery" }
    ],
    gates: []
  };
}

export function normalizeSupervisorFlow(
  input: SupervisorFlowInput | undefined,
  current?: SupervisorFlowDefinition
): SupervisorFlowDefinition {
  if (input === undefined) return current ? structuredClone(current) : defaultSupervisorFlow();
  if (!Array.isArray(input.stages) || input.stages.length === 0) {
    throw new Error("supervisor flow stages must not be empty");
  }
  if (!Array.isArray(input.gates)) throw new Error("supervisor flow gates must be an array");

  const stageIds = new Set<string>();
  const stages = input.stages.map((candidate, index): SupervisorFlowStage => {
    const stageId = id(candidate?.id, `supervisor flow stage ${index + 1} id`);
    if (stageIds.has(stageId)) throw new Error(`duplicate supervisor flow stage ${stageId}`);
    stageIds.add(stageId);
    const title = text(candidate?.title, `supervisor flow stage ${stageId} title`);
    if (candidate.kind === "gate") {
      return { id: stageId, kind: "gate", title, gateId: id(candidate.gateId, `supervisor flow stage ${stageId} gate id`) };
    }
    if (candidate.kind === "supervisor" || candidate.kind === "delegation-loop" || candidate.kind === "delivery") {
      return { id: stageId, kind: candidate.kind, title };
    }
    throw new Error(`supervisor flow stage ${stageId} has unsupported kind ${String((candidate as { kind?: unknown }).kind)}`);
  });

  const gateIds = new Set<string>();
  const gates = input.gates.map((candidate, index): SupervisorGate => {
    const gateId = id(candidate?.id, `supervisor gate ${index + 1} id`);
    if (gateIds.has(gateId)) throw new Error(`duplicate supervisor gate ${gateId}`);
    gateIds.add(gateId);
    const requiredCapability = text(candidate.requiredCapability, `supervisor gate ${gateId} required capability`);
    if (candidate.mode !== "after-each-delegation" && candidate.mode !== "before-completion") {
      throw new Error(`supervisor gate ${gateId} has unsupported mode ${String(candidate.mode)}`);
    }
    if (typeof candidate.required !== "boolean") throw new Error(`supervisor gate ${gateId} required must be boolean`);
    if (candidate.fallback !== "supervisor" && candidate.fallback !== "block") {
      throw new Error(`supervisor gate ${gateId} has unsupported fallback ${String(candidate.fallback)}`);
    }
    return {
      id: gateId,
      requiredCapability,
      mode: candidate.mode,
      required: candidate.required,
      instructions: text(candidate.instructions, `supervisor gate ${gateId} instructions`),
      fallback: candidate.fallback
    };
  });

  const loopIndexes = stages.flatMap((stage, index) => stage.kind === "delegation-loop" ? [index] : []);
  const deliveryIndexes = stages.flatMap((stage, index) => stage.kind === "delivery" ? [index] : []);
  if (loopIndexes.length !== 1) throw new Error("supervisor flow must contain exactly one delegation-loop stage");
  if (deliveryIndexes.length !== 1) throw new Error("supervisor flow must contain exactly one delivery stage");
  const loopIndex = loopIndexes[0]!;
  const deliveryIndex = deliveryIndexes[0]!;
  if (!stages.some((stage, index) => stage.kind === "supervisor" && index < loopIndex)) {
    throw new Error("supervisor flow must contain a supervisor plan stage before delegation-loop");
  }
  if (deliveryIndex !== stages.length - 1 || deliveryIndex <= loopIndex) {
    throw new Error("supervisor flow delivery must be the final stage after delegation-loop");
  }
  const referencedGates = new Set<string>();
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    if (stage.kind !== "gate") continue;
    if (index <= loopIndex || index >= deliveryIndex) {
      throw new Error(`supervisor gate stage ${stage.id} must be between delegation-loop and delivery`);
    }
    if (!gateIds.has(stage.gateId)) throw new Error(`supervisor gate stage ${stage.id} references unknown gate ${stage.gateId}`);
    if (referencedGates.has(stage.gateId)) throw new Error(`supervisor gate ${stage.gateId} is referenced by more than one stage`);
    referencedGates.add(stage.gateId);
  }
  for (const gate of gates) {
    if (!referencedGates.has(gate.id)) throw new Error(`supervisor gate ${gate.id} is not referenced by a flow stage`);
  }

  return { version: (current?.version ?? 0) + 1, stages, gates };
}
