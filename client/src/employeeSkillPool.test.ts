import { describe, expect, it } from "vitest";
import { countAddedSkillBindings, filterEmployeeSkillChoices } from "./employeeSkillPool";
import type { Skill } from "./types";

function skill(id: string, status: Skill["status"] = "active"): Skill {
  return {
    id,
    version: 1,
    status,
    displayName: id === "humanizer-zh" ? "Humanizer-zh" : id,
    description: `${id} description`,
    instructions: `${id} instructions`,
    tools: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z"
  };
}

describe("employee Skill pool choices", () => {
  const skills = [skill("humanizer-zh"), skill("backend-review"), skill("legacy-skill", "archived")];

  it("shows only active, initially unbound Skills in add mode", () => {
    const visible = filterEmployeeSkillChoices(skills, {
      mode: "add",
      initialBoundIds: ["humanizer-zh"],
      selectedIds: ["humanizer-zh"],
      search: ""
    });

    expect(visible.map((item) => item.id)).toEqual(["backend-review"]);
  });

  it("keeps selected archived Skills visible in manage mode and applies search", () => {
    const visible = filterEmployeeSkillChoices(skills, {
      mode: "manage",
      initialBoundIds: ["legacy-skill"],
      selectedIds: ["legacy-skill"],
      search: "legacy"
    });

    expect(visible.map((item) => item.id)).toEqual(["legacy-skill"]);
  });

  it("counts only newly selected bindings", () => {
    expect(countAddedSkillBindings(["humanizer-zh", "backend-review"], ["humanizer-zh"])).toBe(1);
  });
});
