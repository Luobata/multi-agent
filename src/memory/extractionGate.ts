// Value gate for memory extraction. Status vocabulary matches the runner
// (src/runtime/runner.ts): a finished run is "passed" | "blocked" | "failed".
// There is no "completed" run status. Invocations may be "cancelled"; treat
// that defensively as skip in case a cancelled status is ever surfaced here.
export function shouldExtract(run: {
  status: string;
  nodes: Record<string, { status: string }>;
}): { extract: boolean; reason: string } {
  const nodeCount = Object.keys(run.nodes ?? {}).length;
  if (run.status === "cancelled") return { extract: false, reason: "cancelled run" };
  if (run.status === "failed" || run.status === "blocked") {
    return { extract: true, reason: "failure carries reusable lessons" };
  }
  if (run.status === "passed") {
    if (nodeCount <= 1) return { extract: false, reason: "trivial single-node run" };
    return { extract: true, reason: "multi-node passed run" };
  }
  return { extract: false, reason: `unhandled status: ${run.status}` };
}
