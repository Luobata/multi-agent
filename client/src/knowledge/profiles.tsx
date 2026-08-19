import { useState, type FormEvent } from "react";
import { api, writeBody } from "../api";
import {
  DossierSection,
  Field,
  Modal,
  SelectControl,
  useDaemonAvailable
} from "../components";
import type {
  KnowledgeActivation,
  KnowledgeAuthority,
  KnowledgeBase,
  KnowledgeClassification,
  KnowledgeProfile
} from "../types";
import { list, type PageProps } from "./editors";

interface ProfilePolicyRuleDraft {
  id: string;
  activation: KnowledgeActivation;
  knowledgeBaseIds: string[];
  domains: string;
  products: string;
  scopeProjectIds: string;
  collectionIds: string;
  authorities: KnowledgeAuthority[];
  maxClassification: KnowledgeClassification;
  conditionProjectIds: string;
  projectRoleIds: string;
  taskTags: string;
  requestTerms: string;
  priority: number;
  required: boolean;
  maxCollections: number;
  maxChunks: number;
  maxTokens: number;
}

interface ProfilePolicyDraft {
  id: string;
  displayName: string;
  description: string;
  rules: ProfilePolicyRuleDraft[];
}

function policyRuleDraft(rule?: KnowledgeProfile["rules"][number], index = 0): ProfilePolicyRuleDraft {
  return {
    id: rule?.id ?? `rule-${index + 1}`,
    activation: rule?.activation ?? "on-demand",
    knowledgeBaseIds: [...(rule?.selector.knowledgeBaseIds ?? [])],
    domains: rule?.selector.domains?.join(", ") ?? "",
    products: rule?.selector.products?.join(", ") ?? "",
    scopeProjectIds: rule?.selector.projectIds?.join(", ") ?? "",
    collectionIds: rule?.selector.collectionIds?.join(", ") ?? "",
    authorities: [...(rule?.selector.authorities ?? ["canonical", "reference"])],
    maxClassification: rule?.selector.maxClassification ?? "internal",
    conditionProjectIds: rule?.conditions?.projectIds?.join(", ") ?? "",
    projectRoleIds: rule?.conditions?.projectRoleIds?.join(", ") ?? "",
    taskTags: rule?.conditions?.taskTags?.join(", ") ?? "",
    requestTerms: rule?.conditions?.requestTerms?.join(", ") ?? "",
    priority: rule?.priority ?? 0,
    required: rule?.required ?? false,
    maxCollections: rule?.budget.maxCollections ?? 3,
    maxChunks: rule?.budget.maxChunks ?? 4,
    maxTokens: rule?.budget.maxTokens ?? 2000
  };
}

function policyDraft(profile?: KnowledgeProfile): ProfilePolicyDraft {
  return {
    id: profile?.id ?? "",
    displayName: profile?.displayName ?? "",
    description: profile?.description ?? "",
    rules: profile?.rules.length ? profile.rules.map(policyRuleDraft) : [policyRuleDraft()]
  };
}

function ruleHasCatalogScope(rule: ProfilePolicyRuleDraft): boolean {
  return rule.knowledgeBaseIds.length > 0
    || list(rule.domains).length > 0
    || list(rule.products).length > 0
    || list(rule.scopeProjectIds).length > 0
    || list(rule.collectionIds).length > 0;
}

export function KnowledgeProfilePolicyEditor({ profile, knowledgeBases, onClose, onSaved, notify }: {
  profile?: KnowledgeProfile;
  knowledgeBases: KnowledgeBase[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  notify: PageProps["notify"];
}) {
  const daemonAvailable = useDaemonAvailable();
  const [draft, setDraft] = useState(() => policyDraft(profile));
  const [saving, setSaving] = useState(false);
  const patchRule = (index: number, patch: Partial<ProfilePolicyRuleDraft>) => setDraft((current) => ({
    ...current,
    rules: current.rules.map((rule, candidate) => candidate === index ? { ...rule, ...patch } : rule)
  }));
  const valid = draft.rules.length > 0
    && draft.rules.every((rule) => ruleHasCatalogScope(rule) && rule.authorities.length > 0)
    && new Set(draft.rules.map((rule) => rule.id)).size === draft.rules.length;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      notify("每条规则都需要唯一 ID、明确的目录范围和至少一个权威级别", "error");
      return;
    }
    setSaving(true);
    try {
      const rules = draft.rules.map((rule) => ({
        id: rule.id.trim(),
        selector: {
          knowledgeBaseIds: rule.knowledgeBaseIds.length ? rule.knowledgeBaseIds : undefined,
          domains: list(rule.domains).length ? list(rule.domains) : undefined,
          products: list(rule.products).length ? list(rule.products) : undefined,
          projectIds: list(rule.scopeProjectIds).length ? list(rule.scopeProjectIds) : undefined,
          collectionIds: list(rule.collectionIds).length ? list(rule.collectionIds) : undefined,
          authorities: rule.authorities,
          maxClassification: rule.maxClassification
        },
        activation: rule.activation,
        conditions: {
          projectIds: list(rule.conditionProjectIds).length ? list(rule.conditionProjectIds) : undefined,
          projectRoleIds: list(rule.projectRoleIds).length ? list(rule.projectRoleIds) : undefined,
          taskTags: list(rule.taskTags).length ? list(rule.taskTags) : undefined,
          requestTerms: list(rule.requestTerms).length ? list(rule.requestTerms) : undefined
        },
        priority: rule.priority,
        required: rule.required,
        budget: { maxCollections: rule.maxCollections, maxChunks: rule.maxChunks, maxTokens: rule.maxTokens }
      }));
      const payload = { id: draft.id.trim(), displayName: draft.displayName.trim(), description: draft.description.trim(), rules };
      const saved = await api<KnowledgeProfile>(profile ? `/api/knowledge-profiles/${profile.id}` : "/api/knowledge-profiles", writeBody(payload, profile ? "PATCH" : "POST"));
      notify(profile ? `${saved.displayName} 已更新为 v${saved.version}` : `${saved.displayName} 已建立`);
      await onSaved(saved.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };
  return <Modal title={profile ? `修订 ${profile.displayName}` : "建立知识 Profile"} eyebrow="REUSABLE KNOWLEDGE POLICY · MULTI RULE" onClose={onClose} wide>
    <form className="editor-form profile-policy-editor" onSubmit={submit}>
      <fieldset disabled={!daemonAvailable}>
        <DossierSection number="01" title="策略身份"><div className="form-grid two"><Field label="Profile ID"><input required disabled={Boolean(profile)} pattern="[a-z][a-z0-9-]*" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="显示名"><input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field></div><Field label="适用边界"><textarea required rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field></DossierSection>
        <DossierSection number="02" title={`选择与激活规则 · ${draft.rules.length}`} action={<button type="button" className="text-button" onClick={() => setDraft({ ...draft, rules: [...draft.rules, policyRuleDraft(undefined, draft.rules.length)] })}>增加规则</button>}>
          <div className="profile-policy-rules">{draft.rules.map((rule, index) => <article className={!ruleHasCatalogScope(rule) || rule.authorities.length === 0 ? "invalid" : ""} key={`${index}-${rule.id}`}>
            <header><div><span>{String(index + 1).padStart(2, "0")}</span><Field label="规则 ID"><input required pattern="[a-z][a-z0-9-]*" value={rule.id} onChange={(event) => patchRule(index, { id: event.target.value })} /></Field></div>{draft.rules.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, candidate) => candidate !== index) })}>删除规则</button>}</header>
            <section><h3>目录范围</h3><div className="form-grid two"><Field label="领域" hint="逗号分隔；匹配新知识库时会自动进入候选。"><input value={rule.domains} onChange={(event) => patchRule(index, { domains: event.target.value })} /></Field><Field label="Collection ID"><input value={rule.collectionIds} onChange={(event) => patchRule(index, { collectionIds: event.target.value })} /></Field><Field label="产品 ID"><input value={rule.products} onChange={(event) => patchRule(index, { products: event.target.value })} /></Field><Field label="知识所属项目"><input value={rule.scopeProjectIds} onChange={(event) => patchRule(index, { scopeProjectIds: event.target.value })} /></Field></div><fieldset className="knowledge-base-choices"><legend>显式知识库</legend>{knowledgeBases.filter((item) => item.status === "active" || rule.knowledgeBaseIds.includes(item.id)).map((item) => <label key={item.id}><input type="checkbox" checked={rule.knowledgeBaseIds.includes(item.id)} onChange={(event) => patchRule(index, { knowledgeBaseIds: event.target.checked ? [...rule.knowledgeBaseIds, item.id] : rule.knowledgeBaseIds.filter((id) => id !== item.id) })} /><span><strong>{item.displayName}</strong><small>{item.domain} · Published R{item.publishedRevision ?? "—"}</small></span></label>)}</fieldset>{!ruleHasCatalogScope(rule) && <p className="inline-error">至少限定知识库、领域、产品、项目或 Collection 之一。</p>}</section>
            <section><h3>信任边界</h3><div className="form-grid two"><Field label="最高敏感度"><SelectControl ariaLabel={`规则 ${rule.id} 最高敏感度`} value={rule.maxClassification} options={[{ value: "internal", label: "内部" }, { value: "confidential", label: "机密" }, { value: "restricted", label: "严格受限" }]} onChange={(maxClassification) => patchRule(index, { maxClassification: maxClassification as KnowledgeClassification })} /></Field><fieldset className="profile-authority-choices"><legend>允许权威级别</legend>{(["canonical", "reference", "experimental"] as KnowledgeAuthority[]).map((authority) => <label key={authority}><input type="checkbox" checked={rule.authorities.includes(authority)} onChange={(event) => patchRule(index, { authorities: event.target.checked ? [...rule.authorities, authority] : rule.authorities.filter((item) => item !== authority) })} />{authority}</label>)}</fieldset></div>{rule.authorities.length === 0 && <p className="inline-error">至少允许一个权威级别。</p>}</section>
            <section><h3>激活上下文</h3><div className="form-grid three"><Field label="模式"><SelectControl ariaLabel={`规则 ${rule.id} 激活模式`} value={rule.activation} options={[{ value: "core", label: "Core", description: "每次有资格参与" }, { value: "conditional", label: "Conditional", description: "条件匹配后参与" }, { value: "on-demand", label: "On demand", description: "相关时才参与" }]} onChange={(activation) => patchRule(index, { activation: activation as KnowledgeActivation })} /></Field><Field label="优先级"><input type="number" min={-100} max={100} value={rule.priority} onChange={(event) => patchRule(index, { priority: Number(event.target.value) })} /></Field><label className="plain-check policy-required"><input type="checkbox" checked={rule.required} onChange={(event) => patchRule(index, { required: event.target.checked })} />预算冲突时优先保留</label></div><div className="form-grid two"><Field label="调用项目"><input value={rule.conditionProjectIds} onChange={(event) => patchRule(index, { conditionProjectIds: event.target.value })} /></Field><Field label="项目角色"><input value={rule.projectRoleIds} onChange={(event) => patchRule(index, { projectRoleIds: event.target.value })} /></Field><Field label="任务标签"><input value={rule.taskTags} onChange={(event) => patchRule(index, { taskTags: event.target.value })} /></Field><Field label="请求词项"><input value={rule.requestTerms} onChange={(event) => patchRule(index, { requestTerms: event.target.value })} /></Field></div></section>
            <section><h3>单次容量预算</h3><div className="form-grid three"><Field label="最多 Collection"><input type="number" min={1} max={12} value={rule.maxCollections} onChange={(event) => patchRule(index, { maxCollections: Number(event.target.value) })} /></Field><Field label="最多 Chunk"><input type="number" min={1} max={20} value={rule.maxChunks} onChange={(event) => patchRule(index, { maxChunks: Number(event.target.value) })} /></Field><Field label="最多 Token"><input type="number" min={128} max={16000} value={rule.maxTokens} onChange={(event) => patchRule(index, { maxTokens: Number(event.target.value) })} /></Field></div></section>
          </article>)}</div>
        </DossierSection>
      </fieldset>
      <div className="editor-savebar"><span className="policy-save-summary">{draft.rules.length} 条规则 · {draft.rules.filter(ruleHasCatalogScope).length} 条范围完整</span><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!daemonAvailable || saving || !valid}>{saving ? "保存中…" : profile ? `保存为 v${profile.version + 1}` : "建立 Profile"}</button></div>
    </form>
  </Modal>;
}
