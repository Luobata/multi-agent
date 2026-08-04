import { createHash } from "node:crypto";
import type { JsonValue } from "../core/types.js";
import type {
  ConfigurationProposal,
  ConfigurationReviewDecision,
  ConfigurationReviewProgress
} from "./types.js";

export function configurationPlanHash(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function latestConfigurationDecisions(
  proposal: Pick<ConfigurationProposal, "decisions">
): Map<string, ConfigurationReviewDecision> {
  const latest = new Map<string, ConfigurationReviewDecision>();
  for (const decision of proposal.decisions) latest.set(decision.reviewItemId, decision);
  return latest;
}

export function configurationReviewProgress(
  reviewItemIds: string[],
  decisions: ConfigurationReviewDecision[]
): ConfigurationReviewProgress {
  const latest = latestConfigurationDecisions({ decisions });
  let accepted = 0;
  let rejected = 0;
  for (const id of reviewItemIds) {
    const decision = latest.get(id)?.decision;
    if (decision === "accepted") accepted += 1;
    if (decision === "rejected") rejected += 1;
  }
  const reviewed = accepted + rejected;
  return {
    total: reviewItemIds.length,
    reviewed,
    accepted,
    rejected,
    pending: reviewItemIds.length - reviewed
  };
}

export function configurationReviewHash(
  proposal: Pick<ConfigurationProposal, "planHash" | "reviewItems" | "decisions">
): string {
  const latest = latestConfigurationDecisions(proposal);
  return configurationPlanHash({
    planHash: proposal.planHash,
    selections: proposal.reviewItems.map((item) => {
      const decision = latest.get(item.id);
      return {
        reviewItemId: item.id,
        decisionId: decision?.id ?? null,
        decision: decision?.decision ?? null,
        decisionPlanHash: decision?.planHash ?? null
      };
    })
  });
}
