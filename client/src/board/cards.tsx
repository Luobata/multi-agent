import { RuntimeStatusChip, Stamp } from "../components";
import { REQUIREMENT_EXCEPTION_LABELS } from "../dashboard/types";
import type { Requirement } from "../dashboard/types";

export function exceptionChip(exception: Requirement["exception"]) {
  if (exception === "blocked") return <Stamp status="blocked" label={REQUIREMENT_EXCEPTION_LABELS.blocked} />;
  if (exception === "failed") return <Stamp status="failed" label={REQUIREMENT_EXCEPTION_LABELS.failed} />;
  if (exception === "cancelled") return <RuntimeStatusChip status="cancelled" label={REQUIREMENT_EXCEPTION_LABELS.cancelled} />;
  return null;
}

export function deliveryProgressChip(requirement: Requirement) {
  if (requirement.lane !== "merging" || !requirement.delivery) return null;
  const labels: Record<NonNullable<Requirement["delivery"]>["status"], string> = {
    "queued-for-merge": "等待串行合入",
    retesting: "合入前重新验收",
    merging: "正在写入目标分支",
    merged: "合入完成",
    conflict: "冲突处理中",
    "returned-to-acceptance": "已退回验收"
  };
  const resolution = requirement.delivery.conflictResolution;
  const detail = requirement.delivery.message?.includes("目标仓库存在未提交改动") ? "等待目标仓库洁净"
    : resolution?.status === "resolving" ? "冲突处理中"
    : resolution?.status === "retesting" ? "候选复测中"
      : resolution?.status === "leader-review" ? "领队复验"
        : resolution?.status === "failed" ? (resolution.failureClass === "environment-blocked" ? "候选环境阻塞" : resolution.failureClass === "evidence-incomplete" ? "证据不完整" : resolution.failureClass === "product-failed" ? "产品回归失败" : "冲突处理失败")
          : labels[requirement.delivery.status];
  return <span className="board-evidence-capture" role="status" title={resolution?.message ?? requirement.delivery.message}>{detail}</span>;
}
