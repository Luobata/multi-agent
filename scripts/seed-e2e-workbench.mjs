import { WorkbenchService } from "../dist/workbench/service.js";

const dataRoot = process.argv[2];
if (!dataRoot) throw new Error("usage: node scripts/seed-e2e-workbench.mjs <data-root>");

let supervisorTurn = 0;
const providers = new Map([["e2e-supervisor", {
  id: "e2e-supervisor",
  validate: () => [],
  describe: () => ({ version: 1, capabilities: [] }),
  preflight: async () => [],
  invoke: async (invocation) => {
    const role = invocation.templateContext.role?.id;
    if (role === "supervisor") {
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return {
          stdout: JSON.stringify({
            action: "delegate",
            summary: "Prepare a bounded E2E delivery.",
            assignments: [{
              roleId: "builder",
              task: "Produce the deterministic E2E delivery evidence.",
              workKind: "other",
              changeSet: "e2e-fixture"
            }]
          }),
          stderr: "",
          durationMs: 1
        };
      }
      return {
        stdout: JSON.stringify({
          action: "finish",
          summary: "E2E fixture delivered with durable evidence.",
          result: { delivered: true, fixture: "workbench-web" }
        }),
        stderr: "",
        durationMs: 1
      };
    }
    return {
      stdout: JSON.stringify({ message: "Deterministic worker evidence is ready." }),
      stderr: "",
      durationMs: 1
    };
  }
}]]);

const service = await WorkbenchService.open({ dataRoot, providers });
await service.putProvider("e2e-provider", {
  adapter: "e2e-supervisor",
  model: "deterministic-e2e",
  outputProtocol: "json"
});
await service.createEmployee({
  id: "e2e-leader",
  identity: {
    displayName: "E2E 领队",
    background: "Coordinates deterministic browser fixtures.",
    responsibilities: ["Coordinate the fixture"]
  },
  providerId: "e2e-provider"
});
await service.createEmployee({
  id: "e2e-builder",
  identity: {
    displayName: "E2E 执行者",
    background: "Produces deterministic browser evidence.",
    responsibilities: ["Produce fixture evidence"]
  },
  providerId: "e2e-provider"
});
await service.createManagementPolicy({
  id: "e2e-policy",
  allowedRoleIds: ["builder"],
  instructions: "Delegate one bounded fixture task, then finish.",
  limits: { maxRounds: 3, maxDelegations: 2, maxParallelDelegations: 1, maxDurationMs: 30_000 }
});
await service.createWorkflow({
  id: "e2e-supervisor-workflow",
  architecture: "supervisor",
  supervisor: { employeeId: "e2e-leader" },
  managementPolicy: { id: "e2e-policy" },
  members: [{ roleId: "builder", employeeId: "e2e-builder" }]
});
await service.createPublication({
  id: "e2e-supervisor-publication",
  name: "E2E Supervisor Fixture",
  target: { kind: "workflow", id: "e2e-supervisor-workflow" }
});
const result = await service.invokePublication("e2e-supervisor-publication", {
  message: "Create a real Run for the browser receipt journey."
});
if (!("run" in result)) throw new Error("expected a Workflow Publication result");
process.stdout.write(`${JSON.stringify({ runId: result.run.id, status: result.run.status })}\n`);
