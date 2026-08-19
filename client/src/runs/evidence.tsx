import { useState } from "react";
import { Modal } from "../components";
import type { JsonValue, RunEvidenceAsset } from "../types";
import { formatBytes, objectValue } from "./shared";

/** 证据渲染：结构化 E2E 列表与媒体证据卡片（截图可放大预览）。 */
interface E2eEvidenceEntry {
  method?: string;
  steps?: string;
  observed?: string;
}

/** Reads a structured `e2eEvidence` array off any output object; tolerant of missing/oddly-typed fields. */
export function e2eEvidenceEntries(value: JsonValue | undefined): E2eEvidenceEntry[] {
  const raw = objectValue(value)?.e2eEvidence;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => objectValue(item))
    .filter((item): item is Record<string, JsonValue> => item !== undefined)
    .map((item) => ({
      method: typeof item.method === "string" ? item.method : undefined,
      steps: typeof item.steps === "string" ? item.steps : undefined,
      observed: typeof item.observed === "string" ? item.observed : undefined
    }))
    .filter((entry) => entry.method || entry.steps || entry.observed);
}

export function E2eEvidenceList({ entries }: { entries: E2eEvidenceEntry[] }) {
  if (entries.length === 0) return null;
  return <ul className="run-e2e-evidence">{entries.map((entry, index) => <li key={index}>
    {entry.method && <code className="run-e2e-method">{entry.method}</code>}
    {entry.steps && <span className="run-e2e-steps">{entry.steps}</span>}
    {entry.observed && <><span className="run-e2e-arrow" aria-hidden="true">→</span><span className="run-e2e-observed">{entry.observed}</span></>}
  </li>)}</ul>;
}

export function RunEvidenceCard({ asset }: { asset: RunEvidenceAsset }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return <>
    <figure className="run-delivery-evidence-card">
      {asset.kind === "screenshot"
        ? <button type="button" className="run-delivery-evidence-trigger" aria-haspopup="dialog" aria-label={`在项目内预览证据 ${asset.name}`} onClick={() => setPreviewOpen(true)}><img className="run-delivery-evidence-media" src={asset.url} alt={asset.name} loading="lazy" /></button>
        : <video className="run-delivery-evidence-media" src={asset.url} controls preload="metadata" aria-label={asset.name} />}
      <figcaption><strong>{asset.name}</strong><span>{asset.kind === "screenshot" ? "截图 · 点击放大" : "录屏"} · {formatBytes(asset.sizeBytes)}</span><code>{asset.relativePath}</code></figcaption>
    </figure>
    {asset.kind === "screenshot" && previewOpen && <Modal title={asset.name} eyebrow="PROJECT EVIDENCE · IMAGE VIEWER" onClose={() => setPreviewOpen(false)} wide className="run-evidence-viewer-modal">
      <div className="run-evidence-viewer">
        <div className="run-evidence-viewer-stage"><img src={asset.url} alt={asset.name} /></div>
        <footer><span>{asset.mediaType.split("/")[1]?.toUpperCase()} · {formatBytes(asset.sizeBytes)}</span><code>{asset.relativePath}</code><a className="button secondary" href={asset.url} target="_blank" rel="noreferrer">打开原始文件</a></footer>
      </div>
    </Modal>}
  </>;
}
