import type { JsonObject } from "../core/types.js";

export interface ArchitectureTemplateSlot {
  id: string;
  label: string;
  description: string;
}

export interface ArchitectureTemplateDefinition {
  id: string;
  displayName: string;
  pattern: string;
  summary: string;
  bestFor: string;
  slots: ArchitectureTemplateSlot[];
  maxConcurrency: number;
  failFast: boolean;
}

export interface InstantiatedArchitectureTemplate {
  patternId: string;
  description: string;
  nodes: Array<{
    id: string;
    employeeId: string;
    needs: string[];
    with: JsonObject;
  }>;
  maxConcurrency: number;
  failFast: boolean;
}

const templates: ArchitectureTemplateDefinition[] = [
  {
    id: "sequential-pipeline",
    displayName: "顺序流水线",
    pattern: "Sequential Pipeline",
    summary: "上一步的结构化结果逐级交给下一位员工。",
    bestFor: "需求澄清 → 实现 → 验收等边界清晰的交付链路。",
    slots: [
      { id: "discover", label: "定义", description: "澄清目标与验收口径" },
      { id: "execute", label: "执行", description: "完成主体产出" },
      { id: "verify", label: "验收", description: "核对证据并收口" }
    ],
    maxConcurrency: 1,
    failFast: true
  },
  {
    id: "parallel-fanout-gather",
    displayName: "并行分发 / 汇总",
    pattern: "Parallel Fan-out / Gather",
    summary: "两路独立产出并行执行，最后由一位员工统一汇总。",
    bestFor: "需要不同专业视角、又希望缩短等待时间的分析任务。",
    slots: [
      { id: "track-a", label: "并行 A", description: "独立处理第一条任务线" },
      { id: "track-b", label: "并行 B", description: "独立处理第二条任务线" },
      { id: "synthesize", label: "汇总", description: "合并冲突、形成最终结论" }
    ],
    maxConcurrency: 2,
    failFast: false
  },
  {
    id: "review-council",
    displayName: "评审委员会",
    pattern: "Debate / Judge",
    summary: "主笔先产出，多位评审并行审阅，再由裁决者收口。",
    bestFor: "高风险方案、设计评审、需要保留分歧与裁决证据的决策。",
    slots: [
      { id: "produce", label: "主笔", description: "提出完整候选方案" },
      { id: "review-product", label: "评审 A", description: "从目标与用户价值审阅" },
      { id: "review-delivery", label: "评审 B", description: "从可行性与交付风险审阅" },
      { id: "decide", label: "裁决", description: "综合证据并给出明确结论" }
    ],
    maxConcurrency: 2,
    failFast: false
  },
  {
    id: "plan-execute-synthesize",
    displayName: "计划 / 执行 / 综合",
    pattern: "Plan–Execute–Synthesize",
    summary: "先建立共同计划，再并行执行，最后统一整合。",
    bestFor: "范围较大、可以拆成多条执行线的产品与工程任务。",
    slots: [
      { id: "plan", label: "规划", description: "拆解任务、定义接口与完成标准" },
      { id: "execute-a", label: "执行 A", description: "完成第一条工作流" },
      { id: "execute-b", label: "执行 B", description: "完成第二条工作流" },
      { id: "synthesize", label: "综合", description: "合并产出并做最终校验" }
    ],
    maxConcurrency: 2,
    failFast: false
  }
];

export function listArchitectureTemplates(): ArchitectureTemplateDefinition[] {
  return structuredClone(templates);
}

export function getArchitectureTemplate(id: string): ArchitectureTemplateDefinition {
  const template = templates.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`architecture template not found: ${id}`);
  return structuredClone(template);
}

export function instantiateArchitectureTemplate(
  id: string,
  employeeIds: string[]
): InstantiatedArchitectureTemplate {
  const template = getArchitectureTemplate(id);
  if (employeeIds.length !== template.slots.length) {
    throw new Error(`architecture template ${id} requires ${template.slots.length} employee assignments`);
  }
  if (employeeIds.some((employeeId) => !employeeId.trim())) {
    throw new Error(`architecture template ${id} requires every slot to have an employee`);
  }

  const node = (slotId: string) => ({
    id: slotId,
    employeeId: employeeIds[template.slots.findIndex((slot) => slot.id === slotId)]!,
    needs: [] as string[],
    with: {} as JsonObject
  });

  let nodes: InstantiatedArchitectureTemplate["nodes"];
  switch (id) {
    case "sequential-pipeline":
      nodes = [
        node("discover"),
        { ...node("execute"), needs: ["discover"] },
        { ...node("verify"), needs: ["execute"] }
      ];
      break;
    case "parallel-fanout-gather":
      nodes = [node("track-a"), node("track-b"), { ...node("synthesize"), needs: ["track-a", "track-b"] }];
      break;
    case "review-council":
      nodes = [
        node("produce"),
        { ...node("review-product"), needs: ["produce"] },
        { ...node("review-delivery"), needs: ["produce"] },
        { ...node("decide"), needs: ["review-product", "review-delivery"] }
      ];
      break;
    case "plan-execute-synthesize":
      nodes = [
        node("plan"),
        { ...node("execute-a"), needs: ["plan"] },
        { ...node("execute-b"), needs: ["plan"] },
        { ...node("synthesize"), needs: ["execute-a", "execute-b"] }
      ];
      break;
    default:
      throw new Error(`architecture template not implemented: ${id}`);
  }

  return {
    patternId: template.id,
    description: `${template.displayName}：${template.summary}`,
    nodes,
    maxConcurrency: template.maxConcurrency,
    failFast: template.failFast
  };
}
