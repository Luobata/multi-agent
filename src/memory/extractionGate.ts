export function shouldExtract(run: {
  status: string;
  nodes: Record<string, { status: string }>;
}): { extract: boolean; reason: string } {
  const nodeCount = Object.keys(run.nodes ?? {}).length;
  if (run.status === "cancelled") return { extract: false, reason: "cancelled run" };
  if (run.status === "failed" || run.status === "blocked") {
    return { extract: true, reason: "failure carries reusable lessons" };
  }
  if (run.status === "completed") {
    if (nodeCount <= 1) return { extract: false, reason: "trivial single-node run" };
    return { extract: true, reason: "multi-node completed run" };
  }
  return { extract: false, reason: `unhandled status: ${run.status}` };
}
