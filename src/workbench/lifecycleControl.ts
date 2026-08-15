import type {
  InvocationControlAction,
  InvocationControlProjection,
  InvocationRecord
} from "./types.js";

const TERMINAL = new Set<InvocationRecord["status"]>(["completed", "blocked", "failed", "cancelled"]);

function sameGoalLineage(left: InvocationRecord, right: InvocationRecord): boolean {
  const contextId = left.source.contextId;
  return Boolean(
    contextId
    && contextId.startsWith("requirement-lineage:")
    && right.source.contextId === contextId
    && right.source.project === left.source.project
    && right.source.taskId === left.source.taskId
  );
}

function lineageFor(invocation: InvocationRecord, peers: readonly InvocationRecord[]): InvocationControlProjection["lineage"] {
  if (!invocation.source.contextId?.startsWith("requirement-lineage:")) return undefined;
  const family = peers
    .filter((candidate) => sameGoalLineage(invocation, candidate))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const index = family.findIndex((candidate) => candidate.id === invocation.id);
  if (index < 0) return undefined;
  return {
    rootInvocationId: family[0]!.id,
    ...(index > 0 ? { predecessorInvocationId: family[index - 1]!.id } : {}),
    cycle: index + 1
  };
}

function actionsFor(invocation: InvocationRecord): InvocationControlAction[] {
  const taskLinked = Boolean(invocation.source.taskId);
  if (invocation.status === "queued" || invocation.status === "running") return ["monitor", "cancel"];
  if (invocation.status === "awaiting-human-decision") return ["decide", "cancel"];
  if (invocation.status === "cancellation-requested") return ["monitor"];
  if (invocation.status === "completed") {
    return taskLinked ? ["review-delivery", "view-evidence"] : ["view-evidence"];
  }
  if (invocation.status === "blocked" || invocation.status === "failed") {
    return taskLinked
      ? ["view-evidence", "retry-successor", "abandon-goal"]
      : ["view-evidence", "retry-successor"];
  }
  return taskLinked
    ? ["view-evidence", "restart-successor", "abandon-goal"]
    : ["view-evidence", "restart-successor"];
}

/** Pure, versioned explanation of one immutable Attempt and its legal next actions. */
export function invocationControlProjection(
  invocation: InvocationRecord,
  peers: readonly InvocationRecord[] = [invocation]
): InvocationControlProjection {
  const lineage = lineageFor(invocation, peers);
  const terminal = TERMINAL.has(invocation.status);
  const waiting = invocation.status === "awaiting-human-decision" || invocation.status === "cancellation-requested";
  const taskLinked = Boolean(invocation.source.taskId);
  const outcome = invocation.status === "completed"
    ? "succeeded" as const
    : invocation.status === "blocked" || invocation.status === "failed" || invocation.status === "cancelled"
      ? invocation.status
      : undefined;
  const owner = invocation.status === "awaiting-human-decision"
    ? "user" as const
    : invocation.status === "blocked" || invocation.status === "failed"
      ? "configuration-owner" as const
      : invocation.status === "cancelled" || (invocation.status === "completed" && taskLinked)
        ? "user" as const
        : terminal
          ? "none" as const
          : "runtime" as const;
  const goalState = terminal
    ? (taskLinked && invocation.status !== "completed" ? "attention" : taskLinked ? "attention" : "satisfied")
    : invocation.status === "awaiting-human-decision" ? "attention" : "active";
  return {
    schemaVersion: 1,
    attempt: {
      phase: terminal ? "ended" : waiting ? "waiting" : invocation.status === "queued" ? "queued" : "active",
      ...(outcome ? { outcome } : {})
    },
    goal: { state: goalState },
    owner,
    allowedActions: actionsFor(invocation),
    ...(lineage ? { lineage } : {})
  };
}

export function withInvocationControl(
  invocation: InvocationRecord,
  peers: readonly InvocationRecord[]
): InvocationRecord {
  return { ...invocation, control: invocationControlProjection(invocation, peers) };
}
