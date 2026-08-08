import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/workbench/service.js";
import type { SkillCreateInput } from "../src/workbench/types.js";

describe("design-style-futaba skill template", () => {
  it("creates from the shipped template and carries injectable style instructions", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "design-style-"));
    const service = await WorkbenchService.open({ dataRoot });
    const skill = JSON.parse(fs.readFileSync(
      path.resolve(".", "templates/workbench/design-style-futaba.skill.json"),
      "utf8"
    )) as SkillCreateInput;
    const created = await service.createSkill(skill);
    expect(created.id).toBe("design-style-futaba");
    // Instructions must actually carry the design language, not be a stub.
    expect(created.instructions).toContain("2px");
    expect(created.instructions).toContain("data-theme");
    expect(created.instructions).toContain("--ink");
    expect(created.instructions.length).toBeGreaterThan(200);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
});
