import type { Server } from "node:http";
import type { WorkbenchService } from "../workbench/service.js";
import { startDaemon, type StartDaemonOptions } from "./server.js";

type RecoverableWorkbenchService = Pick<WorkbenchService, "recoverInterruptedActivity">
  & Partial<Pick<WorkbenchService, "recoverDeliveryDispatches" | "recoverDispatchLedgers">>;
type DaemonStarter = (service: WorkbenchService, options?: StartDaemonOptions) => Promise<Server>;

/**
 * Completes durable restart reconciliation before opening the listening socket.
 * Otherwise requests accepted during a slow recovery can be mistaken for work
 * left by the previous process and immediately marked interrupted.
 */
export async function startRecoveredDaemon(
  service: WorkbenchService,
  options: StartDaemonOptions = {},
  starter: DaemonStarter = startDaemon
): Promise<Server> {
  const recoverable = service as RecoverableWorkbenchService;
  await recoverable.recoverInterruptedActivity();
  await recoverable.recoverDeliveryDispatches?.();
  await recoverable.recoverDispatchLedgers?.();
  return starter(service, options);
}
