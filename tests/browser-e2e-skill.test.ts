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

    expect(skill.description).toContain("Midscene");
    expect(skill.instructions).toContain("ctx.agent");
    expect(skill.instructions).toContain("aiAct");
    expect(skill.instructions).toContain("npx -y @midscene/web@1");
    expect(skill.instructions).toContain("act --prompt");
    expect(skill.instructions).toContain("assert --prompt");
    expect(skill.instructions).toContain("禁止写成 `act 文本`、`assert 文本`");
    expect(skill.instructions).toContain("无限重试");
    expect(skill.instructions).toContain("一次只执行一条 Midscene 命令");
    expect(skill.instructions).toContain("同一工作项只建立一个浏览器会话");
    expect(skill.instructions).toContain("遇到第一个足以判定验收失败的决定性证据后立即停止");
    expect(skill.instructions).toContain("先运行与 changedFiles 和当前分片验收标准直接相关的定向测试");
    expect(skill.instructions).toContain("才运行整库类型检查、构建或全量测试");
    expect(skill.instructions).toContain("同一 commit");
    expect(skill.instructions).toContain("TEST_SHARD_REQUIRED");
    expect(skill.instructions).toContain("MIDSCENE_ENVIRONMENT_BLOCKED");
    expect(skill.instructions).toContain("超过 3 个独立验收域");
    expect(skill.instructions).toContain("不得检查 npx 缓存源码");
    expect(skill.instructions).toContain("不得停止、替换或占用 Workbench 的 4318 端口");
    expect(skill.instructions).toContain("最终 Gate 只补最小跨分片检查");
    expect(skill.instructions).toContain("禁止用裸 Chrome --headless");
    expect(skill.instructions).toContain("或退回裸浏览器/CDP/DOM 方案");
    expect(skill.instructions).toContain("Midscene HTML/Markdown 报告");
    expect(skill.tools).toContain("Bash");
  });
});
