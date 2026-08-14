import { PlaywrightAgent, type WebPageAgentOpt } from "@midscene/web/playwright";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import type { RunnerTestSuite, TestContext as VitestTestContext } from "vitest";
import { ReportHelper, buildReportMeta } from "../report-helper";
import { BaseTestContext } from "./base";

const DEFAULT_ARGS = ["--no-sandbox", "--ignore-certificate-errors"];

export interface WebTestOptions {
  viewport?: { width: number; height: number };
  headless?: boolean;
  agentOptions?: Omit<WebPageAgentOpt, "groupName" | "reportFileName">;
}

export class WebTest extends BaseTestContext<PlaywrightAgent> {
  private static sharedBrowser: Browser | null = null;
  private static sharedOptions: WebTestOptions = {};
  private static reportHelper = new ReportHelper();

  page: Page;

  private constructor(page: Page, agent: PlaywrightAgent) {
    super(agent);
    this.page = page;
  }

  protected async onDestroy(): Promise<void> {
    await this.page.close();
  }

  static async launchBrowser(options?: WebTestOptions): Promise<void> {
    WebTest.sharedOptions = options ?? {};
    WebTest.sharedBrowser = await chromium.launch({
      headless: options?.headless ?? true,
      args: DEFAULT_ARGS
    });
    WebTest.reportHelper.reset();
  }

  static async create(targetUrl: string, testContext: VitestTestContext, options?: WebTestOptions): Promise<WebTest> {
    if (!WebTest.sharedBrowser) await WebTest.launchBrowser(options);
    const resolved = { ...WebTest.sharedOptions, ...options };
    const page = await WebTest.sharedBrowser!.newPage({
      viewport: resolved.viewport ?? { width: 1440, height: 1000 }
    });
    await page.goto(targetUrl);
    const { groupName, reportFileName } = buildReportMeta(testContext);
    const agent = new PlaywrightAgent(page, {
      ...resolved.agentOptions,
      groupName,
      reportFileName
    });
    return new WebTest(page, agent);
  }

  static async collect(context: WebTest | undefined, testContext: VitestTestContext): Promise<void> {
    return BaseTestContext.collectReport(WebTest.reportHelper, context, testContext);
  }

  static async merge(suite: RunnerTestSuite, reportName?: string): Promise<string | null> {
    return BaseTestContext.mergeAndTeardown(WebTest.reportHelper, WebTest.teardown, suite, reportName);
  }

  static async teardown(): Promise<void> {
    await WebTest.sharedBrowser?.close();
    WebTest.sharedBrowser = null;
  }

  static setup(targetUrl: string, options?: WebTestOptions) {
    let current: WebTest | undefined;
    beforeAll(() => WebTest.launchBrowser(options));
    beforeEach(async (testContext) => {
      current = await WebTest.create(targetUrl, testContext, options);
    });
    afterEach((testContext) => {
      const context = current;
      current = undefined;
      return WebTest.collect(context, testContext);
    });
    afterAll((suite) => WebTest.merge(suite, "Workbench-Web"));
    return {
      get page() { return current!.page; },
      get agent() { return current!.agent; }
    } as { page: Page; agent: PlaywrightAgent };
  }
}
