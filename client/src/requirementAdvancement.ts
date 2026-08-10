import { api, writeBody } from "./api";
import type {
  EntrancePolicyDecision,
  InvocationRecord,
  InvocationSource,
  JsonObject,
  ManagementPolicy,
  Workflow
} from "./types";
import type { RequirementAdvancement, RequirementDetail } from "./dashboard/types";

export interface RequirementAdvancementInput {
  route: "auto";
  tags: string[];
  signals: JsonObject;
  source: InvocationSource;
  message: string;
}

export interface RequirementAdvancementReceipt {
  invocation: InvocationRecord;
  runId: string;
  leaderSessionId?: string;
}

export interface RequirementAdvancementGateway {
  evaluate(policyId: string, input: Omit<RequirementAdvancementInput, "message">): Promise<EntrancePolicyDecision>;
  dispatch(policyId: string, input: RequirementAdvancementInput): Promise<RequirementAdvancementReceipt>;
}

/** Fail-closed launch checks shown before a real Run is created. */
export function requirementAdvancementSafetyGaps(
  decision: EntrancePolicyDecision,
  workflows: Workflow[],
  managementPolicies: ManagementPolicy[]
): string[] {
  const gaps = [...decision.warnings];
  if (!decision.executable) gaps.push("入口策略当前不可执行");
  if (decision.target.kind !== "supervisor-workflow") {
    gaps.push("入口策略没有路由到领队工作流");
    return [...new Set(gaps)];
  }
  const target = decision.target;
  const workflow = workflows.find((candidate) => candidate.id === target.workflowId);
  if (!workflow || workflow.status !== "active") {
    gaps.push("领队工作流不存在或已归档");
    return [...new Set(gaps)];
  }
  if (workflow.architecture !== "supervisor") {
    gaps.push("目标不是 Supervisor 领队工作流");
    return [...new Set(gaps)];
  }
  if (workflow.version !== target.workflowVersion) gaps.push("入口策略固定的是旧版领队工作流，请先刷新入口策略");
  if (workflow.updatePolicy !== "latest") gaps.push("领队工作流没有启用 latest 成员与管理策略同步");
  const managementPolicy = managementPolicies.find((candidate) => candidate.id === workflow.managementPolicy.id);
  if (!managementPolicy || managementPolicy.status !== "active" || managementPolicy.version !== workflow.managementPolicy.version) {
    gaps.push("领队工作流没有绑定当前有效的管理策略");
  } else if (managementPolicy.execution?.isolation !== "worktree") {
    gaps.push("管理策略没有强制 Worktree 隔离");
  }
  const testGate = workflow.flow.gates.find((gate) => gate.requiredCapability === "quality.test");
  if (!testGate || !testGate.required || testGate.mode !== "before-completion" || testGate.validatorId === "none") {
    gaps.push("缺少带真实证据校验的必需 quality.test 交付门禁");
  }
  const auditGate = workflow.flow.gates.find((gate) => gate.requiredCapability === "quality.audit");
  if (!auditGate || !auditGate.required || auditGate.mode !== "before-completion" || auditGate.fallback !== "block") {
    gaps.push("缺少失败关闭的必需 quality.audit 独立 Review 门禁");
  }
  return [...new Set(gaps)];
}

interface EntranceDispatchEnvelope {
  decision: EntrancePolicyDecision;
  dispatch:
    | { kind: "return-to-caller"; invocationCreated: false }
    | { kind: "employee" | "project-role"; result: unknown }
    | { kind: "invocation-started"; receipt: RequirementAdvancementReceipt };
}

function sourceFor(requirement: RequirementDetail, advancement?: RequirementAdvancement): InvocationSource {
  return {
    kind: "workbench",
    label: `需求看板推进 · ${requirement.code}`,
    project: requirement.projectId,
    caller: "requirement-advancement",
    contextId: `requirement:${requirement.id}`,
    taskId: requirement.id,
    ...(advancement ? { idempotencyKey: advancement.idempotencyKey } : {})
  };
}

function requirementMessage(requirement: RequirementDetail): string {
  return [
    "【需求看板推进任务】",
    `需求 ID：${requirement.id}`,
    `需求编号：${requirement.code}`,
    `项目 ID：${requirement.projectId}`,
    `标题：${requirement.title}`,
    `摘要：${requirement.summary}`,
    "",
    "【原始需求】",
    requirement.rawRequirement,
    "",
    "【验收标准】",
    ...requirement.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "请按领队流程规划、委派、实现、测试、独立 Review 并交付可验收证据。",
    "代码修改必须在受管 Worktree 中完成；不得自动合并或推送。",
    "安装依赖、数据迁移、范围扩大或其它不可逆高风险操作前，必须暂停并请求人工决定。"
  ].join("\n");
}

export function buildRequirementAdvancementInput(
  requirement: RequirementDetail,
  advancement?: RequirementAdvancement
): RequirementAdvancementInput {
  return {
    route: "auto",
    tags: ["requirement-advancement", "repository-development"],
    signals: {
      requiredRoleCount: 3,
      requiresDynamicReplanning: true,
      requiresIndependentValidation: true
    },
    source: sourceFor(requirement, advancement),
    message: requirementMessage(requirement)
  };
}

export const requirementAdvancementGateway: RequirementAdvancementGateway = {
  evaluate(policyId, input) {
    return api<EntrancePolicyDecision>(`/api/entrance-policies/${encodeURIComponent(policyId)}/evaluate`, writeBody(input));
  },
  async dispatch(policyId, input) {
    const result = await api<EntranceDispatchEnvelope>(
      `/api/entrance-policies/${encodeURIComponent(policyId)}/dispatch`,
      writeBody(input)
    );
    if (result.dispatch.kind !== "invocation-started") {
      throw new Error(`入口策略返回了 ${result.dispatch.kind}，没有创建可监控的异步 Run`);
    }
    return result.dispatch.receipt;
  }
};
