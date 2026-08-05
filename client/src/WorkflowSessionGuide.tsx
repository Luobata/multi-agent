import { ReadonlyEvidence } from "./components";
import type { WorkflowSessionPrompts } from "./workflowSessionPrompts";

export function WorkflowSessionGuide({ prompts }: { prompts: WorkflowSessionPrompts }) {
  return <div className="workflow-session-guides">
    <section className="workflow-session-guide workflow-session-guide--agents" aria-labelledby="workflow-agents-guide-title">
      <header>
        <span>01 · PROJECT POLICY</span>
        <div>
          <strong id="workflow-agents-guide-title">加入项目 AGENTS.md</strong>
          <p>适合长期接入。它告诉 Codex 何时启动协作、何时只继续讨论，以及固定使用哪个入口。</p>
        </div>
        <code>长期规则</code>
      </header>
      <ReadonlyEvidence label="建议加入 AGENTS.md" value={prompts.agentsMarkdown} />
    </section>

    <section className="workflow-session-guide workflow-session-guide--invocation" aria-labelledby="workflow-invocation-guide-title">
      <header>
        <span>02 · ONE-OFF INVOCATION</span>
        <div>
          <strong id="workflow-invocation-guide-title">当前会话调用</strong>
          <p>适合立即执行一次任务。复制调用描述，或由支持 MCP 的客户端按右侧参数直接调用。</p>
        </div>
        <code>单次任务</code>
      </header>
      <div className="workflow-session-examples">
        <ReadonlyEvidence label="当前会话调用描述" value={prompts.invocationPrompt} />
        <ReadonlyEvidence label={`MCP 参数示例 · ${prompts.tool}`} value={prompts.mcpJson} mono />
      </div>
    </section>
  </div>;
}
