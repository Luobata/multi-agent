import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startRecoveredDaemon } from "../dist/daemon/startup.js";
import { WorkbenchService } from "../dist/workbench/service.js";

const baseUrl = process.env.WORKBENCH_E2E_URL ?? "http://127.0.0.1:4318";
const runId = process.env.WORKBENCH_E2E_RUN_ID;
const outputDir = process.env.WORKBENCH_E2E_OUTPUT ?? "/tmp/multi-agent-safe-web-e2e";
const dataRoot = process.env.WORKBENCH_E2E_DATA_ROOT;
const staticDir = process.env.WORKBENCH_E2E_STATIC_DIR ?? path.resolve("dist/client");
if (!runId) throw new Error("WORKBENCH_E2E_RUN_ID is required");
await mkdir(outputDir, { recursive: true });

let daemon;
if (dataRoot) {
  const url = new URL(baseUrl);
  assert.equal(url.protocol, "http:", "safe E2E only supports a local HTTP fixture");
  assert(["127.0.0.1", "::1", "localhost"].includes(url.hostname), "safe E2E fixture must be loopback-only");
  const service = await WorkbenchService.open({ dataRoot });
  daemon = await startRecoveredDaemon(service, {
    host: url.hostname,
    port: Number(url.port || 80),
    staticDir
  });
}

const browser = await chromium.launch({ headless: true });
const results = [];

async function journey(name, viewport, run) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const startedAt = Date.now();
  const diagnostics = [];
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("response", response => {
    if (response.status() >= 400) diagnostics.push(`http ${response.status()}: ${response.url()}`);
  });
  try {
    await run(page);
    const screenshot = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ name, status: "passed", durationMs: Date.now() - startedAt, screenshot, diagnostics });
  } catch (error) {
    const screenshot = path.join(outputDir, `${name}-failed.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    results.push({
      name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      screenshot,
      url: page.url(),
      diagnostics,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await context.close();
  }
}

try {
  await journey("first-use-settings", { width: 1440, height: 1000 }, async (page) => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "现在做什么" }).waitFor();
    await page.getByText("继续工作", { exact: true }).waitFor();
    await page.getByText("01 创建或完善员工", { exact: true }).waitFor();
    await page.getByText("04 查看交付证据", { exact: true }).waitFor();
    const firstQueueTop = await page.getByText("继续工作", { exact: true }).boundingBox();
    const overviewTop = await page.getByText("概览与最近活动", { exact: true }).boundingBox();
    assert(firstQueueTop && overviewTop && firstQueueTop.y < overviewTop.y, "继续工作必须出现在统计概览之前");

    await page.getByRole("button", { name: "设置·集成" }).click();
    for (const title of ["01 · 模式与迁移", "02 · 环境诊断", "03 · 数据保留 / 备份 / 重置", "04 · 安全"]) {
      await page.getByRole("heading", { name: title }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "桌面设置页不应水平溢出");

    const bundle = page.getByLabel("Bundle JSON");
    await bundle.fill("{");
    await page.getByRole("button", { name: "校验并预览" }).click();
    await page.getByText("JSON 格式无效").waitFor();
    assert.equal(await page.getByText(/已应用|写入成功/).count(), 0, "无效 preview 不得产生写入成功提示");
    await bundle.fill("");
    await page.getByRole("button", { name: "生成 JSON" }).click();
    await page.waitForFunction(() => (document.querySelector("textarea")?.value.length ?? 0) > 20);
    await page.getByRole("button", { name: "校验并预览" }).click();
    await page.getByText(/有效，\d+ 项变更/).waitFor();

    await page.getByRole("button", { name: "估算并预览 30 天保留策略" }).click();
    const retentionToken = page.getByLabel("输入保留策略令牌");
    await retentionToken.waitFor();
    assert.equal(await page.getByRole("button", { name: "应用保留策略" }).isDisabled(), true, "未输入精确令牌时不得应用保留策略");
    await page.getByLabel("备份 ID（安全文件名）").fill("browser-e2e-backup.json");
    await page.getByRole("button", { name: "创建本地备份" }).click();
    await page.getByText("备份回执：").waitFor();
    assert.match(await page.getByText("备份回执：").textContent() ?? "", /[a-f0-9]{64}/, "备份回执必须包含 SHA-256 digest");
    assert.equal(await page.getByRole("button", { name: "重置配置" }).isDisabled(), true, "未输入 RESET-CONFIG 时不得重置");
  });

  await journey("run-receipt", { width: 1280, height: 900 }, async (page) => {
    const receiptUrl = `${baseUrl}/#runs/${encodeURIComponent(runId)}?view=receipt`;
    await page.goto(receiptUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Run Receipt" }).waitFor();
    await page.getByText(runId, { exact: false }).first().waitFor();
    await page.getByText("状态 / 阶段", { exact: true }).waitFor();
    await page.getByText("下一步", { exact: true }).waitFor();
    await page.getByText("预算", { exact: true }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Run Receipt" }).waitFor();
    assert.equal(new URL(page.url()).hash.includes(runId), true, "刷新后必须保留同一 Run Receipt 深链");
  });

  await journey("mobile-layout", { width: 390, height: 844 }, async (page) => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "现在做什么" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "移动首页不应水平溢出");
    await page.getByRole("button", { name: /更多/ }).click();
    await page.getByRole("button", { name: "设置·集成" }).last().click();
    await page.getByRole("heading", { name: "设置·集成" }).waitFor();
    await page.getByRole("heading", { name: "03 · 数据保留 / 备份 / 重置" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "移动设置页不应水平溢出");
  });
} finally {
  await browser.close();
  if (daemon?.listening) {
    await new Promise((resolve, reject) => daemon.close(error => error ? reject(error) : resolve()));
  }
  const reportPath = path.join(outputDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, runId, results }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath, results }, null, 2)}\n`);
}
