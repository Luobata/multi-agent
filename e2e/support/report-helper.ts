import type { TestStatus } from "@midscene/core";
import { ReportMergingTool } from "@midscene/core/report";
import type { RunnerTestSuite, TestContext as VitestTestContext } from "vitest";
import { formatReportFileName, generateTimestamp } from "./utils";

export interface ReportableContext {
  reportFile: string | null | undefined;
  startTime: number;
  destroy(): Promise<void>;
}

export class ReportHelper {
  private reportTool = new ReportMergingTool();
  private individualReports: string[] = [];

  reset(): void {
    this.reportTool = new ReportMergingTool();
    this.individualReports = [];
  }

  async collectReport(context: ReportableContext | undefined, testContext: VitestTestContext): Promise<void> {
    let status: TestStatus = "passed";
    if (testContext.task.result?.errors?.[0]?.message.includes("timed out")) status = "timedOut";
    else if (testContext.task.result?.state === "fail") status = "failed";
    await context?.destroy();
    const reportFile = context?.reportFile ?? undefined;
    const reportAttributes = {
      testId: testContext.task.id,
      testTitle: testContext.task.name,
      testDescription: "",
      testDuration: context ? Math.round(performance.now() - context.startTime) : 0,
      testStatus: status
    };
    if (reportFile) this.reportTool.append({ reportFilePath: reportFile, reportAttributes });
    else this.reportTool.append({ reportAttributes: { ...reportAttributes, testStatus: "skipped" } });
    if (reportFile) this.individualReports.push(reportFile);
  }

  mergeReports(suite: RunnerTestSuite, reportName?: string): string | null {
    const finalReportName = formatReportFileName(`E2E-${(reportName ?? suite.name) || "MergedReport"}-${generateTimestamp()}`);
    for (const task of suite.tasks) {
      if (task.mode !== "skip") continue;
      this.reportTool.append({
        reportAttributes: {
          testId: task.id,
          testTitle: task.name,
          testDescription: "",
          testDuration: 0,
          testStatus: "skipped"
        }
      });
    }
    const merged = this.reportTool.mergeReports(finalReportName);
    const report = merged ?? this.individualReports[0] ?? null;
    if (report && suite.meta) suite.meta.midsceneReport = report;
    this.individualReports = [];
    return merged;
  }
}

export function buildReportMeta(testContext: VitestTestContext): { groupName: string; reportFileName: string } {
  const groupName = testContext.task.suite?.name || "UnnamedGroup";
  return {
    groupName: `E2E: ${groupName}`,
    reportFileName: formatReportFileName(`E2E-${groupName}-${testContext.task.name}-${generateTimestamp()}`)
  };
}
