import type { Skill } from "./types";

export type EmployeeSkillManagerMode = "add" | "manage";

interface EmployeeSkillChoiceOptions {
  mode: EmployeeSkillManagerMode;
  initialBoundIds: string[];
  selectedIds: string[];
  search: string;
}

export function filterEmployeeSkillChoices(
  skills: Skill[],
  options: EmployeeSkillChoiceOptions
): Skill[] {
  const initialBoundIds = new Set(options.initialBoundIds);
  const selectedIds = new Set(options.selectedIds);
  const query = options.search.trim().toLowerCase();

  return skills.filter((skill) => {
    if (options.mode === "add") {
      if (skill.status !== "active" || initialBoundIds.has(skill.id)) return false;
    } else if (skill.status !== "active" && !selectedIds.has(skill.id)) {
      return false;
    }

    return !query || `${skill.id} ${skill.displayName} ${skill.description}`.toLowerCase().includes(query);
  });
}

export function countAddedSkillBindings(selectedIds: string[], initialBoundIds: string[]): number {
  const initial = new Set(initialBoundIds);
  return selectedIds.filter((id) => !initial.has(id)).length;
}
