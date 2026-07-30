# Workbench v1 实现与协议手册

## 1. 进程与目录

`multi-agent-daemon` 是 mutable Workbench state 的常驻写入者。它默认监听 `127.0.0.1:4318`，同时提供 REST API、静态客户端和 A2A 路由。离线 CLI 也可短时写入，但会使用同一跨进程锁；v1 仍不支持对同一数据目录运行多个 daemon。

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
| `src/workbench/service.ts` | Employee、Skill、Provider、Workflow、Session、Publication 领域操作 |
| `src/workbench/materialize.ts` | 把版本化 Workbench 数据编译为现有 manifest/prompt/schema |
| `src/runtime/runner.ts` | Provider 调用、重试、Schema、verdict、Run Store |
| `src/architectures/graph.ts` | DAG 校验、计划、并行与依赖控制 |
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
| GET/PUT | `/api/providers[/:id]` | Provider 实例注册 |
| GET/POST/PATCH | `/api/skills[/:id]` | 共享 Skill 注册与版本更新 |
| GET/POST/PATCH | `/api/employees[/:id]` | Employee 列表、创建、详情与新版本 |
| POST | `/api/employees/:id/clone` | 定义复制，不复制上下文/历史 |
| POST | `/api/employees/:id/archive` | 软归档 |
| POST | `/api/employees/:id/invoke` | 一节点 Graph 直接调用 |
| GET | `/api/employees/:id/context` | 六层上下文证据 |
| GET | `/api/sessions[/:id]` | 版本固定 Session |
| GET/POST/PATCH | `/api/workflows[/:id]` | Graph Workflow CRUD |
| GET | `/api/workflows/:id/plan` | 不调用 Provider 的执行计划 |
| POST | `/api/workflows/:id/run` | 执行 Workflow |
| GET | `/api/runs[/:id]` | 不可变 Run 记录 |
| GET/POST | `/api/publications[/:id]` | A2A Publication |
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
  "outputProtocol": "claude-json"
}
```

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

调用 `invoke_employee` 时可以传 `sessionId` 继续一个固定版本 Session；省略后创建当前 Employee 版本的新 Session。

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
