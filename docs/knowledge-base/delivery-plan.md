# Knowledge Base Delivery Plan

## Phase 1：可运行知识闭环

本阶段实现：

- KnowledgeBase 与 KnowledgeProfile 注册、修订和归档；
- Manual Document、本地 File/Directory Source；
- 增量入口采用“重新采集 Source，生成不可变 Revision”；
- Revision 发布和回滚；
- 独立的 Revision 与词项索引文件；
- Employee 与 Project Role Profile 引用；
- 确定性 Resolver、Router、Retriever；
- Provider 调用前预加载 Evidence；
- Context Inspector 和 Run Artifact 展示；
- 知识库管理页面、Profile 管理与员工知识档案；
- 当前示例员工的 Profile 配置模板；
- mock Provider 全链路与回归测试。

## Phase 2：完整知识控制台

在同一个“知识控制台”入口下提供五个独立子 Tab：

- 总览：治理队列、版本待办、Profile 覆盖与失效引用；
- 知识目录：KnowledgeBase、Collection、Source 与内容维护；
- 发布车道：Revision 历史、草稿质检、检索试跑、显式发布和回滚；
- 员工 Profile：完整的多规则策略编辑；
- 影响与授权：KnowledgeBase → Profile → Employee / Project Role 的解释视图。

控制面同时提供 Revision Assessment、Draft Preview 和 Impact Snapshot API。首份人工内容默认只生成草稿，发布前必须经过质量与影响确认。

## 非目标

- 向量数据库和 Embedding 服务；
- 模型绕过 ChangeRequest 与人工审批自主修改 Profile；
- Employee 直接写入已发布知识；
- 外部 SaaS Connector；
- 部门树、复杂 deny/allow 优先级和逐文档 ACL；
- Agent 多轮 `knowledge.search` 工具调用。

## Phase 3：项目内知识管理对话

- 项目内部 `Knowledge Steward` Employee，只允许通过当前项目 Role 调用；
- 默认 Codex Provider 使用根目录拒读的独立只读 workspace、非交互审批策略和独立 MCP 配置；
- `knowledge-control` MCP profile 仅包含读取、质检、试跑、影响和提案工具；
- KnowledgeChangeRequest 固定目标版本、质量结果、影响范围与计划哈希；
- 审批和执行不暴露给 LLM，由后台人工动作触发；
- 知识控制台提供会话、提案卡和审批队列。

## 代码布局

```text
src/knowledge/
  assessment.ts  Revision 发布前确定性质检
  change.ts      变更风险、计划哈希与状态判断
  impact.ts      授权关系与影响范围解释
  types.ts       领域契约
  store.ts       Revision 与索引文件
  resolver.ts    Profile/上下文/状态解析
  router.ts      Collection 路由
  retriever.ts   Chunk 检索与引用
  runtime.ts     单次 Knowledge Plan 编排

docs/knowledge-base/
  README.md
  architecture.md
  operations.md
  delivery-plan.md
```

## 验收

1. 用户可创建含 Collection、Document 和 Source 的知识库。
2. 同步产生新 Revision，发布前不影响 Employee。
3. 发布或回滚后，后续调用使用指定 Revision。
4. Employee 仅引用少量 Profile；项目角色可临时追加 Profile。
5. Resolver 不返回归档、未发布或不匹配规则的 Collection。
6. Router 不能选择 Resolver 范围外的 Collection，并遵守预算。
7. 调用 Prompt 包含带 Citation 的相关 Evidence，不包含无关 Collection。
8. Run Store 保存 Plan 与 Evidence，Context Inspector 可查看。
9. 现有无 Knowledge Profile 的 Employee 继续正常运行。
10. `npm run check` 通过，所有示例仍可使用 mock Provider。
11. 草稿 Revision 可在不发布、不调用 Provider 的情况下独立试跑。
12. 空 Revision 被发布门禁阻止，警告项在发布确认中可见。
13. 多规则 Profile 可完整新增、编辑和删除规则。
14. 影响视图可解释每座知识库通过哪些 Profile 到达哪些员工和项目角色。
15. Knowledge Control MCP 不暴露批准或直接执行工具。
16. Codex 对话只能创建等待人工审批的 KnowledgeChangeRequest。
17. 项目内部 Knowledge Steward 不能被其他项目绑定、直接调用或发布。

当前可执行种子与员工映射位于 [`templates/workbench/knowledge/`](../../templates/workbench/knowledge/README.md)。模板只声明 KnowledgeBase、Profile 和映射关系，不把员工角色硬编码到 `src/`。

## 后续演进

- 增加 Hybrid/BM25/Embedding Retriever Adapter；
- 增加受约束 Provider Router；
- 增加 `knowledge.search` 工具与 Plan 内多轮检索；
- 从 Run 反馈生成 Profile 改进提案；
- 为发布 Revision 增加固定问题集和检索质量门禁；
- 将高容量知识元数据迁移到 SQLite 或外部索引服务。
