import type {
  SupervisorDagDefinition,
  SupervisorDagNode,
  SupervisorDagNodeKind,
  SupervisorDagWorkKind,
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

const DAG_NODE_KINDS = new Set<SupervisorDagNodeKind>([
  "task",
  "test",
  "merge",
  "integration",
  "integration-test",
  "other"
]);

const DAG_WORK_KINDS = new Set<SupervisorDagWorkKind>([
  "discussion",
  "code",
  "test",
  "audit",
  "integration",
  "other"
]);

function defaultDagWorkKind(kind: SupervisorDagNodeKind): SupervisorDagWorkKind {
  if (kind === "test" || kind === "integration-test") return "test";
  if (kind === "merge" || kind === "integration") return "integration";
  return "other";
}

function normalizeSupervisorDag(
  input: NonNullable<SupervisorFlowInput["dag"]>,
  memberRoleIds?: ReadonlySet<string>
): SupervisorDagDefinition {
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    throw new Error("supervisor flow dag nodes must not be empty");
  }
  const nodeIds = new Set<string>();
  const nodes = input.nodes.map((candidate, index): SupervisorDagNode => {
    const nodeId = id(candidate?.nodeId, `supervisor dag node ${index + 1} nodeId`);
    if (nodeIds.has(nodeId)) throw new Error(`duplicate supervisor dag node ${nodeId}`);
    if (/^supervisor-r\d+$/.test(nodeId) || nodeId.startsWith("gate-")) {
      throw new Error(`supervisor dag node ${nodeId} conflicts with a reserved runtime node id`);
    }
    nodeIds.add(nodeId);
    const roleId = candidate.roleId === undefined
      ? id(candidate.roleRef, `supervisor dag node ${nodeId} roleId`)
      : id(candidate.roleId, `supervisor dag node ${nodeId} roleId`);
    if (candidate.roleId !== undefined && candidate.roleRef !== undefined && candidate.roleId !== candidate.roleRef) {
      throw new Error(`supervisor dag node ${nodeId} roleId and roleRef must match when both are provided`);
    }
    if (memberRoleIds && !memberRoleIds.has(roleId)) {
      throw new Error(`supervisor dag node ${nodeId} references unknown member role ${roleId}`);
    }
    if (!Array.isArray(candidate.needs)) throw new Error(`supervisor dag node ${nodeId} needs must be an array`);
    const needs = candidate.needs.map((need, needIndex) => id(need, `supervisor dag node ${nodeId} need ${needIndex + 1}`));
    if (new Set(needs).size !== needs.length) throw new Error(`supervisor dag node ${nodeId} has duplicate needs`);
    if (!DAG_NODE_KINDS.has(candidate.kind)) {
      throw new Error(`supervisor dag node ${nodeId} has unsupported kind ${String(candidate.kind)}`);
    }
    if (candidate.required !== undefined && typeof candidate.required !== "boolean") {
      throw new Error(`supervisor dag node ${nodeId} required must be boolean`);
    }
    if (candidate.requiredCapabilities !== undefined && !Array.isArray(candidate.requiredCapabilities)) {
      throw new Error(`supervisor dag node ${nodeId} requiredCapabilities must be an array`);
    }
    const requiredCapabilities = (candidate.requiredCapabilities ?? []).map((capability, capabilityIndex) =>
      text(capability, `supervisor dag node ${nodeId} capability ${capabilityIndex + 1}`)
    );
    if (new Set(requiredCapabilities).size !== requiredCapabilities.length) {
      throw new Error(`supervisor dag node ${nodeId} has duplicate requiredCapabilities`);
    }
    const workKind = candidate.workKind ?? defaultDagWorkKind(candidate.kind);
    if (!DAG_WORK_KINDS.has(workKind)) {
      throw new Error(`supervisor dag node ${nodeId} has unsupported workKind ${String(workKind)}`);
    }
    const changeSet = candidate.changeSet?.trim();
    return {
      nodeId,
      roleId,
      needs,
      kind: candidate.kind,
      task: text(candidate.task, `supervisor dag node ${nodeId} task`),
      requiredCapabilities,
      workKind,
      ...(changeSet ? { changeSet } : {}),
      required: candidate.required ?? true
    };
  });

  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  for (const node of nodes) {
    for (const need of node.needs) {
      if (!byId.has(need)) throw new Error(`supervisor dag node ${node.nodeId} needs unknown node ${need}`);
      if (need === node.nodeId) throw new Error(`supervisor dag node ${node.nodeId} cannot depend on itself`);
    }
    if (node.kind === "merge") {
      if (node.needs.length < 2 || node.needs.some((need) => byId.get(need)?.kind !== "test")) {
        throw new Error(`supervisor dag merge node ${node.nodeId} must directly depend on at least two test nodes`);
      }
    }
    if (node.kind === "integration-test" && !node.needs.some((need) => byId.get(need)?.kind === "merge")) {
      throw new Error(`supervisor dag integration-test node ${node.nodeId} must directly depend on a merge node`);
    }
  }

  const remaining = new Set(nodeIds);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((nodeId) => byId.get(nodeId)!.needs.every((need) => !remaining.has(need)));
    if (ready.length === 0) {
      throw new Error(`supervisor flow dag contains a cycle among: ${[...remaining].join(", ")}`);
    }
    for (const nodeId of ready) remaining.delete(nodeId);
  }
  return { nodes };
}

function validateStoredDagMembers(flow: SupervisorFlowDefinition, memberRoleIds?: ReadonlySet<string>): void {
  if (!flow.dag || !memberRoleIds) return;
  for (const node of flow.dag.nodes) {
    if (!memberRoleIds.has(node.roleId)) {
      throw new Error(`supervisor dag node ${node.nodeId} references unknown member role ${node.roleId}`);
    }
  }
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
  current?: SupervisorFlowDefinition,
  memberRoleIds?: ReadonlySet<string>
): SupervisorFlowDefinition {
  if (input === undefined) {
    const flow = current ? structuredClone(current) : defaultSupervisorFlow();
    validateStoredDagMembers(flow, memberRoleIds);
    return flow;
  }
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

  const dag = input.dag ? normalizeSupervisorDag(input.dag, memberRoleIds) : undefined;
  return { version: (current?.version ?? 0) + 1, stages, gates, ...(dag ? { dag } : {}) };
}
