import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, stat, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { JsonValue } from "../core/types.js";
import type { WorkbenchState } from "./types.js";

export const BUNDLE_SCHEMA_VERSION = 1 as const;
export type BundleMode = "employee" | "project" | "workflow" | "publication" | "run-evidence";
export type BundleConflictMode = "skip" | "replace";

export interface PortableBundleRecord { mode: BundleMode; id: string; version?: number; value: JsonValue }
export interface PortableBundle {
  schemaVersion: 1;
  kind: "local-agent-workbench-bundle";
  mode: BundleMode[];
  exportedAt: string;
  source: { product: "local-agent-workbench"; schemaVersion: number };
  records: PortableBundleRecord[];
  evidenceRefs: string[];
  checksums: { records: string };
}
export interface BundleDiffItem {
  mode: BundleMode; id: string; action: "create" | "skip" | "replace";
  sensitive: boolean; sensitiveFields: string[];
}
export interface BundlePreview { valid: boolean; errors: Array<{ path: string; message: string }>; diff: BundleDiffItem[]; confirmationToken?: string }

const SECRET_KEY = /(?:secret|token|password|credential|api[-_]?key|rawenv|raw_env)/i;
const SENSITIVE_KEY = /(?:providerId|permissions|outputSchema|targetVersion|profile)/i;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function redacted(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redacted);
  if (!value || typeof value !== "object") return value as JsonValue;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => SECRET_KEY.test(key) ? [] : [[key, redacted(child)]])) as JsonValue;
}

function restorableLocalState(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(restorableLocalState);
  if (!value || typeof value !== "object") return value as JsonValue;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (!SECRET_KEY.test(key)) return [[key, restorableLocalState(child)]];
    if (typeof child === "string" && /^\$ENV:[A-Z_][A-Z0-9_]*$/.test(child)) return [[key, child]];
    if (child && typeof child === "object") return [[key, restorableLocalState(child)]];
    return [];
  })) as JsonValue;
}

function sensitivePaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => sensitivePaths(child, `${prefix}/${index}`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const current = `${prefix}/${key}`;
    return [...(SENSITIVE_KEY.test(key) ? [current] : []), ...sensitivePaths(child, current)];
  });
}

export function exportBundle(state: WorkbenchState, modes: BundleMode[], now = new Date()): PortableBundle {
  const selected = [...new Set(modes)];
  const records: PortableBundleRecord[] = [];
  if (selected.includes("employee")) for (const [id, value] of Object.entries(state.employees)) records.push({ mode: "employee", id, version: value.current.version, value: redacted(value) });
  if (selected.includes("project")) for (const [id, value] of Object.entries(state.projects)) records.push({ mode: "project", id, version: value.current.version, value: redacted({ project: value, binding: state.projectBindings[id] }) });
  if (selected.includes("workflow")) for (const [id, value] of Object.entries(state.workflows)) records.push({ mode: "workflow", id, version: value.current.version, value: redacted(value) });
  if (selected.includes("publication")) for (const [id, value] of Object.entries(state.publications)) records.push({ mode: "publication", id, version: value.version, value: redacted(value) });
  if (selected.includes("run-evidence")) for (const [id, value] of Object.entries(state.invocations)) records.push({ mode: "run-evidence", id, value: redacted(value) });
  records.sort((a, b) => `${a.mode}:${a.id}`.localeCompare(`${b.mode}:${b.id}`));
  return { schemaVersion: 1, kind: "local-agent-workbench-bundle", mode: selected, exportedAt: now.toISOString(), source: { product: "local-agent-workbench", schemaVersion: state.schemaVersion }, records, evidenceRefs: records.filter(r => r.mode === "run-evidence").map(r => `#runs/${encodeURIComponent(String((r.value as { runId?: string }).runId ?? r.id))}?view=receipt`), checksums: { records: digest(records) } };
}

export function previewBundle(state: WorkbenchState, input: unknown, conflict: BundleConflictMode = "skip"): BundlePreview {
  const errors: BundlePreview["errors"] = [];
  const bundle = input as Partial<PortableBundle>;
  if (!bundle || typeof bundle !== "object") errors.push({ path: "", message: "bundle must be an object" });
  if (bundle.schemaVersion !== 1) errors.push({ path: "/schemaVersion", message: "unsupported schemaVersion" });
  if (bundle.kind !== "local-agent-workbench-bundle") errors.push({ path: "/kind", message: "invalid bundle kind" });
  if (!Array.isArray(bundle.records)) errors.push({ path: "/records", message: "records must be an array" });
  else if (bundle.checksums?.records !== digest(bundle.records)) errors.push({ path: "/checksums/records", message: "records checksum mismatch" });
  const diff = (Array.isArray(bundle.records) ? bundle.records : []).flatMap((record, index): BundleDiffItem[] => {
    if (!record || typeof record !== "object" || !["employee", "project", "workflow", "publication", "run-evidence"].includes(record.mode) || typeof record.id !== "string" || !("value" in record)) {
      errors.push({ path: `/records/${index}`, message: "invalid record" }); return [];
    }
    const existing = record.mode === "employee" ? state.employees[record.id] : record.mode === "project" ? state.projects[record.id] : record.mode === "workflow" ? state.workflows[record.id] : record.mode === "publication" ? state.publications[record.id] : state.invocations[record.id];
    const paths = sensitivePaths(record.value);
    return [{ mode: record.mode, id: record.id, action: existing ? conflict : "create", sensitive: paths.length > 0, sensitiveFields: paths }];
  });
  const valid = errors.length === 0;
  return { valid, errors, diff, ...(valid && diff.some(item => item.action === "replace" || item.sensitive) ? { confirmationToken: confirmationFor(bundle as PortableBundle, conflict) } : {}) };
}

export const confirmationFor = (bundle: PortableBundle, conflict: BundleConflictMode) => `APPLY-${digest([bundle.checksums.records, conflict]).slice(0, 12).toUpperCase()}`;

export function applyBundleToState(state: WorkbenchState, bundle: PortableBundle, conflict: BundleConflictMode, confirmation?: string): { created: number; replaced: number; skipped: number } {
  const preview = previewBundle(state, bundle, conflict);
  if (!preview.valid) throw new Error(preview.errors.map(e => `${e.path}: ${e.message}`).join("; "));
  if (preview.confirmationToken && confirmation !== preview.confirmationToken) throw new Error(`confirmation token required: ${preview.confirmationToken}`);
  let created = 0, replaced = 0, skipped = 0;
  bundle.records.forEach((record, index) => {
    const item = preview.diff[index]!;
    if (item.action === "skip") { skipped++; return; }
    if (item.action === "create") created++; else replaced++;
    if (record.mode === "employee") state.employees[record.id] = structuredClone(record.value) as unknown as WorkbenchState["employees"][string];
    if (record.mode === "workflow") state.workflows[record.id] = structuredClone(record.value) as unknown as WorkbenchState["workflows"][string];
    if (record.mode === "publication") state.publications[record.id] = structuredClone(record.value) as unknown as WorkbenchState["publications"][string];
    if (record.mode === "run-evidence") state.invocations[record.id] = structuredClone(record.value) as unknown as WorkbenchState["invocations"][string];
    if (record.mode === "project") { const value = record.value as unknown as { project: WorkbenchState["projects"][string]; binding?: WorkbenchState["projectBindings"][string] }; state.projects[record.id] = structuredClone(value.project); if (value.binding) state.projectBindings[record.id] = structuredClone(value.binding); }
  });
  return { created, replaced, skipped };
}

export type DoctorStatus = "ready" | "warning" | "blocked" | "skipped";
export interface DoctorCheck { id: string; status: DoctorStatus; code: string; message: string; remediation?: string; evidence: JsonValue }
export interface DoctorReport { overall: "ready" | "partial" | "blocked"; generatedAt: string; staleAt: string; checks: DoctorCheck[] }

export async function doctorReport(dataRoot: string, state: WorkbenchState): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const major = Number(process.versions.node.split(".")[0]);
  add({ id: "node", status: major >= 22 ? "ready" : "blocked", code: major >= 22 ? "NODE_OK" : "NODE_UNSUPPORTED", message: `Node ${process.versions.node}`, remediation: major < 22 ? "Install Node.js 22 or newer." : undefined, evidence: { version: process.versions.node } });
  try { add({ id: "git", status: "ready", code: "GIT_OK", message: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(), evidence: { available: true } }); } catch { add({ id: "git", status: "blocked", code: "GIT_MISSING", message: "Git is unavailable", remediation: "Install Git and ensure it is on PATH.", evidence: { available: false } }); }
  try { await access(dataRoot, constants.R_OK | constants.W_OK); const disk = await statfs(dataRoot); add({ id: "data-dir", status: "ready", code: "DATA_DIR_OK", message: "Data directory is readable and writable", evidence: { path: dataRoot, freeBytes: disk.bavail * disk.bsize } }); } catch (error) { add({ id: "data-dir", status: "blocked", code: "DATA_DIR_UNAVAILABLE", message: String(error), remediation: "Fix data directory permissions or choose another data root.", evidence: { path: dataRoot } }); }
  const providers = Object.entries(state.providers);
  add({ id: "providers", status: providers.length ? "ready" : "warning", code: providers.length ? "PROVIDERS_DEFINED" : "PROVIDERS_EMPTY", message: `${providers.length} provider definition(s)`, remediation: providers.length ? undefined : "Configure at least one provider before running workflows.", evidence: { ids: providers.map(([id]) => id) } });
  const brokenBindings = Object.values(state.projectBindings).filter(binding => binding.current.roles.some(role => !state.employees[role.employeeId]));
  add({ id: "bindings", status: brokenBindings.length ? "blocked" : "ready", code: brokenBindings.length ? "BINDING_EMPLOYEE_MISSING" : "BINDINGS_OK", message: brokenBindings.length ? `${brokenBindings.length} project binding(s) reference missing employees` : "Project bindings resolve", remediation: brokenBindings.length ? "Refresh or repair the listed project bindings." : undefined, evidence: { projectIds: brokenBindings.map(v => v.current.projectId) } });
  add({ id: "daemon", status: "ready", code: "DAEMON_LOOPBACK", message: "Daemon listener is configured by the current process", evidence: { host: process.env.MULTI_AGENT_HOST ?? "127.0.0.1", port: Number(process.env.MULTI_AGENT_PORT ?? 4317) } });
  add({ id: "provider-preflight", status: providers.length ? "warning" : "skipped", code: providers.length ? "PREFLIGHT_RUNTIME_REQUIRED" : "PREFLIGHT_NO_PROVIDERS", message: providers.length ? "Strong provider preflight requires invoking each configured adapter" : "No provider adapters to preflight", remediation: providers.length ? "Run provider preflight before starting a workflow." : "Configure a provider first.", evidence: { adapters: providers.map(([, value]) => value.adapter) } });
  add({ id: "sandbox", status: "skipped", code: "SANDBOX_HOST_MANAGED", message: "Sandbox capability is controlled by the host and cannot be proven from persisted state", remediation: "Verify the host sandbox policy before enabling external tools.", evidence: { inspectable: false } });
  add({ id: "run-integrity", status: "warning", code: "RUN_INDEX_DEEP_SCAN_REQUIRED", message: "Run index and checkpoint integrity require an explicit artifact scan", remediation: "Run the artifact integrity command before migration or recovery.", evidence: { root: path.join(dataRoot, "artifacts", "runs") } });
  add({ id: "output-schema", status: "warning", code: "OUTPUT_SCHEMA_RUNTIME_VALIDATED", message: "Output schemas are validated at execution time; strict compatibility cannot be proven globally", remediation: "Validate each pinned workflow and Employee before publication.", evidence: { strict: true, globalCompatibility: false } });
  add({ id: "security", status: "warning", code: "SECURITY_RUNTIME_CONTROLS", message: "Host/Origin, capability, audit, and rate-limit controls are enforced at transport/runtime boundaries", remediation: "Review daemon transport policy and audit sink configuration.", evidence: { controls: ["host", "origin", "capability", "audit", "rate-limit"], staticProof: false } });
  const generatedAt = new Date();
  return { overall: checks.some(c => c.status === "blocked") ? "blocked" : checks.some(c => c.status === "warning") ? "partial" : "ready", generatedAt: generatedAt.toISOString(), staleAt: new Date(generatedAt.getTime() + 5 * 60_000).toISOString(), checks };
}

export interface RetentionPolicy { olderThanDays?: number; statuses?: string[]; maxBytes?: number; preserveRunEvidence?: boolean }
export interface RetentionPreview { candidates: Array<{ invocationId: string; runId?: string; status: string; estimatedBytes: number }>; protected: number; deleteCount: number; estimatedBytes: number; irreversible: string[]; token: string }
const ACTIVE = new Set(["queued", "running", "cancellation-requested", "awaiting-human", "awaiting-human-decision"]);
export async function retentionPreview(dataRoot: string, state: WorkbenchState, policy: RetentionPolicy): Promise<RetentionPreview> {
  const cutoff = Date.now() - (policy.olderThanDays ?? 30) * 86_400_000; let protectedCount = 0;
  const candidates = [] as RetentionPreview["candidates"];
  for (const invocation of Object.values(state.invocations)) {
    if (ACTIVE.has(invocation.status)) { protectedCount++; continue; }
    const timestamp = Date.parse(invocation.completedAt ?? invocation.createdAt);
    if (timestamp > cutoff || (policy.statuses?.length && !policy.statuses.includes(invocation.status))) continue;
    let estimatedBytes = 0; if (invocation.runId) try { estimatedBytes = (await stat(path.join(dataRoot, "artifacts", "runs", invocation.runId, "result.json"))).size; } catch { /* legacy */ }
    candidates.push({ invocationId: invocation.id, runId: invocation.runId, status: invocation.status, estimatedBytes });
  }
  const selected = policy.maxBytes ? candidates.filter((_, i) => candidates.slice(0, i + 1).reduce((n, c) => n + c.estimatedBytes, 0) <= policy.maxBytes!) : candidates;
  return { candidates: selected, protected: protectedCount, deleteCount: selected.length, estimatedBytes: selected.reduce((n, c) => n + c.estimatedBytes, 0), irreversible: ["invocation metadata", ...(policy.preserveRunEvidence === false ? ["run evidence files"] : [])], token: `DELETE-${digest(selected.map(c => c.invocationId)).slice(0, 12).toUpperCase()}` };
}

export function receiptFor(run: Record<string, unknown> | null, invocation?: Record<string, unknown>): Record<string, unknown> {
  if (!run) throw new Error("run not found");
  const status = String(run.status ?? invocation?.status ?? "unavailable"); const legacy = !("phase" in run) || !("budget" in run);
  return { runId: run.id ?? invocation?.runId, status, phase: run.phase ?? "unavailable", failure: run.failure ?? { category: "unavailable", kind: "legacy", retryable: false }, budget: run.budget ?? { used: "unavailable", remaining: "unavailable" }, cancellation: run.cancellation ?? { requested: invocation?.status === "cancellation-requested" }, target: invocation?.target ?? "unavailable", publicationVersion: invocation?.source && typeof invocation.source === "object" ? (invocation.source as Record<string, unknown>).publicationVersion ?? "unavailable" : "unavailable", policyPack: run.policyPack ?? "unavailable", nextAction: ACTIVE.has(status) ? "monitor" : status === "failed" ? "retry" : "none", evidence: run.evidence ?? ["prompt", "raw", "result", "events", "preflight", "checkpoint", "context", "output-validation"].map(kind => ({ kind, status: "unavailable" })), legacy };
}

export function assertSafeOutputPath(target: string, allowedRoot: string): string {
  const resolved = path.resolve(target); const root = path.resolve(allowedRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("path traversal or output outside the allowed root");
  return resolved;
}

export function safeBackupName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(value) || path.basename(value) !== value) throw new Error("backupId must be a safe .json basename");
  return value;
}

async function assertNoSymlinkEscape(resolved: string, allowedRoot: string): Promise<void> {
  const root = await realpath(allowedRoot);
  const parent = await realpath(path.dirname(resolved));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("symlink escape outside the allowed root");
  try { if ((await lstat(resolved)).isSymbolicLink()) throw new Error("backup target must not be a symlink"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function writeBackup(dataRoot: string, state: WorkbenchState, target: string, allowedRoot = path.dirname(path.resolve(target))) {
  const resolved = assertSafeOutputPath(target, allowedRoot); await mkdir(path.dirname(resolved), { recursive: true }); await assertNoSymlinkEscape(resolved, allowedRoot);
  const safeState = restorableLocalState(state);
  const payload = { schemaVersion: 1, kind: "local-agent-workbench-backup", mode: "local-restorable", createdAt: new Date().toISOString(), state: safeState, bundle: exportBundle(state, ["employee", "project", "workflow", "publication", "run-evidence"]), rebuild: { state: "state.json", runIndex: "artifacts/runs" }, checksums: { state: digest(safeState) } };
  const serialized = JSON.stringify(payload, null, 2); await writeFile(resolved, serialized, { flag: "wx" });
  return { id: randomUUID(), path: resolved, digest: createHash("sha256").update(serialized).digest("hex"), size: Buffer.byteLength(serialized), itemCounts: { employees: Object.keys(state.employees).length, workflows: Object.keys(state.workflows).length, runs: Object.keys(state.invocations).length } };
}

export async function readBackup(target: string, allowedRoot: string) { const resolved = assertSafeOutputPath(target, allowedRoot); await assertNoSymlinkEscape(resolved, allowedRoot); const raw = await readFile(resolved, "utf8"); const parsed = JSON.parse(raw) as { schemaVersion?: number; kind?: string; state?: WorkbenchState; checksums?: { state?: string } }; if (parsed.schemaVersion !== 1 || parsed.kind !== "local-agent-workbench-backup" || !parsed.state) throw new Error("invalid backup"); if (parsed.checksums?.state !== digest(parsed.state)) throw new Error("backup checksum mismatch"); return { path: resolved, state: parsed.state, digest: createHash("sha256").update(raw).digest("hex") }; }
