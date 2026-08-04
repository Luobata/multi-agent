# Knowledge Control Conversation

## 1. 目标形态

知识管理后台提供一个项目级 LLM 对话入口。对话不是自由写入层：项目内部的 `Knowledge Steward` 由 Codex Provider 驱动，只能连接 `knowledge-control` MCP profile。MCP 代理 Workbench Service 的受限能力，实际校验、影响计算、审批状态机和执行仍在 TypeScript Core。

```text
User conversation
  → project role: knowledge-steward
  → project-internal Employee
  → codex-knowledge-control Provider (isolated read-only workspace)
  → Knowledge Control MCP
  → KnowledgeChangeRequest awaiting human approval
  → human approve / reject
  → deterministic executor
```

`Knowledge Steward` 带 `identity.metadata.internalProjectId` 和 `internalProjectRoleId`。Core 拒绝把它绑定到其他项目或同项目的其他角色，也拒绝直接调用、全局 Workflow 引用或直接发布为 Publication；后台必须通过当前项目的 `knowledge-steward` role 调用。

## 2. MCP 能力边界

`multi-agent-mcp --profile knowledge-control` 只暴露：

- `knowledge_control_snapshot`
- `knowledge_base_get`
- `knowledge_revision_assess`
- `knowledge_revision_preview`
- `knowledge_impact_get`
- `knowledge_change_list`
- `knowledge_change_get`
- `knowledge_change_propose`
- `knowledge_url_preview`
- `knowledge_url_propose`
- `knowledge_wiki_get`
- `employee_knowledge_perspective`
- `knowledge_review_list`

它没有 approve、reject、cancel、apply、Employee invoke、Workflow run 或通用网络请求工具。Codex 使用非交互 `never` approval policy、独立只读工作目录和根目录拒读的 permission profile；用户级 Codex 配置不会进入这个内部员工。Codex 原生命令即使被模型选中，也只能读取生成的会话包，不能读取项目源码、访问网络或持久化写文件；需要导入 URL 时只能调用 `knowledge_url_preview / knowledge_url_propose`，由服务端执行受限抓取。

`knowledge_change_propose` 使用按 `operation.type` 区分的严格 Schema，而不是开放 JSON：每一种新建、修订、同步、发布、归档或授权动作都有自己的必填字段和 payload 结构，未知字段会在 MCP 入口被拒绝。Schema 只描述意图；资源存在性、版本、发布质量与授权范围仍由 Core 再校验。

URL 入口同样是有限能力：只接收目标 KnowledgeBase、Collection 和 HTTP(S) URL；返回结构化正文、冻结哈希和有限关系候选。模型只能选择预览中已有的候选和固定关系类型，不能自行构造任意引用。提案生成的是 `knowledge-revision.create` 草稿，发布仍需单独的人审提案。

`knowledge_wiki_get`、`employee_knowledge_perspective` 和 `knowledge_review_list` 都是解释性读取：分别回答“全量知识是什么”“某员工在当前任务下能看到并实际选择什么”“哪些授权需要人复核”，不会反向写入 Profile 或授权。

## 3. KnowledgeChangeRequest

每个长期变更只有一个类型化 Operation。当前支持 KnowledgeBase、Revision、Profile、Employee Profile assignment 和 Project Role Profile assignment；URL 导入最终也归一化为 Revision 变更。创建提案时 Core 会：

1. 固定目标 `expectedVersion`；
2. 校验输入和引用；
3. 计算质量、授权与影响预览；
4. 计算 `planHash`；
5. 保存为 `awaiting-approval`。

`employee-profiles.set` 与 `project-role-profiles.set` 保存逐 Profile 的 Grant。新增授权必须有 `reason / grantedBy`，可带到期与复核周期；未涉及的现有 Grant 保持不变。复核动作也只生成 ChangeRequest，台账不会按日期自动改权。

批准前重新执行同一计划。目标版本、质量或影响发生变化时，状态进入 `needs-reapproval`，旧审批不能继续使用。批准、拒绝和执行接口不暴露给 Knowledge Control MCP。

## 4. 当前项目配置

项目内置资源：

- Skill：`templates/workbench/knowledge-control-conversation.skill.json`
- Employee：`templates/workbench/knowledge-steward.employee.json`
- Project Role policy：`docs/project-roles/knowledge-steward.md`
- Binding：`templates/workbench/local-agent-workbench.binding.json`

首次安装或重新建立本地数据时：

```bash
npm run cli -- workbench project connect .
npm run cli -- workbench skill-create templates/workbench/knowledge-control-conversation.skill.json
npm run cli -- workbench employee create templates/workbench/knowledge-steward.employee.json
npm run cli -- workbench project bind local-agent-workbench templates/workbench/local-agent-workbench.binding.json
```

项目声明升级后，已有内部员工可执行 `npm run cli -- workbench employee repin-project local-agent-workbench-knowledge-steward` 生成固定当前项目版本的新 Employee 版本，再重新绑定。

本机需要完成 Codex 登录，并使用支持 permission profiles 的 Codex CLI（`0.138.0+`；当前验收环境为 `0.142.0`）。Provider `codex-knowledge-control` 是无密钥的默认本地 Provider 定义，不会把认证信息写入 Workbench state。

Workbench 会从 daemon PATH、ChatGPT App、常见本机 Node 安装目录中解析 Codex 可执行文件；非标准部署可设置 `MULTI_AGENT_CODEX_COMMAND=/absolute/path/to/codex`。这只指定程序位置，不携带认证信息。

## 5. 多人发布边界

当前实现仍是 loopback 单用户版本。未来发布给多人使用时保留相同 MCP Tool Schema 和 ChangeRequest 状态机，替换外围能力：

- OIDC/OAuth 用户身份与面向 MCP resource 的短期 token；
- Workspace / Project tenant isolation；
- PostgreSQL Change Store、对象存储和后台同步任务；
- 身份绑定的 Approval Event，而不是固定 `local-owner`；
- 限流、配额、审计查询和通知。

`caller`、对话文案和知识文档都不能成为真实授权凭证。
