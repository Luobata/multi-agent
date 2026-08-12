import { WorkbenchService } from "/Users/bytedance/luobata/multi-agent/.multi-agent/worktrees/run-2026-08-10T14-16-02-469Z-37a4870a/src/workbench/service.ts";
import { startDaemon } from "/Users/bytedance/luobata/multi-agent/.multi-agent/worktrees/run-2026-08-10T14-16-02-469Z-37a4870a/src/daemon/server.ts";
import path from "node:path";

const providers = new Map([["scripted-supervisor", {
  id: "scripted-supervisor",
  validate: () => [],
  invoke: async (invocation: any) => {
    const role = (invocation.templateContext.role as { id: string }).id;
    const round = Number((invocation.templateContext.node as { with?: { __supervisorRound?: number } }).with?.__supervisorRound ?? 0);
    if (role === "supervisor" && round === 1) {
      return { stdout: JSON.stringify({ action: "delegate", summary: "收集专家证据，交由研究员完成任务的补充调查与验证。", assignments: [{ roleId: "researcher", task: "研究提供的请求并给出完整证据。" }] }), stderr: "", durationMs: 1 };
    }
    if (role === "supervisor") {
      return { stdout: JSON.stringify({ action: "finish", summary: "证据已被接受，团队完成本轮交付。", result: { answer: "complete" } }), stderr: "", durationMs: 1 };
    }
    return { stdout: JSON.stringify({ message: "研究完成，已产出完整证据。" }), stderr: "", durationMs: 1 };
  }
}]]);

const dataRoot = "/tmp/seed-workbench-data";
const service = await WorkbenchService.open({ dataRoot, providers } as any);
await service.putProvider("scripted-provider", { adapter: "scripted-supervisor", model: "supervisor-test-model", outputProtocol: "json" } as any);
const manager = await service.createEmployee({ id: "team-manager", identity: { displayName: "领队经理", background: "协调专家。", responsibilities: ["Delegate", "Synthesize"] }, providerId: "scripted-provider" } as any);
const researcher = await service.createEmployee({ id: "team-researcher", identity: { displayName: "研究员", background: "收集证据。", responsibilities: ["Research"] }, providerId: "scripted-provider" } as any);
const policy = await service.createManagementPolicy({ id: "evidence-manager", displayName: "Evidence Manager", description: "Delegate research before synthesis.", allowedRoleIds: ["researcher"], instructions: "Delegate evidence collection.", limits: { maxRounds: 4, maxDelegations: 4, maxParallelDelegations: 2, maxDurationMs: 60000 } } as any);
await service.createWorkflow({ id: "supervised-research", architecture: "supervisor", description: "A dynamically managed research team.", supervisor: { employeeId: manager.id }, managementPolicy: { id: policy.id }, members: [{ roleId: "researcher", description: "Collect evidence.", employeeId: researcher.id }] } as any);
const longMessage = "这是一段非常长的任务请求全文，用来验证详情页不会截断展示。".repeat(6) + " 结束标记END";
const result = await service.runWorkbenchWorkflow("supervised-research", { message: longMessage, taskDescription: "这是完整的任务描述字段，专门用于验证详情页任务描述完整展示，不以省略号结尾，包含足够多的字符使其在卡片摘要中会被截断显示。" }, { kind: "workbench", project: "local-agent-workbench", taskId: "req-local-15" } as any);
console.log("RUN_ID=" + (result as any).runId ?? "");
console.log("RESULT_KEYS=" + Object.keys(result as any).join(","));

const staticDir = path.resolve(process.cwd(), "dist", "client");
await startDaemon(service, { host: "127.0.0.1", port: 4319, staticDir });
console.log("DAEMON_UP http://127.0.0.1:4319");
