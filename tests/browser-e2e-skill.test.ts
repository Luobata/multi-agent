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
    expect(skill.instructions).toContain("一次只执行一条 Midscene 命令");
    expect(skill.instructions).toContain("禁止用裸 Chrome --headless");
    expect(skill.instructions).toContain("禁止退回裸浏览器/CDP/DOM 方案");
    expect(skill.instructions).toContain("Midscene HTML/Markdown 报告");
    expect(skill.tools).toContain("Bash");
  });
});
