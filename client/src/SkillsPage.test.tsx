/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillsPage } from "./SkillsPage";
import type { Bootstrap, Skill } from "./types";

const timestamp = "2026-08-03T00:00:00.000Z";
const systemSkill: Skill = {
  id: "team-orchestration",
  version: 1,
  status: "active",
  owner: "system",
  injection: "supervisor",
  displayName: "Team orchestration",
  description: "System leader capability.",
  summary: "System leader capability.",
  instructions: "Coordinate the team.",
  tools: [],
  createdAt: timestamp,
  updatedAt: timestamp
};
const userSkill: Skill = {
  ...systemSkill,
  id: "review-notes",
  owner: "user",
  injection: "none",
  displayName: "Review notes",
  description: "User managed review method."
};
const bootstrap: Bootstrap = {
  providers: [],
  skills: [systemSkill, userSkill],
  architectureTemplates: [],
  employees: [],
  workflows: [],
  sessions: [],
  publications: [],
  projects: [],
  projectBindings: [],
  activity: { invocations: [], instances: [] }
};

describe("Skills system boundary", () => {
  it("separates read-only system capabilities from user-managed capabilities", () => {
    const html = renderToStaticMarkup(<SkillsPage data={bootstrap} refresh={vi.fn()} notify={vi.fn()} />);
    expect(html).toContain("系统能力");
    expect(html).toContain("自定义能力");
    expect(html).toContain("按领队位置注入");
    expect(html).toContain("不接受修订");
    expect(html).toContain("Review notes");
  });
});
