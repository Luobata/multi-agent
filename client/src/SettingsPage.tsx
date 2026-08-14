import { useEffect, useMemo, useState } from "react";
import { api, writeBody } from "./api";

type DoctorReport = { overall: "ready" | "partial" | "blocked"; generatedAt: string; staleAt: string; checks: Array<{ id: string; status: string; code: string; message: string; remediation?: string }> };
type BundlePreview = { valid: boolean; errors: Array<{ path: string; message: string }>; diff: Array<{ mode: string; id: string; action: string; sensitive: boolean }>; confirmationToken?: string };

const modes = ["employee", "project", "workflow", "publication", "run-evidence"];

export function SettingsPage() {
  const [selected, setSelected] = useState<string[]>(["employee", "project", "workflow", "publication"]);
  const [bundleText, setBundleText] = useState("");
  const [preview, setPreview] = useState<BundlePreview>();
  const [doctor, setDoctor] = useState<DoctorReport>();
  const [status, setStatus] = useState("checking");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [retention, setRetention] = useState<unknown>();
  const [retentionToken, setRetentionToken] = useState("");
  const [backupId, setBackupId] = useState("workbench-backup.json");
  const [backup, setBackup] = useState<{ digest: string; path: string }>();
  const [restore, setRestore] = useState<BundlePreview & { digest?: string }>();
  const [resetToken, setResetToken] = useState("");
  const [operationStatus, setOperationStatus] = useState("");
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const parsedBundle = useMemo(() => { try { return JSON.parse(bundleText); } catch { return undefined; } }, [bundleText]);

  const check = () => { setStatus("checking"); api<DoctorReport>("/api/doctor").then(value => { setDoctor(value); setStatus(value.overall); }).catch(reason => { setError(String(reason)); setStatus("offline"); }); };
  useEffect(check, []);
  const exportSelected = async () => { setError(""); try { const value = await api<unknown>("/api/bundles/export", writeBody({ modes: selected })); setBundleText(JSON.stringify(value, null, 2)); setPreview(undefined); } catch (reason) { setError(String(reason)); } };
  const validate = async (replace = false) => { setError(""); if (!parsedBundle) { setPreview({ valid: false, errors: [{ path: "", message: "JSON 格式无效" }], diff: [] }); return; } try { setPreview(await api("/api/bundles/preview", writeBody({ bundle: parsedBundle, conflict: replace ? "replace" : "skip" }))); } catch (reason) { setError(String(reason)); } };
  const apply = async () => { if (!preview?.valid || offline) return; try { await api("/api/bundles/apply", writeBody({ bundle: parsedBundle, conflict: "replace", confirmation })); setPreview(undefined); setConfirmation(""); } catch (reason) { setError(String(reason)); } };
  const estimate = async () => { try { setRetention(await api("/api/retention/preview", writeBody({ olderThanDays: 30, preserveRunEvidence: true }))); } catch (reason) { setError(String(reason)); } };
  const dangerous = async (label: string, work: () => Promise<unknown>) => { setError(""); setOperationStatus(`${label}处理中`); try { await work(); setOperationStatus(`${label}成功`); } catch (reason) { setError(String(reason)); setOperationStatus(`${label}失败`); } };
  const retentionPreview = retention as { token?: string } | undefined;
  const applyRetention = () => dangerous("保留策略应用", () => api("/api/retention/apply", writeBody({ policy: { olderThanDays: 30, preserveRunEvidence: true }, confirmation: retentionToken })));
  const createBackup = () => dangerous("备份创建", async () => { const value = await api<{ digest: string; path: string }>("/api/backups/export", writeBody({ backupId })); setBackup(value); return value; });
  const previewRestore = () => dangerous("恢复预览", async () => { const value = await api<BundlePreview & { digest?: string }>("/api/backups/restore-preview", writeBody({ backupId })); setRestore(value); return value; });
  const applyRestore = () => dangerous("恢复应用", () => api("/api/backups/restore", writeBody({ backupId, conflict: "skip", confirmation })));
  const reset = () => dangerous("重置", () => api("/api/reset", writeBody({ scopes: ["config"], backupDigest: backup?.digest, backupId, confirmation: resetToken })));

  return <main className="dash-page settings-page">
    <header className="dash-page-head"><p className="dash-eyebrow">SETTINGS / CONTROL PLANE</p><h1>设置·集成</h1><p>迁移、诊断与危险数据操作均先预览，确认前不会写入。</p></header>
    <div aria-live="polite">{error && <p className="error-block" role="alert">{error}</p>}{offline && <p className="offline-notice">当前离线，写操作已禁用。</p>}</div>
    <div className="dash-dossier">
      <section className="dash-panel" aria-labelledby="migration-title"><header className="dash-panel-head"><h2 id="migration-title">01 · 模式与迁移</h2></header>
        <fieldset><legend>导出模式</legend><div className="settings-mode-grid">{modes.map(mode => <label key={mode}><input type="checkbox" checked={selected.includes(mode)} onChange={() => setSelected(values => values.includes(mode) ? values.filter(value => value !== mode) : [...values, mode])} /> {mode}</label>)}</div></fieldset>
        <div className="settings-actions"><button disabled={!selected.length} onClick={exportSelected}>生成 JSON</button><button disabled={!bundleText} onClick={() => navigator.clipboard?.writeText(bundleText)}>复制</button><button disabled={!bundleText} onClick={() => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([bundleText], { type: "application/json" })); link.download = "workbench-bundle.json"; link.click(); }}>下载</button></div>
        <label>导入文件<input type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) file.text().then(setBundleText); }} /></label>
        <label>Bundle JSON<textarea rows={10} value={bundleText} onChange={event => { setBundleText(event.target.value); setPreview(undefined); }} /></label>
        <div className="settings-actions"><button onClick={() => validate(false)}>校验并预览</button><button onClick={() => validate(true)}>预览替换</button><button onClick={() => { setBundleText(""); setPreview(undefined); }}>取消</button></div>
        {preview && <div aria-live="polite"><p>{preview.valid ? `有效，${preview.diff.length} 项变更` : "校验失败"}</p>{preview.errors.map(item => <p key={`${item.path}:${item.message}`}><code>{item.path || "/"}</code> {item.message}</p>)}{preview.diff.map(item => <p key={`${item.mode}:${item.id}`}>{item.action} · {item.mode}/{item.id}{item.sensitive ? " · 敏感" : ""}</p>)}{preview.confirmationToken && <><label>逐项确认令牌<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button disabled={offline || confirmation !== preview.confirmationToken} onClick={apply}>应用变更</button></>}</div>}
      </section>
      <section className="dash-panel" aria-labelledby="doctor-title"><header className="dash-panel-head"><h2 id="doctor-title">02 · 环境诊断</h2><span>{status}</span></header><button onClick={check}>重新检查</button>{doctor?.checks.map(item => <article key={item.id}><strong>{item.status} · {item.code}</strong><p>{item.message}</p>{item.remediation && <p>{item.remediation}</p>}</article>)}</section>
      <section className="dash-panel" aria-labelledby="retention-title"><header className="dash-panel-head"><h2 id="retention-title">03 · 数据保留 / 备份 / 重置</h2></header><p>默认保护运行中与等待人工处理的 Run，并保留 Run evidence。重置必须先创建备份回执并键入确认令牌。</p>
        <div className="settings-actions"><button onClick={estimate}>估算并预览 30 天保留策略</button></div>{Boolean(retention) && <><pre>{JSON.stringify(retention, null, 2)}</pre><label>输入保留策略令牌<input autoFocus value={retentionToken} onChange={event => setRetentionToken(event.target.value)} /></label><button disabled={offline || retentionToken !== retentionPreview?.token} onClick={applyRetention}>应用保留策略</button></>}
        <label>备份 ID（安全文件名）<input value={backupId} onChange={event => { setBackupId(event.target.value); setBackup(undefined); setRestore(undefined); }} /></label><div className="settings-actions"><button disabled={offline} onClick={createBackup}>创建本地备份</button><button disabled={offline || !backupId} onClick={previewRestore}>恢复预览</button></div>
        {backup && <p>备份回执：<code>{backup.digest}</code></p>}{restore && <><pre>{JSON.stringify(restore, null, 2)}</pre><button disabled={offline || !restore.valid || Boolean(restore.confirmationToken && confirmation !== restore.confirmationToken)} onClick={applyRestore}>应用恢复</button></>}
        <label>重置确认（RESET-CONFIG）<input value={resetToken} onChange={event => setResetToken(event.target.value)} /></label><button disabled={offline || !backup || resetToken !== "RESET-CONFIG"} onClick={reset}>重置配置</button><p aria-live="polite" tabIndex={-1}>{operationStatus}</p><p className="dash-hint-line">危险应用入口要求服务端确认令牌；离线状态不可写。</p></section>
      <section className="dash-panel" aria-labelledby="security-title"><header className="dash-panel-head"><h2 id="security-title">04 · 安全</h2></header><p>Bundle 与备份会剔除 secret、token、password、credential、API key 与 raw env 字段；路径由服务端限定在显式授权目录内。</p></section>
    </div>
  </main>;
}
