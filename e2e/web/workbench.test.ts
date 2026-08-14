import { describe, it } from "vitest";
import { WebTest } from "../support/context";

const baseUrl = process.env.WORKBENCH_E2E_URL ?? "http://127.0.0.1:4318";
const runId = process.env.WORKBENCH_E2E_RUN_ID;

describe("Workbench first-use and operations", () => {
  const context = WebTest.setup(baseUrl, { viewport: { width: 1440, height: 1000 } });

  it("guides a first-time user and previews operations safely", async () => {
    await context.agent.aiAct("确认当前是 Local Agent Workbench 的‘现在做什么’首页。确认‘继续工作’区域在统计信息之前；如果当前没有待处理任务，确认页面展示从创建或完善员工、接入项目、启动团队或需求，到查看交付证据的四步入门路径。然后点击左侧的‘设置·集成’。确认页面依次展示‘模式与迁移’、‘环境诊断’、‘数据保留 / 备份 / 重置’、‘安全’四个分区，并且没有横向溢出。最后停留在设置页面。");
    await context.agent.aiAct("在‘Bundle JSON’文本框中输入一个无效 JSON，例如左花括号，点击‘校验并预览’。确认页面在导入区域内显示 JSON 格式无效，并且没有出现已应用或写入成功的提示。然后清空输入，点击‘生成 JSON’，再点击‘校验并预览’；确认结果显示 Bundle 有效，并列出预览项，而不是直接应用变更。");
    await context.agent.aiAct("点击‘估算并预览 30 天保留策略’，确认页面展示候选数量、受保护数量、预计字节和一个需要手工输入的保留策略令牌；确认在没有输入匹配令牌时‘应用保留策略’不可用。将备份 ID 改为 browser-e2e-backup.json，点击‘创建本地备份’，确认出现包含摘要哈希的备份回执；确认‘重置配置’在没有输入 RESET-CONFIG 时不可用。");
  });
});

describe.skipIf(!runId)("Workbench Run Receipt", () => {
  const context = WebTest.setup(`${baseUrl}/#runs/${encodeURIComponent(runId ?? "")}?view=receipt`, {
    viewport: { width: 1280, height: 900 }
  });

  it("opens the real Supervisor Run receipt from a stable deep link", async () => {
    await context.agent.aiAct(`确认运行卷宗已通过深链打开 Run ${runId}。确认页面展示 Run Receipt，其中包含状态或阶段、下一步、预算、目标版本、失败分类，以及可用或 legacy/unavailable 的证据说明；本次真实 Supervisor fixture 应显示完成状态且不应把缺失的旧字段误报为新的运行失败。刷新页面后，再次确认仍停留在同一 Run Receipt。`);
  });
});

describe("Workbench mobile layout", () => {
  const context = WebTest.setup(baseUrl, { viewport: { width: 390, height: 844 } });

  it("keeps the task path usable on a narrow viewport", async () => {
    await context.agent.aiAct("确认移动端页面没有水平滚动或被截断的主要操作。确认‘现在做什么’标题和‘继续工作’区域可见；若显示四步入门，确认每一步纵向排列且按钮可读。打开底部或侧边的‘更多’，进入‘设置·集成’，确认四个设置分区和危险操作按钮都能在当前宽度内阅读与操作，且焦点状态清晰。");
  });
});
