import { DefaultReporter } from "vitest/reporters";

const CYAN = "\x1B[36m";
const RESET = "\x1B[0m";

function findReport(task: any): string | undefined {
  if (task.meta?.midsceneReport) return task.meta.midsceneReport;
  for (const child of task.tasks ?? []) {
    const found = findReport(child);
    if (found) return found;
  }
  return undefined;
}

export default class MidsceneReporter extends DefaultReporter {
  printTask(task: any) {
    const printDefault = (DefaultReporter.prototype as any).printTask?.bind(this) as ((task: any) => void) | undefined;
    if (!("filepath" in task) || !task.result?.state || ["run", "queued"].includes(task.result.state)) return;
    const reportPath = findReport(task);
    if (!reportPath) return printDefault?.(task);
    const lines: string[] = [];
    const originalLog = this.log;
    this.log = ((...messages: any[]) => lines.push(messages.join(" "))) as any;
    try {
      printDefault?.(task);
    } finally {
      this.log = originalLog;
    }
    lines.forEach((line, index) => this.log(index === 0 ? `${line} ${CYAN}${reportPath}${RESET}` : line));
  }
}
