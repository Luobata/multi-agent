import type { WorkbenchState } from "../workbench/types.js";
import { knowledgeSelectorMatches } from "./resolver.js";
import type {
  KnowledgeBaseDefinition,
  KnowledgeBaseImpact,
  KnowledgeBaseImpactMatch,
  KnowledgeDanglingAssignment,
  KnowledgeEmployeeImpact,
  KnowledgeImpactSnapshot,
  KnowledgeProfileDefinition,
  KnowledgeProfileImpact,
  KnowledgeProfileImpactMatch,
  KnowledgeProfileRuleImpact,
  KnowledgeProjectRoleImpact
} from "./types.js";

function ruleMatches(profile: KnowledgeProfileDefinition, knowledgeBase: KnowledgeBaseDefinition): KnowledgeProfileRuleImpact[] {
  return profile.rules.flatMap((rule) => {
    const collectionIds = knowledgeBase.collections
      .filter((collection) => knowledgeSelectorMatches(rule.selector, knowledgeBase, collection))
      .map((collection) => collection.id);
    if (collectionIds.length === 0) return [];
    return [{
      ruleId: rule.id,
      activation: rule.activation,
      matchMode: rule.selector.knowledgeBaseIds?.includes(knowledgeBase.id) ? "explicit" as const : "metadata" as const,
      collectionIds
    }];
  });
}

function employeeConsumers(state: WorkbenchState, profileIds: Set<string>): KnowledgeEmployeeImpact[] {
  return Object.values(state.employees)
    .map((record) => record.current)
    .flatMap((employee) => {
      const viaProfileIds = employee.knowledgeProfileIds.filter((profileId) => profileIds.has(profileId));
      return viaProfileIds.length ? [{
        employeeId: employee.id,
        employeeName: employee.identity.displayName,
        employeeStatus: employee.status,
        viaProfileIds
      }] : [];
    })
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

function projectRoleConsumers(state: WorkbenchState, profileIds: Set<string>): KnowledgeProjectRoleImpact[] {
  return Object.values(state.projectBindings)
    .flatMap((record) => {
      const binding = record.current;
      const project = state.projects[binding.projectId]?.current;
      return binding.roles.flatMap((role) => {
        const viaProfileIds = role.knowledgeProfileIds.filter((profileId) => profileIds.has(profileId));
        if (viaProfileIds.length === 0) return [];
        const roleContract = project?.roles.find((candidate) => candidate.id === role.roleId);
        return [{
          projectId: binding.projectId,
          projectName: project?.name ?? binding.projectId,
          roleId: role.roleId,
          roleName: roleContract?.displayName ?? role.roleId,
          employeeId: role.employeeId,
          viaProfileIds
        }];
      });
    })
    .sort((left, right) => `${left.projectName}/${left.roleName}`.localeCompare(`${right.projectName}/${right.roleName}`));
}

function profileImpactMatch(profile: KnowledgeProfileDefinition, rules: KnowledgeProfileRuleImpact[]): KnowledgeProfileImpactMatch {
  return {
    profileId: profile.id,
    profileName: profile.displayName,
    profileVersion: profile.version,
    profileStatus: profile.status,
    rules
  };
}

function baseImpactMatch(knowledgeBase: KnowledgeBaseDefinition, rules: KnowledgeProfileRuleImpact[]): KnowledgeBaseImpactMatch {
  return {
    knowledgeBaseId: knowledgeBase.id,
    knowledgeBaseName: knowledgeBase.displayName,
    knowledgeBaseStatus: knowledgeBase.status,
    publishedRevision: knowledgeBase.publishedRevision,
    rules
  };
}

function danglingAssignments(state: WorkbenchState): KnowledgeDanglingAssignment[] {
  const known = new Set(Object.keys(state.knowledgeProfiles));
  const missing: KnowledgeDanglingAssignment[] = [];
  for (const record of Object.values(state.employees)) {
    for (const profileId of record.current.knowledgeProfileIds) {
      if (!known.has(profileId)) missing.push({ profileId, source: "employee", employeeId: record.current.id });
    }
  }
  for (const record of Object.values(state.projectBindings)) {
    for (const role of record.current.roles) {
      for (const profileId of role.knowledgeProfileIds) {
        if (!known.has(profileId)) missing.push({
          profileId,
          source: "project-role",
          employeeId: role.employeeId,
          projectId: record.current.projectId,
          roleId: role.roleId
        });
      }
    }
  }
  return missing.sort((left, right) => `${left.profileId}/${left.source}/${left.employeeId}`.localeCompare(`${right.profileId}/${right.source}/${right.employeeId}`));
}

export function buildKnowledgeImpactSnapshot(
  state: WorkbenchState,
  generatedAt = new Date().toISOString()
): KnowledgeImpactSnapshot {
  const knowledgeBases = Object.values(state.knowledgeBases).map((record) => record.current);
  const profiles = Object.values(state.knowledgeProfiles).map((record) => record.current);

  const baseImpacts: KnowledgeBaseImpact[] = knowledgeBases.map((knowledgeBase) => {
    const profileMatches = profiles.flatMap((profile) => {
      const rules = ruleMatches(profile, knowledgeBase);
      return rules.length ? [profileImpactMatch(profile, rules)] : [];
    }).sort((left, right) => left.profileName.localeCompare(right.profileName));
    const profileIds = new Set(profileMatches.map((profile) => profile.profileId));
    return {
      knowledgeBaseId: knowledgeBase.id,
      profileMatches,
      employees: employeeConsumers(state, profileIds),
      projectRoles: projectRoleConsumers(state, profileIds)
    };
  }).sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));

  const profileImpacts: KnowledgeProfileImpact[] = profiles.map((profile) => {
    const matchedKnowledgeBases = knowledgeBases.flatMap((knowledgeBase) => {
      const rules = ruleMatches(profile, knowledgeBase);
      return rules.length ? [baseImpactMatch(knowledgeBase, rules)] : [];
    }).sort((left, right) => left.knowledgeBaseName.localeCompare(right.knowledgeBaseName));
    const profileIds = new Set([profile.id]);
    return {
      profileId: profile.id,
      knowledgeBases: matchedKnowledgeBases,
      employees: employeeConsumers(state, profileIds),
      projectRoles: projectRoleConsumers(state, profileIds)
    };
  }).sort((left, right) => left.profileId.localeCompare(right.profileId));

  return {
    knowledgeBases: baseImpacts,
    profiles: profileImpacts,
    danglingAssignments: danglingAssignments(state),
    generatedAt
  };
}
