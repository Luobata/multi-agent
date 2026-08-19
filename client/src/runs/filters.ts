import type { Run } from "../types";

/** 运行卷宗列表的筛选：类别与项目的纯函数过滤，供列表工具栏与外部测试复用。 */
export const CATEGORY_LABELS: Record<"single" | "graph" | "supervisor", string> = {
  single: "单任务",
  graph: "Graph 编排",
  supervisor: "领队协作"
};

export function filterRuns(
  runs: Run[],
  filters: { category: "all" | "single" | "graph" | "supervisor"; project: "all" | "none" | string }
): Run[] {
  return runs.filter((run) => {
    if (filters.category !== "all" && (run.category ?? "graph") !== filters.category) return false;
    if (filters.project === "none") return !run.project;
    if (filters.project !== "all" && run.project !== filters.project) return false;
    return true;
  });
}
