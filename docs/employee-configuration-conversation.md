# 对话式 Employee 配置

## 目标

Employee 配置以版本化结构数据为唯一事实来源，但日常维护不要求用户填写一张完整大表单。管理台提供两个入口，它们操作的是同一份模型：

1. **AI 对话起草**是默认入口。用户描述目标与不能改变的边界，项目内配置管家读取当前 Employee，并生成冻结的 `ConfigurationProposal`。
2. **高级表单**是精确查看、人工微调与排障入口，不承担主要录入工作。

AI 负责把自然语言编译为候选配置，人负责判断候选是否正确；对话、提案、审阅和生效是四个不同动作。

## 使用流程

在 Employee 档案页点击“AI 对话起草”：

1. 左侧对话只关联当前 Employee，不复用其他 Employee 的 Session。
2. 配置管家只能读取当前 Employee、Provider、Skill 和已有 Proposal，并创建严格类型化 Proposal。
3. 右侧按身份、提示词、Skill、运行时、权限等语义组展示 before / after。
4. 人工逐项接受或拒绝；系统没有“一键全部接受”。
5. 全部审阅且至少接受一项后，人工显式应用；系统一次性生成一个 Employee 新版本。

旧 Session 与 Project Binding 继续固定旧版本。若目标 Employee、Provider 或 Skill 依赖在审阅期间变化，Proposal 进入 `needs-reapproval`，不会自动 rebase。

## 一次性启用

内置受限 Provider 会随 Workbench state 自动补齐。首次使用需要注册配置 Skill、内部 Employee，并刷新当前项目任用：

```bash
npm run cli -- workbench project connect .
npm run cli -- workbench skill-create templates/workbench/configuration-control-conversation.skill.json
npm run cli -- workbench employee create templates/workbench/configuration-steward.employee.json
npm run cli -- workbench project bind local-agent-workbench templates/workbench/local-agent-workbench.binding.json
```

必须先连接项目，Employee 模板才能把项目作用域固定到当前项目版本。若内部 Employee 已存在，而项目因新增角色或策略升级了版本，先显式生成一个重新固定作用域的 Employee 新版本，再重绑：

```bash
npm run cli -- workbench employee repin-project local-agent-workbench-configuration-steward
npm run cli -- workbench project bind local-agent-workbench templates/workbench/local-agent-workbench.binding.json
```

配置管家必须通过项目角色 `local-agent-workbench/configuration-steward` 调用，不能绕过项目策略直接调用 Employee。

## 控制边界

- Proposal 只支持有限语义操作，不接受 JSON Patch、任意 path 或未知字段。
- Core 重新校验 Provider、Skill、Schema、权限与候选 Employee，并设置每类操作的最低风险等级；不信任 AI 自报风险。
- AI 没有 review、apply、Employee PATCH、Shell 或文件写入工具。
- 项目角色要求系统签发的 `configuration-proposal-only` Provider runtime profile；不兼容的 Employee / Provider 无法保存任用，也不会进入调用阶段。
- Knowledge 内容和授权仍由 `KnowledgeChangeRequest` 管理，不混入 Employee 配置 Proposal。
- 无实际差异的操作不会创建 Proposal，也不会制造空版本。
- 提案与决定保留来源、目标版本、plan hash 和追加式审阅记录；每次逐项决定与最终应用都用 review revision/hash 做并发校验。
- 来源 Run 若最终失败、阻塞或取消，Proposal 会进入 `needs-reapproval`；已生效的历史结果不会因迁移回滚，但审计证据损坏会被明确标记。

当前第一阶段只处理一位既有 Employee。项目角色绑定的对话式配置可以复用同一套 Proposal / Review / Apply 框架，但应作为独立目标类型扩展，而不是把项目配置复制进 Employee。
