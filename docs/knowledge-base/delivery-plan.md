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
- 全量 Wiki、文档层级、显式引用、反向引用与有限弱关系候选；
- 受限 URL 抓取、结构化预览、冻结哈希和草稿提案；
- 员工知识视角（eligible / activated / selected）与近期 Run 证据；
- 带理由、负责人、期限和复核周期的授权台账；
- 当前示例员工的 Profile 配置模板；
- mock Provider 全链路与回归测试。

## Phase 2：完整知识控制台

在同一个“知识控制台”入口下提供八个独立子 Tab：

- 总览：治理队列、版本待办、Profile 覆盖与失效引用；
- 知识目录：KnowledgeBase、Collection、Source 与内容维护；
- 全量 Wiki：发布版/最新草稿的文档树、正文、来源、显式引用与有限候选；
- 发布车道：Revision 历史、草稿质检、检索试跑、显式发布和回滚；
- 知识 Profile：完整的多规则策略编辑；
- 影响与授权：KnowledgeBase → Profile → Employee / Project Role 的解释视图；
- 授权复核：reminder-only 台账与受控调整提案；
- AI 管理：受限 Codex 会话、提案与人工审批。

控制面同时提供 Revision Assessment、Draft Preview 和 Impact Snapshot API。首份人工内容默认只生成草稿，发布前必须经过质量与影响确认。

## 非目标

- 向量数据库和 Embedding 服务；
- 模型绕过 ChangeRequest 与人工审批自主修改 Profile；
- Employee 直接写入已发布知识；
- 外部 SaaS Connector 或持续爬虫（当前 URL 能力是受限的一次性快照）；
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
  documents.ts   Wiki、显式引用、反向引用与有限关系候选
  impact.ts      授权关系与影响范围解释
  types.ts       领域契约
  store.ts       Revision 与索引文件
  urlFetcher.ts  带 SSRF、大小、类型、超时和跳转边界的 URL 抓取
  urlImport.ts   HTML 到 Markdown 文档树的结构化转换
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
18. 全量 Wiki 可在发布版和最新草稿间切换，并展示文档树、显式引用和反向引用。
19. 弱关系候选不持久化、全局最多 5 个；只有人工选择的类型化关系进入 Revision。
20. URL 预览冻结内容哈希；页面或目标版本变化时提案失败并要求重新预览。
21. URL 提案获批后只生成未发布 Revision，审批阶段不访问网络。
22. 员工视角可解释 eligible / activated / selected 及其 Profile、规则和原因。
23. 员工档案编辑不能直接改知识授权；授权调整只生成待人工批准的 ChangeRequest。
24. 复核台账只提醒；保留、收窄和撤销均不会自动执行。

当前可执行种子与员工映射位于 [`templates/workbench/knowledge/`](../../templates/workbench/knowledge/README.md)。模板只声明 KnowledgeBase、Profile 和映射关系，不把员工角色硬编码到 `src/`。

## 后续演进

- 增加 Hybrid/BM25/Embedding Retriever Adapter；
- 增加受约束 Provider Router；
- 增加 `knowledge.search` 工具与 Plan 内多轮检索；
- 从 Run 反馈生成 Profile 改进提案；
- 在文档被实际引用或维护者复核时，把高价值弱候选转为显式关系；
- 为发布 Revision 增加固定问题集和检索质量门禁；
- 将高容量知识元数据迁移到 SQLite 或外部索引服务。
