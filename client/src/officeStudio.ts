import type { InvocationRecord, WorkInstanceStatus } from "./types";

const TERMINAL_INVOCATION_STATUSES = new Set(["completed", "blocked", "failed", "cancelled"]);

export function completionRatio(tally: Record<WorkInstanceStatus, number>): number {
  const total = Object.values(tally).reduce((sum, count) => sum + count, 0);
  return total === 0 ? 0 : tally.completed / total;
}

export function progressTone(status: InvocationRecord["status"]): "running" | "completed" | "blocked" | "failed" {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed" || status === "cancelled") return "failed";
  return "running";
}

export function activeSupervisorInvocations(invocations: InvocationRecord[]): InvocationRecord[] {
  return invocations.filter((invocation) =>
    invocation.executionSnapshot?.workflow.architecture === "supervisor"
    && !TERMINAL_INVOCATION_STATUSES.has(invocation.status));
}

const STUDIO_TERMINAL_GRACE_MS = 45_000;

export function studioSupervisorInvocations(
  invocations: InvocationRecord[],
  now: number,
  graceMs: number = STUDIO_TERMINAL_GRACE_MS
): InvocationRecord[] {
  return invocations.filter((invocation) => {
    if (invocation.executionSnapshot?.workflow.architecture !== "supervisor") return false;
    if (!TERMINAL_INVOCATION_STATUSES.has(invocation.status)) return true;
    if (!invocation.completedAt) return false;
    return now - new Date(invocation.completedAt).getTime() <= graceMs;
  });
}
