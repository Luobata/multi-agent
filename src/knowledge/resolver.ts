import type { EmployeeDefinition, WorkbenchState } from "../workbench/types.js";
import type {
  KnowledgeActivation,
  KnowledgeBaseDefinition,
  KnowledgeCandidateCollection,
  KnowledgeCandidateMatch,
  KnowledgeClassification,
  KnowledgeCollectionDefinition,
  KnowledgeExclusion,
  KnowledgeProfileConditions,
  KnowledgeProfileRule,
  KnowledgeProfileSelector,
  KnowledgeResolutionContext,
  KnowledgeScope
} from "./types.js";

const classificationRank: Record<KnowledgeClassification, number> = {
  internal: 0,
  confidential: 1,
  restricted: 2
};

const activationRank: Record<KnowledgeActivation, number> = {
  "on-demand": 0,
  conditional: 1,
  core: 2
};

function includesOrAll(values: string[] | undefined, value: string | undefined): boolean {
  if (!values?.length) return true;
  return value !== undefined && values.includes(value);
}

function intersects(left: string[] | undefined, right: string[]): boolean {
  if (!left?.length) return true;
  const values = new Set(right);
  return left.some((value) => values.has(value));
}

export function knowledgeSelectorMatches(
  selector: KnowledgeProfileSelector,
  knowledgeBase: KnowledgeBaseDefinition,
  collection: KnowledgeCollectionDefinition
): boolean {
  if (!includesOrAll(selector.knowledgeBaseIds, knowledgeBase.id)) return false;
  if (!includesOrAll(selector.domains, knowledgeBase.domain)) return false;
  if (!includesOrAll(selector.products, knowledgeBase.product)) return false;
  if (!includesOrAll(selector.projectIds, knowledgeBase.projectId)) return false;
  if (!includesOrAll(selector.collectionIds, collection.id)) return false;
  if (!includesOrAll(selector.authorities, collection.authority)) return false;
  if (selector.maxClassification && classificationRank[knowledgeBase.classification] > classificationRank[selector.maxClassification]) {
    return false;
  }
  return true;
}

function conditionsMatch(conditions: KnowledgeProfileConditions | undefined, context: KnowledgeResolutionContext): boolean {
  if (!conditions) return true;
  if (!includesOrAll(conditions.projectIds, context.projectId)) return false;
  if (!includesOrAll(conditions.projectRoleIds, context.projectRoleId)) return false;
  if (!intersects(conditions.taskTags, context.taskTags)) return false;
  if (conditions.requestTerms?.length) {
    const request = context.request.normalize("NFKC").toLowerCase();
    if (!conditions.requestTerms.some((term) => request.includes(term.normalize("NFKC").toLowerCase()))) return false;
  }
  return true;
}

function matchReason(rule: KnowledgeProfileRule, knowledgeBase: KnowledgeBaseDefinition, collection: KnowledgeCollectionDefinition): string {
  const parts = [`profile rule ${rule.id}`, rule.activation, `domain ${knowledgeBase.domain}`, `collection ${collection.id}`];
  return parts.join(" · ");
}

function candidateKey(knowledgeBaseId: string, collectionId: string): string {
  return `${knowledgeBaseId}/${collectionId}`;
}

function exclusionKey(exclusion: KnowledgeExclusion): string {
  return [exclusion.profileId, exclusion.knowledgeBaseId, exclusion.collectionId, exclusion.reason].join("|");
}

export function resolveKnowledgeScope(
  state: WorkbenchState,
  employee: EmployeeDefinition,
  context: KnowledgeResolutionContext
): KnowledgeScope {
  const profileVersions: Record<string, number> = {};
  const candidates = new Map<string, KnowledgeCandidateCollection>();
  const exclusions = new Map<string, KnowledgeExclusion>();
  const addExclusion = (exclusion: KnowledgeExclusion) => exclusions.set(exclusionKey(exclusion), exclusion);

  for (const profileId of [...new Set(employee.knowledgeProfileIds)]) {
    const profile = state.knowledgeProfiles[profileId]?.current;
    if (!profile) {
      addExclusion({ profileId, reason: "knowledge profile is missing" });
      continue;
    }
    profileVersions[profile.id] = profile.version;
    if (profile.status !== "active") {
      addExclusion({ profileId, reason: "knowledge profile is archived" });
      continue;
    }

    for (const rule of profile.rules) {
      if (!conditionsMatch(rule.conditions, context)) {
        addExclusion({ profileId, reason: `profile rule ${rule.id} conditions did not match this invocation` });
        continue;
      }
      for (const record of Object.values(state.knowledgeBases)) {
        const knowledgeBase = record.current;
        for (const collection of knowledgeBase.collections) {
          if (!knowledgeSelectorMatches(rule.selector, knowledgeBase, collection)) continue;
          if (knowledgeBase.status !== "active") {
            addExclusion({
              profileId,
              knowledgeBaseId: knowledgeBase.id,
              collectionId: collection.id,
              reason: "knowledge base is archived"
            });
            continue;
          }
          if (!knowledgeBase.publishedRevision) {
            addExclusion({
              profileId,
              knowledgeBaseId: knowledgeBase.id,
              collectionId: collection.id,
              reason: "knowledge base has no published revision"
            });
            continue;
          }
          if (knowledgeBase.qualityStatus === "stale") {
            addExclusion({
              profileId,
              knowledgeBaseId: knowledgeBase.id,
              collectionId: collection.id,
              reason: "knowledge base is marked stale"
            });
            continue;
          }
          const key = candidateKey(knowledgeBase.id, collection.id);
          const match: KnowledgeCandidateMatch = {
            profileId: profile.id,
            profileVersion: profile.version,
            ruleId: rule.id,
            activation: rule.activation,
            priority: rule.priority,
            required: rule.required,
            budget: rule.budget,
            reason: matchReason(rule, knowledgeBase, collection)
          };
          const existing = candidates.get(key);
          if (existing) {
            existing.matches.push(match);
            existing.matches.sort((left, right) =>
              activationRank[right.activation] - activationRank[left.activation] || right.priority - left.priority
            );
          } else {
            candidates.set(key, {
              knowledgeBaseId: knowledgeBase.id,
              knowledgeBaseVersion: knowledgeBase.version,
              revision: knowledgeBase.publishedRevision,
              knowledgeBaseName: knowledgeBase.displayName,
              domain: knowledgeBase.domain,
              product: knowledgeBase.product,
              projectId: knowledgeBase.projectId,
              classification: knowledgeBase.classification,
              collection,
              matches: [match]
            });
          }
        }
      }
    }
  }

  return {
    employeeId: employee.id,
    employeeVersion: employee.version,
    context,
    profileVersions,
    eligibleCollections: [...candidates.values()].sort((left, right) =>
      (right.matches[0]?.priority ?? 0) - (left.matches[0]?.priority ?? 0)
      || left.knowledgeBaseId.localeCompare(right.knowledgeBaseId)
      || left.collection.id.localeCompare(right.collection.id)
    ),
    exclusions: [...exclusions.values()]
  };
}
