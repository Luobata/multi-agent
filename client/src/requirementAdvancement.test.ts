import { describe, expect, it } from "vitest";
import { buildRequirementAdvancementInput, parseExplicitDeliveryIntent } from "./requirementAdvancement";
import type { RequirementDetail } from "./dashboard/types";

describe("explicit leader delivery trigger", () => {
  it("accepts only the exact generic command or a project-configured leader target", () => {
    expect(parseExplicitDeliveryIntent("交付领队", ["小米汪"])).toEqual({ command: "交付领队", target: "领队" });
    expect(parseExplicitDeliveryIntent(" 交付小米汪 ", ["小米汪"])).toEqual({ command: "交付小米汪", target: "小米汪" });
    for (const ordinary of ["请交付领队", "交付一下", "交付 小米汪", "交付小米汪。", "开始一项工作", "请团队协作交付"]) {
      expect(parseExplicitDeliveryIntent(ordinary, ["小米汪"]), ordinary).toBeUndefined();
    }
  });

  it("emits the leader signal only after an explicit command was validated", () => {
    const requirement = {
      id: "req-1", code: "REQ-1", projectId: "project-1", title: "任务", summary: "普通描述",
      rawRequirement: "需要多人协作，但没有显式交付", acceptanceCriteria: ["完成"]
    } as RequirementDetail;
    expect(buildRequirementAdvancementInput(requirement).signals).toEqual({});
    expect(buildRequirementAdvancementInput(requirement, undefined, undefined, {
      command: "交付领队", target: "领队"
    }).signals).toEqual({
      explicitLeaderDelivery: true,
      deliveryTarget: "领队",
      deliveryCommand: "交付领队"
    });
  });
});
