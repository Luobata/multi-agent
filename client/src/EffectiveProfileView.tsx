import type {
  EffectiveConfigurationReference,
  EffectiveExecutionProfile
} from "./types";

const PAGE_LABELS: Record<NonNullable<EffectiveConfigurationReference["route"]>["page"], string> = {
  employees: "员工档案",
  projects: "项目接入",
  skills: "技能台账",
  knowledge: "知识控制台",
  workflows: "协作编排",
  runs: "运行卷宗"
};

const SOURCE_LABELS: Record<EffectiveConfigurationReference["kind"], string> = {
  employee: "Employee",
  "project-contract": "Project Contract",
  "project-binding": "Project Binding",
  skill: "Skill",
  "knowledge-profile": "Knowledge Profile",
  "knowledge-base": "Knowledge Base",
  provider: "Provider",
  workflow: "Workflow",
  task: "Task"
};

const SCOPE_LABELS = { employee: "员工", project: "项目", run: "本次运行" } as const;
const ACTION_LABELS = {
  base: "基础值",
  append: "追加",
  select: "选择",
  override: "覆盖",
  narrow: "收窄",
  resolve: "解析"
} as const;

function versionLabel(reference: EffectiveConfigurationReference): string {
  return [reference.version === undefined ? undefined : `v${reference.version}`, reference.revision === undefined ? undefined : `r${reference.revision}`]
    .filter(Boolean)
    .join(" · ");
}

function ReferenceSnapshot({ reference, action, path }: {
  reference: EffectiveConfigurationReference;
  action: string;
  path?: string;
}) {
  const version = versionLabel(reference);
  return <details className="effective-source">
    <summary>
      <span className="effective-source-kind">{SOURCE_LABELS[reference.kind]}</span>
      <span className="effective-source-title"><strong>{reference.label}</strong><code>{reference.id}{version ? ` · ${version}` : ""}</code></span>
      <span className="effective-source-action">{action}{path ? ` · ${path}` : ""}</span>
      <span className="effective-source-expand">展开完整快照</span>
    </summary>
    <div className="effective-source-body">
      <pre className="result-json">{JSON.stringify(reference.snapshot, null, 2)}</pre>
      {reference.route && <a className="button secondary effective-source-link" href={`#${reference.route.page}`}>
        前往{PAGE_LABELS[reference.route.page]} · {reference.route.entityId}
      </a>}
    </div>
  </details>;
}

export function EffectiveProfileView({ profile }: { profile: EffectiveExecutionProfile }) {
  const references = new Map(profile.references.map((reference) => [reference.refId, reference]));
  return <div className="effective-profile">
    <dl className="ledger effective-profile-meta">
      <dt>编译对象</dt><dd><code>{profile.employee.id} · v{profile.employee.version}</code></dd>
      <dt>运行节点</dt><dd><code>{profile.runId} / {profile.nodeId}</code></dd>
      {profile.assignment && <><dt>项目分配</dt><dd><code>{profile.assignment.projectId} v{profile.assignment.projectVersion} / {profile.assignment.roleId} / binding v{profile.assignment.projectBindingVersion}</code></dd></>}
      <dt>编译时间</dt><dd>{new Date(profile.compiledAt).toLocaleString()}</dd>
    </dl>
    <p className="effective-profile-help">这里展示本次运行真正生效的配置。每条来源均固定到运行时版本；点击来源可展开完整快照，管理型资源也可前往对应台账。</p>
    <div className="effective-field-list">{profile.fields.map((field, index) => <article className="effective-field" key={field.key}>
      <header><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{field.label}</strong><p>{field.mergeRule}</p></div></header>
      <details className="effective-value"><summary>查看最终生效值</summary><pre className="result-json">{JSON.stringify(field.value, null, 2)}</pre></details>
      <div className="effective-contributions">{field.contributions.map((item, contributionIndex) => {
        const reference = references.get(item.referenceId);
        return reference
          ? <ReferenceSnapshot key={`${item.referenceId}-${contributionIndex}`} reference={reference} action={`${SCOPE_LABELS[item.scope]} · ${ACTION_LABELS[item.action]}`} path={item.path} />
          : <div className="inline-error" key={`${item.referenceId}-${contributionIndex}`}>来源快照缺失：{item.referenceId}</div>;
      })}</div>
    </article>)}</div>
  </div>;
}
