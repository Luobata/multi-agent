# 项目接入、员工任用与调用

## 定义

项目不是 MCP，也不是一段需要复制到每个仓库的长 Prompt。Workbench 把它拆成四层：

1. `Project Descriptor`：跟随项目源码，只声明项目身份、角色需求和项目策略文件引用。
2. `ProjectBinding`：保存在本地 Workbench，记录每个角色槽位由哪位 Employee 担任、启用哪些 Skill、临时追加哪些 Knowledge Profile，以及更新策略。
3. `Runtime`：每次调用时合成员工身份、项目角色策略、Skill 子集、Employee/Profile 知识范围、当前任务与 Session 历史，并把最终 Prompt 和 Knowledge Plan 固化到 Run。
4. `HTTP / MCP`：只是项目或对话的调用适配器，不拥有项目关系。

管理台是控制面；daemon 和 Run Store 是事实来源。

## 最小项目声明

项目根目录中的 `multi-agent.project.yaml` 可以保持很短：

```yaml
version: 1
project:
  id: example-project
  name: Example Project
  scope: repository
connector:
  kind: generic
roles:
  tester:
    displayName: 测试验收
    description: 验证真实行为和自动化覆盖。
    requiredSkills: [browser-e2e-validation]
    requiredProviderProfiles: []
    knowledgeProfiles: [workbench-quality-knowledge]
    policyRef: docs/agents/tester.md
    permissions:
      write: none
```

`policyRef` 和可选的 `outputSchemaRef` 必须位于项目根目录内。Workbench 读取并版本化其内容；YAML 不保存 Employee ID、Provider 命令、完整 Skill 指令或密钥。

控制面角色可声明 `requiredProviderProfiles`，Binding 保存前会校验 Employee 所用 Provider 是否具备由系统管理的执行配置。例如员工配置管家要求 `configuration-proposal-only`，普通 command/full Provider 不能冒充该受限运行时。

## 接入与任用

```bash
multi-agent workbench project connect /path/to/project
multi-agent workbench project bind example-project project-binding.json
```

也可以在管理台“项目接入”页填写项目根目录，读取声明后逐个选择员工。保存会生成新的 `ProjectBinding` 版本。

默认更新策略是 `compatible`：员工身份和提示词等兼容更新可生成新的任用版本；Provider、权限、输出契约或 Verdict 变化需要人工确认。`locked` 始终停留在旧版本，`latest` 会尝试采用最新员工版本。新增 Skill 只进入候选列表，不会自动启用。

项目声明中的 `knowledgeProfiles` 是该角色允许追加的 Profile 集合；实际任用可以选择其子集。运行时将它与 Employee 自身 Profile 合并，且不会反写 Employee 档案。

进行中的调用和已有 Session 始终使用启动时固定的项目版本、任用版本、Employee 版本与 Skill 版本；Knowledge Plan 另外固定当次 Profile 版本和已发布 Revision。

## 调用

项目运行时可使用 loopback HTTP：

```text
POST /api/projects/<project-id>/roles/<role-id>/invoke
Content-Type: application/json

{"message":"验收当前改动"}
```

MCP 对话使用：

```json
{
  "tool": "invoke_project_role",
  "arguments": {
    "projectId": "example-project",
    "roleId": "tester",
    "message": "验收当前改动"
  }
}
```

二者进入同一个 Workbench runtime，并保存 prompt、raw provider output、normalized result 与状态变化。

项目角色调用会把已接入项目的 `rootPath` 作为 Provider 工作目录；materialized manifest 仍只负责解析角色、Skill 和 Schema 文件。两者不会混用，因此员工可以在目标仓库执行 Git、测试和构建，同时 Run 证据继续落在 Workbench 数据目录。

## `cart-fe-workflow-review` 示例

仓库提供：

- `templates/workbench/cart-fe-workflow-review.project.yaml`
- `templates/workbench/cart-fe-workflow-review.binding.json`
- `templates/workbench/browser-e2e-validation.skill.json`
- `templates/workbench/interaction-state-completeness.skill.json`
- `templates/workbench/xiaomixiang-tester.employee.json`

示例把产品、设计和测试三个项目角色分别关联到小米汪、小狐和小米象。设计角色启用 `hallmark` 与 `interaction-state-completeness`，后者负责展开态、浮层边界和键盘路径等容易被静态稿遗漏的细节；其他项目风格 Skill 仍不会被自动带入。测试角色启用 `browser-e2e-validation`。三个角色分别追加产品、设计和质量 Knowledge Profile；可执行种子见 [`templates/workbench/knowledge/`](../templates/workbench/knowledge/README.md)。

## 当前仓库的全部员工接入

仓库根目录的 `multi-agent.project.yaml` 为全部活跃员工声明项目角色，角色策略位于 `docs/project-roles/`。员工身份没有复制进项目声明；任用种子保存在 `templates/workbench/local-agent-workbench.binding.json`。

| 项目角色 | 当前员工 |
| --- | --- |
| `product-manager` | `xiaomiwang-product-manager` |
| `product-designer` | `lin-mo-product-designer` |
| `frontend-developer` | `mihuhu-frontend-engineer` |
| `backend-developer` | `huotuizhu-product-manager` |
| `fullstack-developer` | `yaoxi-programmer` |
| `test-engineer` | `xiaomixiang-tester` |
| `knowledge-steward` | `local-agent-workbench-knowledge-steward`（项目内部） |
| `configuration-steward` | `local-agent-workbench-configuration-steward`（项目内部） |

```bash
npm run cli -- workbench employee create templates/workbench/mihuhu-frontend-engineer.employee.json
npm run cli -- workbench project connect .
npm run cli -- workbench skill-create templates/workbench/configuration-control-conversation.skill.json
npm run cli -- workbench employee create templates/workbench/configuration-steward.employee.json
npm run cli -- workbench project bind local-agent-workbench templates/workbench/local-agent-workbench.binding.json
npm run cli -- workbench project invoke local-agent-workbench frontend-developer "完成当前前端开发任务"
```

项目内部 Employee 固定项目版本。项目声明升级后，用 `workbench employee repin-project <employee-id>` 显式生成 Employee 新版本，再保存新 Binding；旧 Session 与旧 Binding 仍固定原版本。

每个角色的项目权限会与 Employee 权限共同收窄；产品、设计和测试保持只读，三个开发角色可以按各自边界写入项目。直接调用 Employee 不会自动获得项目策略；项目工作应使用 `invoke_project_role`。

Employee 档案不是单工执行槽。同一个 Employee 的不同调用会创建隔离的 Work Instance，可以并发运行；只有共享同一 Session 的调用才会为了上下文顺序串行。需要额外员工的判断依据是能力、权限或独立性缺口，而不是同一身份的调用数量。
