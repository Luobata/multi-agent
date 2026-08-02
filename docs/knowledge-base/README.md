# Knowledge Base

这个目录集中维护 Local Agent Workbench 的知识库领域设计、运行边界和交付计划。知识库不是 Skill、Employee 或 Architecture Adapter：它是独立的内容控制面与检索运行时，向 Employee 提供带来源、版本和访问范围的证据。

## 核心结论

- `Skill` 说明员工“怎样做”；Knowledge 说明员工“可以依据什么事实做”。
- Employee 不与每个知识库建立笛卡尔积关系，而是引用少量可复用的 `KnowledgeProfile`。
- `KnowledgeResolver` 负责确定性地计算允许参与本次任务的知识范围。
- `KnowledgeRouter` 只能在 Resolver 的候选范围内缩小 Collection 集合；首版使用可复现的规则与词项相关度，不调用额外 Agent。
- `KnowledgeRetriever` 从已发布 Revision 的独立索引中检索证据。
- 全量内容通过 Wiki 视图浏览；员工视角则分开呈现“已授权、当前任务已激活、最终被选中”三层范围。
- 正文使用可读的 Markdown 文本，结构、来源、层级和引用保存为独立字段，不把所有语义都塞进一段纯文字。
- URL 导入是受限的快照流程：抓取并结构化预览、冻结哈希、人工选择关系、生成待审批草稿；不会直接发布。
- 关系采用混合维护：来源、父子层级和人工确认的强关系在写入时固化；语义相似等弱关系按需派生，最多展示 5 个候选，不自动写回。
- 每个 Work Instance 都生成 `KnowledgePlan`，并把计划、排除原因、命中证据和内容版本写入 Run Store。
- Profile 是长期配置；每次任务的 Plan 是临时结果。运行结果不会自动反向修改 Employee 或 Profile。
- Employee 的 Profile 调整只能形成 `KnowledgeChangeRequest`，由人批准后生效；授权理由、负责人、到期时间和复核周期进入台账。

## 文档导航

- [architecture.md](architecture.md)：领域模型、控制面/运行面、员工状态与安全边界。
- [operations.md](operations.md)：知识控制台子 Tab、新增、同步、质检、发布、授权和回滚操作。
- [conversation-control.md](conversation-control.md)：Codex 对话员工、受限 MCP、KnowledgeChangeRequest 与人工审批边界。
- [delivery-plan.md](delivery-plan.md)：首版范围、文件布局、验收与后续演进。
- [wiki-directory-navigation.md](wiki-directory-navigation.md)：Wiki 目录层级、搜索、键盘导航与状态验收。

## 首版调用链

```text
Employee / Project Role Profile ids
                 +
Invocation context / current access / published revisions
                 ↓
        KnowledgeResolver
                 ↓
         eligible Collections
                 ↓
         KnowledgeRouter
                 ↓
           KnowledgePlan
                 ↓
        KnowledgeRetriever
                 ↓
 evidence with citation ids → Employee prompt → Run Store
```

首版采用“少量证据预加载”。以后增加 `knowledge.search` 工具时，工具仍必须在冻结的 Knowledge Plan 与实时权限检查内运行。Wiki 的关系候选只辅助维护，不会扩大 Resolver 的授权范围。

知识后台的管理对话属于控制面：Codex 只能通过受限 MCP 读取状态和生成待人工审核的 `KnowledgeChangeRequest`，不会参与 Resolver、Router 或 Retriever 的运行时授权判断。
