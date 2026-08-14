import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchService } from "../src/workbench/service.js";
import type { SkillCreateInput } from "../src/workbench/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("browser-e2e-validation skill template", () => {
  it("requires Midscene and forbids raw browser or DOM fallbacks", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-e2e-skill-"));
    roots.push(dataRoot);
    const service = await WorkbenchService.open({ dataRoot });
    const template = JSON.parse(fs.readFileSync(
      path.resolve("templates/workbench/browser-e2e-validation.skill.json"),
      "utf8"
    )) as SkillCreateInput;

    const skill = await service.createSkill(template);

    expect(skill.description).toContain("规则版本 v8，完整继承 v7");
    expect(skill.description).toContain("Midscene");
    expect(skill.instructions).toContain("ctx.agent");
    expect(skill.instructions).toContain("aiAct");
    expect(skill.instructions).toContain("npx -y @midscene/web@1");
    expect(skill.instructions).toContain("act --prompt");
    expect(skill.instructions).toContain("assert --prompt");
    expect(skill.instructions).toContain("禁止写成 `act 文本`、`assert 文本`");
    expect(skill.instructions).toContain("无限重试");
    expect(skill.instructions).toContain("一次只执行一条 Midscene 命令");
    expect(skill.instructions).toContain("同一工作项正常只建立一个浏览器会话");
    expect(skill.instructions).toContain("运行时排队独占共享 Midscene 会话");
    expect(skill.instructions).toContain("遇到第一个足以判定验收失败的决定性证据后立即停止");
    expect(skill.instructions).toContain("先运行与 changedFiles 和当前分片验收标准直接相关的定向测试");
    expect(skill.instructions).toContain("才运行整库类型检查、构建或全量测试");
    expect(skill.instructions).toContain("同一 commit");
    expect(skill.instructions).toContain("TEST_SHARD_REQUIRED");
    expect(skill.instructions).toContain("MIDSCENE_ENVIRONMENT_BLOCKED");
    expect(skill.description).toContain("http://127.0.0.1:4319");
    expect(skill.description).toContain("直接用 Midscene open/connect 访问");
    expect(skill.description).toContain("不得先依赖 shell curl/fetch 或自建 listen 探活");
    expect(skill.description).toContain("EPERM/loopback 失败不能作为浏览器不可访问的证据");
    expect(skill.description).toContain("候选 URL 覆盖默认主看板地址");
    expect(skill.description).toContain("不得回退到 4318");
    expect(skill.instructions).toContain("超过 3 个独立验收域");
    expect(skill.instructions).toContain("不得检查 npx 缓存源码");
    expect(skill.instructions).toContain("不得停止、替换或占用 Workbench 的 4318 端口");
    expect(skill.instructions).toContain("最终 Gate 只补最小跨分片检查");
    expect(skill.instructions).toContain("禁止用裸 Chrome --headless");
    expect(skill.instructions).toContain("或退回裸浏览器/CDP/DOM 方案");
    expect(skill.instructions).toContain("Midscene HTML/Markdown 报告");
    expect(skill.instructions).toContain("`Target closed`、protocol error");
    expect(skill.instructions).toContain("允许唯一一次有边界的恢复");
    expect(skill.instructions).toContain("只执行尚未完成的剩余步骤");
    expect(skill.instructions).toContain("保留恢复前已成功的证据");
    expect(skill.instructions).toContain("禁止第二次恢复");
    expect(skill.instructions).toContain("截图本身不可观测的精确属性");
    expect(skill.instructions).toContain("允许使用复合证据判定");
    expect(skill.instructions).toContain("真实浏览器已观察到非目标项不导航");
    expect(skill.instructions).toContain("聚焦测试证明默认 cursor");
    expect(skill.instructions).toContain("在线浏览器读取路径通过");
    expect(skill.instructions).toContain("offline/checking 的聚焦组件集成测试通过");
    expect(skill.instructions).toContain("分别清晰引用浏览器证据与 automation-run 证据");
    expect(skill.instructions).toContain("不得为了制造离线态停止 Workbench 4318");
    expect(skill.instructions).toContain("禁止纯静态检查代替");
    expect(skill.instructions).toContain("6 个页面中的前 5 个");
    expect(skill.instructions).toContain("60 秒无输出或工具超时");
    expect(skill.instructions).toContain("定向组件/集成测试");
    expect(skill.instructions).toContain("必须在 risks 记录");
    expect(skill.instructions).toContain("不得仅凭该环境超时 Block");
    expect(skill.instructions).toContain("另一浏览器门禁已经成功进入并验证同一页面");
    expect(skill.instructions).toContain("工具/环境噪声");
    expect(skill.instructions).toContain("不得重复认定为产品缺陷");
    expect(skill.instructions).toContain("右边缘贴近截图边界");
    expect(skill.instructions).toContain("可见内容或边框实际截断");
    expect(skill.instructions).toContain("`scrollWidth > clientWidth`");
    expect(skill.instructions).toContain("截图可见完整右边框及留白");
    expect(skill.instructions).toContain("错误标签页、空白标签页、明显错误视图");
    expect(skill.instructions).toContain("一次可见 CTA 操作未生效");
    expect(skill.instructions).toContain("重新连接同一候选 URL");
    expect(skill.instructions).toContain("`#publications` / “调用包”入口");
    expect(skill.instructions).toContain("不得持续盲目滚动直至超时");
    expect(skill.instructions).toContain("Enter+Space");
    expect(skill.instructions).toContain("恢复后实际 CTA 点击仍可重复不生效");
    expect(skill.tools).toContain("Bash");
  });
});
