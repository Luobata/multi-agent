import type { RunnerTestSuite, TestContext as VitestTestContext } from "vitest";
import { ReportHelper } from "../report-helper";

interface AgentLike {
  reportFile?: string | null;
  destroy(): Promise<void>;
}

export abstract class BaseTestContext<TAgent extends AgentLike> {
  agent: TAgent;
  startTime: number;
  private storedReportFile: string | null | undefined;

  protected constructor(agent: TAgent) {
    this.agent = agent;
    this.startTime = performance.now();
  }

  get reportFile(): string | null | undefined {
    return this.storedReportFile ?? this.agent.reportFile;
  }

  async destroy(): Promise<void> {
    await this.agent.destroy();
    this.storedReportFile = this.agent.reportFile;
    await this.onDestroy();
  }

  protected async onDestroy(): Promise<void> {}

  protected static collectReport(
    reportHelper: ReportHelper,
    context: BaseTestContext<AgentLike> | undefined,
    testContext: VitestTestContext
  ): Promise<void> {
    return reportHelper.collectReport(context, testContext);
  }

  protected static mergeAndTeardown(
    reportHelper: ReportHelper,
    teardown: () => Promise<void>,
    suite: RunnerTestSuite,
    reportName?: string
  ): Promise<string | null> {
    const merged = reportHelper.mergeReports(suite, reportName);
    return teardown().then(() => merged);
  }
}
