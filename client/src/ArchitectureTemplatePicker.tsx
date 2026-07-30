import { useEffect, useMemo, useState } from "react";
import { api, writeBody } from "./api";
import type { ArchitectureTemplate, Employee, InstantiatedArchitectureTemplate } from "./types";

export function ArchitectureTemplatePicker({ templates, employees, currentPatternId, onApply, notify }: {
  templates: ArchitectureTemplate[];
  employees: Employee[];
  currentPatternId?: string;
  onApply: (value: InstantiatedArchitectureTemplate) => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const activeEmployees = useMemo(() => employees.filter((employee) => employee.status === "active"), [employees]);
  const [templateId, setTemplateId] = useState(currentPatternId ?? templates[0]?.id ?? "");
  const template = templates.find((candidate) => candidate.id === templateId) ?? templates[0];
  const [assignments, setAssignments] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!template) return;
    setAssignments((current) => template.slots.map((_, index) => current[index] ?? activeEmployees[index % Math.max(1, activeEmployees.length)]?.id ?? ""));
  }, [template?.id, activeEmployees.map((employee) => employee.id).join("|")]);

  const apply = async () => {
    if (!template || assignments.some((assignment) => !assignment)) return;
    setApplying(true);
    try {
      const result = await api<InstantiatedArchitectureTemplate>(`/api/architecture-templates/${template.id}/instantiate`, writeBody({ employeeIds: assignments }));
      onApply(result);
      notify(`已生成“${template.displayName}”草稿；可继续拖动与修订依赖`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setApplying(false);
    }
  };

  if (templates.length === 0) return <div className="template-empty">没有可用架构模板，仍可从空白 Graph 开始。</div>;
  return <div className="architecture-picker">
    <div className="architecture-cards" role="list" aria-label="常用多 Agent 架构模板">
      {templates.map((candidate, index) => <button type="button" role="listitem" className={candidate.id === template?.id ? "selected" : ""} key={candidate.id} onClick={() => setTemplateId(candidate.id)}>
        <span className="template-index">0{index + 1}</span><strong>{candidate.displayName}</strong><code>{candidate.pattern}</code><p>{candidate.summary}</p><small>{candidate.slots.length} 个角色槽位 · 并发 {candidate.maxConcurrency}</small>
      </button>)}
    </div>
    {template && <div className="template-mapping">
      <header><div><p className="record-meta">SLOT MAPPING</p><h4>{template.displayName}</h4><p>{template.bestFor}</p></div><span>{template.failFast ? "FAIL FAST" : "EVIDENCE FIRST"}</span></header>
      <div className="template-slots">{template.slots.map((slot, index) => <label key={slot.id}><span><b>{slot.label}</b><small>{slot.description}</small></span><select value={assignments[index] ?? ""} onChange={(event) => setAssignments((current) => current.map((value, assignmentIndex) => assignmentIndex === index ? event.target.value : value))}><option value="">选择员工</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.identity.displayName} · {employee.providerId}</option>)}</select></label>)}</div>
      <div className="template-apply"><span>同一员工可承担多个槽位；生成后仍能逐节点改派。</span><button type="button" className="button primary" disabled={applying || assignments.some((assignment) => !assignment)} onClick={() => void apply()}>{applying ? "生成中…" : currentPatternId ? "按模板重新生成" : "生成可编辑草稿"}</button></div>
    </div>}
  </div>;
}
