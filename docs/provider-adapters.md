# Provider Adapter 配置

核心内置三种 adapter：`command` 使用 argv 启动进程，通过 stdin 发送 `inputTemplate` 渲染结果，不经过 shell 插值；`mock` 返回确定性的 `{ "message": "..." }`；`codex` 以非交互方式调用 Codex CLI，并可为该 Provider 配置一组独立 stdio MCP Server。`inputTemplate` 默认为完整的 `{{prompt}}`；command Provider 的参数、环境变量和输入模板都可以引用运行上下文。

Provider 可以声明可选的 `model` 元数据，供 Workbench 和其他调用方解释当前实例使用的模型。它不参与 adapter 调用，也不替代 `command/args`：adapter 定义仍是执行真相。若命令由别名或包装脚本在运行时选择模型，应在确认本地配置后显式登记；未知时保持未声明。

Workbench Provider 不允许把环境变量明文写进 `state.json`。使用 `$ENV:VARIABLE_NAME` 引用 daemon/CLI 进程已经拥有的环境变量，例如 `env: { API_TOKEN: "$ENV:MODEL_API_TOKEN" }`。运行时只解析这个明确格式，Run 的 materialized manifest 仍只包含引用。

## 可用上下文

- `{{prompt}}`：完整的系统 prompt 与请求 prompt。
- `{{role.systemPrompt}}`、`{{requestPrompt}}`：拆分后的组合角色说明和单次请求。
- `{{role.id}}`、`{{role.description}}`、`{{role.provider}}`。
- `{{role.identity.displayName}}`、`{{role.identity.background}}` 等身份字段。
- `{{role.nativeDefinitionJson}}`：可直接交给支持原生 Agent 注册的 Provider 的角色定义 JSON。
- `{{role.outputSchemaJson}}`：压缩后的 JSON Schema。
- `{{role.outputSchemaPath}}`：当前 materialized Role 输出 Schema 的绝对路径，可交给支持结构化输出的 Provider CLI。
- `{{role.toolsCsv}}`：Skill 与 Role 权限合并后的有效工具列表。
- `{{run.id}}`、`{{run.nodeId}}`、`{{run.artifactDir}}`、`{{run.projectRoot}}`。其中 `run.projectRoot` 与 Provider 的实际工作目录一致；项目角色调用时指向已接入项目根目录，普通 Workflow 则保持 manifest 根目录。
- `{{node.id}}` 与 `{{node.with.<key>}}`。
- `{{input.<key>}}` 与 `{{needs.<node-id>.output}}`。

## Claude Code 兼容示例

下面的片段演示如何将通用 Role Profile 编译为 Provider 的原生 Agent 定义，并把单次请求单独发送到 stdin。使用前应根据本机 CLI 版本核对参数；参数名只是集成示意。

```yaml
providers:
  claude-code:
    adapter: command
    model: claude-model-id
    command: claude
    inputTemplate: "{{requestPrompt}}"
    args:
      - --print
      - --bare
      - --agent
      - "{{role.id}}"
      - --agents
      - "{{role.nativeDefinitionJson}}"
      - --output-format
      - stream-json
      - --verbose
      - --json-schema
      - "{{role.outputSchemaJson}}"
      - --permission-mode
      - acceptEdits
      - --allowedTools
      - "{{role.toolsCsv}}"
      - --disallowedTools=Write,Edit
    # 软时限：超过后标记为长任务，只要仍有输出就继续执行
    timeoutMs: 600000
    # 连续无 stdout/stderr 的空闲时限；未填时等于 timeoutMs
    idleTimeoutMs: 600000
    # 可选的绝对安全上限；不填时不限制总时长，只依赖真实流式进度和 idleTimeoutMs
    hardTimeoutMs: 3600000
    outputProtocol: claude-stream-json
```

Role 仍然拥有“是谁、负责什么、会什么、需要哪些工具”的声明；Provider 负责把通用身份翻译为供应商的注册参数，并真正执行工具限制。仅填写 `permissions` 或 Skill 的 `tools` 不会自动创建 sandbox。

## Codex 知识控制面实例

Workbench 默认登记 `codex-knowledge-control`。它使用 `codex exec --ephemeral`、结构化输出 Schema、独立只读工作目录和根目录拒读的 permission profile，并通过当前 Node 运行时与绝对入口路径只加载带显式工具白名单的 `multi-agent-mcp --profile knowledge-control`，不依赖 daemon 的 shell PATH。这个实例用于项目内部 Knowledge Steward；MCP 只能读取、质检、试跑和创建待人工审批的知识变更，不能批准、拒绝、取消或直接执行。

## 何时增加新 adapter

以下变化应该新增 adapter，而不是在 Role 中增加分支：

- Provider 必须通过 SDK 或远程 API 调用；
- 输出使用新的 envelope 或流式协议；
- 环境、凭据、alias 或容器启动需要专门解析；
- 需要取消、心跳、租约或恢复。

Adapter 应继续返回 stdout、stderr 和持续时间；规范化、Schema 校验、verdict 与证据存储仍由通用 runtime 处理。Command 与 Codex Adapter 会把 stdout/stderr 活动记录为进度：`timeoutMs` 是长任务软时限，不再直接杀死进程；连续无输出达到 `idleTimeoutMs` 才按疑似卡死终止。`hardTimeoutMs` 只有显式配置时才是绝对上限，默认不限制总时长。对默认静默到结束的 CLI，应启用流式 JSON/JSONL 输出，让思考、工具调用和部分消息持续刷新空闲租约，避免把正常长任务误判成卡死。

Supervisor Management Policy 的 `maxDurationMs` 仍是整个编排的显式硬上限，会早于单个 Provider 的硬上限时优先生效。它与 Provider 的软时限、空闲时限不是同一概念；长任务团队应把该值配置为可接受的端到端最长交付窗口。

## 注册自定义 adapter

manifest 的 `providers` 是 Provider 实例 registry，`adapter` 指向代码 registry 中的实现。自定义实现负责校验自己的配置并执行调用：

```ts
import {
  createDefaultProviderRegistry,
  loadManifest,
  registerProviderAdapter,
  runWorkflow
} from "multi-agent-architecture-kit";

const providers = createDefaultProviderRegistry();
registerProviderAdapter(providers, {
  id: "remote-model",
  validate: ({ definition }) =>
    typeof (definition as { endpoint?: unknown }).endpoint === "string"
      ? []
      : ["remote-model endpoint is required"],
  async invoke(invocation) {
    // Translate invocation.definition and invocation.templateContext to the SDK/API request.
    return { stdout: "{}", stderr: "", durationMs: 0 };
  }
});

const loaded = loadManifest("multi-agent.yaml", { providers });
await runWorkflow(loaded, "review-council", { providers });
```

校验和执行必须使用同一个 registry。内置 CLI 与 Workbench daemon 装载 `command` 和 `mock`；需要动态加载本地模块或 Plugin 时，应在 CLI/daemon 外围增加显式、可信的加载策略，不从 manifest 任意执行代码。
