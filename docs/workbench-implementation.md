# Workbench v1 实现与协议手册

## 1. 进程与目录

`multi-agent-daemon` 是 mutable Workbench state 的常驻写入者。它默认监听 `127.0.0.1:4318`，同时提供 REST API、SSE 实时状态、静态客户端和 A2A 路由。离线 CLI 也可短时写入，但会使用同一跨进程锁；v1 仍不支持对同一数据目录运行多个 daemon。

```text
~/.multi-agent/workbench/
  state.json
  generated/<workflow>-<uuid>/
    multi-agent.json
    roles/
    skills/
    schemas/
  artifacts/runs/<run-id>/
    input.json
    plan.json
    run.json
    events.jsonl
    nodes/<node>/attempt-<n>/
      system-prompt.md
      request-prompt.md
      prompt.md
      stdout.txt
      stderr.txt
      result.json | error.json
```

`state.json` 在 `state.lock` 保护下通过临时文件 rename 原子写入。进程内 mutation queue 与跨进程 lock 防止并发 daemon/CLI 请求丢失更新；陈旧锁可在超时后恢复。协议任务与运行调度仍由单个 daemon 拥有。

## 2. TypeScript 边界

| 模块 | 责任 |
| --- | --- |
| `src/workbench/store.ts` | Workbench state 原子持久化 |
| `src/workbench/service.ts` | Employee、Project、Policy、Workflow、Session、Publication、Invocation 与 Work Instance 领域操作 |
| `src/workbench/entrancePolicy.ts` | 请求分流结构校验、顺序规则匹配与纯决策 |
| `src/workbench/materialize.ts` | 把版本化 Workbench 数据编译为现有 manifest/prompt/schema |
| `src/runtime/runner.ts` | Provider 调用、重试、Schema、verdict、Run Store |
| `src/architectures/graph.ts` | DAG 校验、计划、并行与依赖控制 |
| `src/architectures/supervisor.ts` | 主管观察、派单、收敛与动态执行图控制循环 |
| `src/daemon/server.ts` | loopback HTTP 与静态客户端 |
| `src/mcp/server.ts` | daemon 的 stdio MCP 代理 |
| `src/protocols/a2a.ts` | Publication 到 A2A Agent Card/Task/Artifact 的映射 |
| `client/` | Kimi 设计的 React 档案室 |

直接调用由 `WorkbenchService.directWorkflow()` 创建一节点 Graph，再走 `materializeWorkflow()` 和 `runWorkflow()`。它没有独立执行引擎，也没有新增 `direct` Architecture Adapter。

## 3. HTTP API

所有 `/api` 成功响应为 `{ "data": ... }`，失败响应为 `{ "error": { "message": "..." } }`。

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/health` | daemon 状态与安全边界 |
| GET | `/api/bootstrap` | 客户端首屏注册表快照 |
| GET | `/api/activity` | 调用与员工出勤快照 |
| GET | `/api/activity/stream` | 调用与节点状态 SSE |
| GET/PUT | `/api/providers[/:id]` | Provider 实例注册 |
| GET/POST/PATCH | `/api/skills[/:id]` | 共享 Skill 注册与版本更新 |
| GET/POST/PATCH | `/api/knowledge-bases[/:id]` | KnowledgeBase 目录与定义版本 |
| GET | `/api/knowledge-bases/:id/assessment` | 指定 Revision 的发布前质量检查 |
| POST | `/api/knowledge-bases/:id/preview` | 不发布、不调用 Provider 的草稿检索试跑 |
| POST | `/api/knowledge-bases/:id/sync` | 从 Source 生成未发布 Revision |
| POST | `/api/knowledge-bases/:id/publish` | 发布或回滚 Revision 指针 |
| GET/POST/PATCH | `/api/knowledge-profiles[/:id]` | 可复用知识范围、激活与预算策略 |
| GET | `/api/knowledge/impact` | KnowledgeBase → Profile → 使用方影响快照 |
| GET/POST/PATCH | `/api/employees[/:id]` | Employee 列表、创建、详情与新版本 |
| POST | `/api/employees/:id/clone` | 定义复制，不复制上下文/历史 |
| POST | `/api/employees/:id/archive` | 软归档 |
| POST | `/api/employees/:id/invoke` | 一节点 Graph 直接调用 |
| POST | `/api/employees/:id/knowledge-preview` | 不调用 Provider 的知识计划试跑 |
| GET | `/api/employees/:id/context` | 七层上下文与知识证据 |
| GET/POST | `/api/projects`、`/api/projects/connect` | Project 列表与声明文件接入 |
| GET/PUT | `/api/projects/:id`、`/api/projects/:id/binding` | 项目详情与版本化员工任用 |
| POST | `/api/projects/:id/roles/:roleId/invoke` | 解析任用关系并调用项目角色 |
| GET | `/api/sessions[/:id]` | 版本固定 Session |
| GET/POST/PATCH | `/api/workflows[/:id]` | Graph / Supervisor Workflow CRUD |
| GET | `/api/workflows/:id/plan` | 不调用 Provider 的执行计划 |
| POST | `/api/workflows/:id/start` | 异步受理 Workflow，返回 Invocation 与 Run 编号 |
| POST | `/api/workflows/:id/run` | 等待 Workflow 完成的兼容入口 |
| GET/POST/PATCH | `/api/management-policies[/:id]` | 主管管理边界的版本化资源 |
| GET/POST/PATCH | `/api/entrance-policies[/:id]` | 请求分流策略、详情与版本历史 |
| POST | `/api/entrance-policies/:id/evaluate` | 只按结构化元数据试算，不创建运行 |
| POST | `/api/entrance-policies/:id/dispatch` | 按试算结果交还调用方、直达专家或异步启动 Workflow |
| GET | `/api/invocations/:id` | 查询异步调用、节点实例与已生成的 Run 证据 |
| GET | `/api/runs[/:id]` | 不可变 Run 记录 |
| GET/POST | `/api/publications[/:id]` | A2A Publication |
| POST | `/api/publications/:id/invoke` | 统一调用单 Agent / 多 Agent 包 |
| GET | `/api/publications/:id/card` | UI 使用的 Agent Card envelope |

## 4. Provider 与身份注册

Provider Adapter 由可信 TypeScript 代码注册；Provider 实例由 state/API 注册并引用 Adapter：

```json
{
  "adapter": "command",
  "command": "claude",
  "args": ["--print", "--output-format", "json"],
  "env": { "MODEL_API_TOKEN": "$ENV:MODEL_API_TOKEN" },
  "inputTemplate": "{{prompt}}",
  "timeoutMs": 600000,
  "idleTimeoutMs": 600000,
  "hardTimeoutMs": 3600000,
  "outputProtocol": "claude-json"
}
```

`timeoutMs` 是软时限：越过后 Work Instance 显示为长任务，但有 stdout/stderr 进展时继续执行。`idleTimeoutMs` 才表示持续无输出多久后按疑似卡死终止；省略时沿用 `timeoutMs`。`hardTimeoutMs` 是可选的绝对安全上限，只有显式配置才生效；默认不限制总时长。静默型 CLI 应切换为流式事件输出，以真实思考/工具进度续租 idle timeout。

Employee identity 是结构化字段，不是一段不可拆 prompt：

```json
{
  "displayName": "Local Researcher",
  "background": "Investigates repository evidence.",
  "responsibilities": ["Locate evidence", "State uncertainty"],
  "goals": ["Produce traceable findings"],
  "constraints": ["Do not modify source files"],
  "metadata": { "team": "architecture" }
}
```

共享 Skill 单独注册，Employee 绑定 Skill ID、明确版本与通过 JSON Schema 校验的配置。Skill 更新生成新版本；旧 Employee/Session 继续解析旧 Skill。修订 Employee 并重新保存绑定时才会固定到当前 Skill 版本。Provider、Skill 和 Employee 的关系可以在 UI 的“共享注册表”和员工档案中查看。

## 5. MCP

MCP server 只把 stdio tool call 转成 daemon HTTP 请求，不持有 Employee state，也不执行 Graph。这样任意支持 MCP 的会话看到的是同一份本地员工注册表。

```bash
multi-agent-mcp --daemon-url http://127.0.0.1:4318
```

调用 `invoke_employee` 时可以传 `sessionId` 继续一个固定版本 Session；省略后创建当前 Employee 版本的新 Session。推荐外部会话先用 `list_publications` 发现调用包：Employee Publication 使用 `invoke_publication`，Workflow Publication 使用 `start_publication`，后者既保留稳定 Publication 边界，也避免同步请求占住整个 Run。需要先决定是否启用领队时，使用 `evaluate_entrance_policy` 做无副作用试算，或用 `dispatch_entrance_policy` 执行固定目标；消息正文不参与路由。直接运行长 Workflow 使用 `start_workflow`。两种异步启动都必须立即用回执的 `monitor.initialCursor` 循环 `wait_workflow_progress`；`terminal=false` 时保持当前回合，变化和心跳都转述 `progressReport`，终态才交付。断线后可用 `resume_workflow_monitor(runId)` 重挂。`run_workflow` 与 Workflow 目标的 `invoke_publication` 仅作为同步兼容入口，不适合长任务。

运行时调度、有限重试和异步入口的设计与后续边界见 [Multi-Agent 运行性能与可靠性优化](multi-agent-runtime-performance.md)。

## 6. A2A v1

Publication 指向一个 Employee 或 Workflow：

```json
{
  "id": "research-desk",
  "name": "Research Desk",
  "description": "Local evidence research agent.",
  "target": { "kind": "employee", "id": "local-researcher" }
}
```

路由：

```text
GET  /a2a/research-desk/.well-known/agent-card.json
POST /a2a/research-desk
```

JSON-RPC v1 示例：

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "Inspect this design" }]
    }
  }
}
```

第一条执行事件总是 Task；随后发布 result Artifact 和 terminal status。`blocked` 是合法领域输出，所以 Task 完成并携带 `domainBlock: true`；`failed` 才是技术失败。

## 7. 安全与下一阶段

- daemon main 拒绝非 loopback host；UI 也持续展示无认证警告。
- 不在 Employee、Session、Agent Card 或 prompt artifact 中存储密钥。
- Workbench command Provider 的 env 只接受 `$ENV:VARIABLE_NAME`；state 与 Run manifest 不保存对应明文凭据。
- v1 A2A Task Store 是内存实现；持久 Task、取消传播与恢复需要下一阶段的 durable queue。
- 公网/LAN 暴露必须先增加认证、授权、tenant 隔离、速率限制与安全审计，不能只改 bind host。
- 新增多 Agent 模式时，优先判断现有 Graph 的模板/policy 是否已能表达；只有控制循环不同才增加 Architecture Adapter。
