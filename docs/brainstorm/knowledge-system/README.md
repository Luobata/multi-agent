# 知识体系脑暴记录

> 状态：纯规划 / 持续脑暴
> 建立时间：2026-08-02
> 适用范围：知识创建与接入、个人知识库、Employee / Project Role 知识关联、员工运行时查询
> 实施约束：本文不是最终技术方案，不能据此直接推进改造。只有用户明确确认并要求同步后，才整理为正式方案和实施计划。

## 1. 文档目的

这个目录用于持续记录知识体系脑暴中已经认可、当前倾向和仍待确认的设计。

记录原则：

- 先沉淀问题、概念和边界，不急于映射成代码改动。
- 明确区分“已认可”“当前倾向”“待确认”，避免脑暴内容被误当成定稿。
- 管理员视角和 Employee 使用视角需要同时成立。
- 不把知识管理、Skill、Employee、Project Role、Provider、MCP 和 CLI 混成同一层。
- 最终确认后，再从本文抽取正式领域模型、交互方案、迁移方案和实施阶段。

## 2. 当前关注范围

当前优先讨论：

1. 如何导入、引用和持续访问外部知识库。
2. 如何创建由人类管理员拥有的个人知识库。
3. 如何让个人知识库和外部知识与 Employee / Project Role 建立清晰关联。
4. Employee 在工作过程中如何自动或主动查询知识。
5. 外部知识如何通过 MCP、CLI 或其他 Connector 被统一访问。

当前不作为重点：

- 扩展知识发布、审批和回滚车道。
- 自动删除低使用率知识。
- 大型向量检索或完整知识图谱。
- 直接推进代码改造。

## 3. 已认可的基础方向

### 3.1 管理员不是把知识逐篇灌给 Employee

管理员应让 Employee 订阅少量稳定的知识包，而不是维护 Document → Employee 的大量直接关系。

```text
知识来源
  → KnowledgeBase / Collection
  → 知识包（底层可继续复用 KnowledgeProfile）
  → Employee 基础订阅 / Project Role 项目订阅
  → 单次 KnowledgePlan
```

知识正文可以持续扩充，Employee 只需要维持少量稳定订阅。

### 3.2 个人知识库由人拥有，不由 Employee 拥有

“个人知识库”采用以下语义：

- Owner 是当前人类用户或管理员。
- Employee 是知识订阅者和使用者，不是知识所有者。
- 创建个人知识库不会自动授权任何 Employee。
- Employee 自动形成的记忆或成长档案属于另一套记忆系统，不与个人知识库混用。

个人知识库至少需要区分：

```text
Owner：谁负责管理
Visibility：谁能发现或查看目录
Subscription：哪些 Employee / Project Role 能在运行时使用
Classification：知识本身的敏感等级
```

建议默认值：

```text
Owner: current-user（当前单用户阶段可映射为 local-owner）
Visibility: private
Subscriptions: []
```

### 3.3 Employee 长期身份与项目知识分离

- Employee 基础订阅只放跨项目、安全、长期稳定的知识。
- 公司内部、敏感或项目特定知识优先由 Project Role 临时叠加。
- 同一个知识包原则上不同时重复绑定到 Employee 和 Project Role。
- 关联到 Employee 时，必须明确提醒它会影响直接调用和所有项目任用。
- 关联到 Project Role 时，只在对应项目角色上下文生效。

### 3.4 Skill 与 Knowledge 分层

```text
Role：你是谁
Skill：你怎么做
Knowledge：你依据什么做
Config：本次任务的具体参数
Core / Tool：如何确定性执行和校验
```

- Skill 保存稳定、可复用的工作方法、工具步骤、输入配置、输出契约和检查清单。
- Knowledge 保存有来源、版本、权威性，会更新、重复或冲突的事实、案例、规范和素材。
- 混合内容应拆成精简 Skill + Knowledge Pack。
- Skill 可以声明 required / optional 知识依赖，但不能因此自动扩张知识授权。

示例：

```text
pixel-art-design Skill
  → 需求分析、网格与色板方法、工具步骤、QA、输出契约

anime-pixel-style-reference 知识包
  → 风格分类、案例、色板、公司资产、平台限制、踩坑与来源
```

## 4. 模块一：Employee 查询知识

### 4.1 模块目标

Employee 需要一个统一、只读、受控的知识查询入口，无论知识来自：

- 本地 Revision 和索引；
- 个人知识库；
- Figma 设计稿；
- 飞书文档；
- Git、本地目录或网页；
- 其他通过 MCP、CLI 或 API 接入的外部知识源。

Employee 不应该感知不同来源的访问方式，也不应该直接获得外部凭证和通用工具权限。

### 4.2 当前认可的入口形态

Employee 统一使用只读 Knowledge Runtime 能力：

```text
knowledge_search
knowledge_open
knowledge_scope（可选，待继续确认）
```

它可以通过独立的 Knowledge Runtime MCP 暴露，但核心权限、路由、预算和审计必须由 TypeScript Core / Knowledge Runtime 执行。

管理员控制面与员工运行面分开：

```text
knowledge-control
  → 创建、接入、关联、影响预览和治理

knowledge-runtime
  → search、open，以及可选的 scope 解释
```

### 4.3 调用链

```text
Employee Invocation
        ↓
调用者 / Employee / Project Role 权限交集
        ↓
冻结当前 KnowledgePlan
        ↓
knowledge_search
        ↓
Knowledge Router
        ↓
Knowledge Connector Runtime
├── Local Index Adapter
├── Figma MCP Adapter
├── Lark CLI Adapter
├── Git / File Adapter
└── HTTP / API Adapter
        ↓
Normalized Evidence
        ↓
Run Store + Employee Prompt
```

### 4.4 自动检索与主动检索结合

Employee 不应被要求每次都手动查知识。

建议采用两层模型：

1. 自动预加载：Provider 调用前，根据请求自动检索少量高相关 Evidence。
2. 主动查询：Employee 判断证据不足时，调用 `knowledge_search` 继续查找，再用 `knowledge_open` 获取完整内容。

```text
用户请求
  → 自动预加载少量 Evidence
  → Employee 开始推理
  → 发现证据不足
  → knowledge_search
  → knowledge_open
  → 输出带 Citation 的结果
```

### 4.5 `knowledge_search` 的建议职责

建议输入保持简单：

```json
{
  "query": "查找购物车空态的设计规范",
  "intent": "find-design",
  "sourceHints": ["公司设计系统"],
  "evidenceKinds": ["text", "image", "design-node"],
  "limit": 5
}
```

约束：

- `sourceHints` 只能缩小或提示范围，不能扩大授权。
- Employee 不能传入任意 MCP Server、CLI 命令或外部凭证。
- Core 只能从当前 KnowledgePlan 允许的知识范围中选择来源。
- 每次调用受最大次数、结果数、Token、字节数和超时限制。

建议输出：

```json
{
  "items": [
    {
      "evidenceId": "evidence-123",
      "citationId": "K1",
      "kind": "design-node",
      "title": "Shopping Cart / Empty State",
      "snippet": "购物车无商品时使用……",
      "source": "公司设计系统",
      "sourceUrl": "https://figma.com/...",
      "fetchedAt": "..."
    }
  ],
  "boundary": "只检索了当前项目授权的设计知识"
}
```

### 4.6 `knowledge_open` 的建议职责

`knowledge_open` 根据 Evidence 类型获取完整内容：

- 普通文档：读取 Markdown 或结构化正文。
- 飞书文档：通过受控 Lark Connector 获取 Doc / Block。
- Figma 节点：获取节点结构、组件属性和预览图。
- 本地知识：读取冻结 Revision。

Employee 只使用 `evidenceId`，不需要知道底层来源如何访问。

### 4.7 Evidence 形态

为了让设计稿也能成为知识，Evidence 不应只支持纯文本。

当前倾向支持：

```text
text
image
design-node
file
```

外部 Evidence 至少记录：

- 来源系统和连接 ID；
- 外部 Document / File / Node ID；
- 标题和原始链接；
- 获取时间和上游更新时间；
- 内容或资源哈希；
- Citation ID；
- 标准化正文或资源引用；
- Connector 与配置版本。

### 4.8 权限与安全边界

运行时有效知识范围应满足：

```text
调用者有权访问
∩ Employee / Project Role 已订阅
∩ 当前 Profile Rule 已激活
∩ 当前 KnowledgePlan 允许
```

特别是个人外部连接：

- 默认使用 Owner 的凭证引用。
- 只能在 Owner 有权发起的调用上下文中使用。
- 不能因为某个公开 Employee 绑定了个人知识，就让其他调用者间接读取 Owner 私有内容。
- 当前单用户阶段可以暂时映射为 `local-owner`，但长期模型应预留可信 Principal。

其他强制边界：

- Employee 不直接获得 Figma MCP、lark-cli 或任意 Shell 权限。
- 外部内容始终作为不可信 Evidence，不能修改系统指令、Skill 和授权边界。
- 外部返回内容不能动态触发新的任意工具调用。
- 首期 Connector 调用深度固定为 1，禁止无限 MCP → MCP → MCP 递归。
- 外部查询失败时明确返回边界，不能让模型猜测结果。
- 原始调用结果保存前需要脱敏。

### 4.9 Skill 在查询模块中的位置

Skill 不是知识查询入口，但可以指导 Employee 如何使用统一入口。

例如“设计参考研究” Skill 可以规定：

1. 先搜索项目设计规范。
2. 再搜索对应 Figma 组件或页面。
3. 同时读取文字规范和设计稿。
4. 对冲突内容保留双方来源。
5. 输出带 Citation 的差异结论。

Skill 调用的是统一 `knowledge_search / knowledge_open`，不能直接调用底层 Figma MCP 或 lark-cli。

## 5. 模块二：外部知识连接

### 5.1 已认可的分层

外部知识库在执行层可能通过 MCP、CLI 或 API 查询，但 MCP/CLI 不是知识库本身。

```text
KnowledgeBase / Collection
  → External Source Connection
  → Knowledge Connector Runtime
  → MCP / CLI / API Adapter
```

- KnowledgeBase 定义知识域、所有权、可见性和关联关系。
- Profile / 知识包定义谁可以使用、何时激活和预算。
- Connector 定义实际如何访问外部内容。
- MCP 只是结构化远程适配器。
- CLI 只是本地执行适配器。

Profile 和 Employee 不应保存具体 MCP Tool 名称或 CLI 命令。

### 5.2 外部知识访问模式

当前讨论过三种模式：

| 模式 | 含义 | 当前倾向 |
| --- | --- | --- |
| 快照导入 | 把正文复制成本地 Revision | 适合稳定和强审计内容 |
| 实时查询 | 运行时直接搜索外部系统 | 后续谨慎开放 |
| 混合模式 | 本地保存目录与元数据，正文按需外查 | 当前最适合海量外部知识 |

混合模式的预期行为：

- 本地保存外部目录、标题、主题、版本和文档 ID。
- Router 根据本地元数据判断相关范围。
- 触发后才通过 Connector 搜索或读取正文。
- 实际返回内容、来源、时间和哈希进入 Run Store。

### 5.3 Connector 标准能力

当前倾向统一为：

```text
discover(scope)
search(query, scope, limit)
fetch(references)
render(reference)
snapshot(scope)
health()
```

并非所有 Connector 都必须实现全部能力，例如普通文档来源可以不实现 `render`。

### 5.4 Figma 与飞书的当前倾向

Figma：

- 优先使用 Figma MCP Adapter。
- 支持 File / Page / Node 的发现、搜索、读取和渲染。
- 输出文本、图片和 design-node Evidence。

飞书：

- 当前阶段可先使用受控 lark-cli Adapter。
- 只允许搜索、读取等只读白名单操作。
- 固定可执行文件和参数数组，不通过自由 Shell 字符串执行。
- 未来多人服务化后可替换成 OpenAPI 或 MCP Adapter。

## 6. 模块三：知识库与 Employee 关联

### 6.1 管理员体验

管理员不应被迫先理解复杂 Profile Rule。

产品层建议提供两个双向入口：

```text
知识库详情 → 关联 Employee / Project Role
Employee 详情 → 添加知识库
```

底层仍通过 KnowledgeProfile 和 KnowledgeGrant 执行，保持领域边界。

### 6.2 快速关联

快速关联只要求管理员选择：

1. 目标 Employee 或 Project Role。
2. 整个 KnowledgeBase 或指定 Collection。
3. 所有项目还是指定项目。
4. `core / conditional / on-demand`。
5. 授权理由和可选复核周期。

推荐默认值：

- 激活方式：`on-demand`。
- 个人、内部或敏感知识：优先关联 Project Role。
- 全局 Employee 关联：必须显式确认影响范围。

产品层可以自动创建或复用受管理的知识包，但不建立直接 Document → Employee 关系。

### 6.3 同一知识对不同角色可以有不同策略

```text
同一个设计系统 Collection
├── 产品设计师：core
├── 前端开发：conditional / on-demand
├── 后端开发：不授权
└── 外部项目：不授权
```

`core / conditional / on-demand` 是知识与知识包之间的使用策略，不是知识内容自身的固定属性。

## 7. 模块四：AI-first 知识创建与人工 Review

### 7.1 已确认的产品原则

AI 时代不应要求管理员通过复杂表单完成知识创建、归类和关联。

正确分工是：

```text
Human：表达意图、补充关键业务边界、Review、纠正和批准
AI：读取来源、理解内容、创建结构、生成关联、形成完整提案
Core：确定性校验、权限检查、影响计算和执行
Ledger：保存提案、修订、Review、批准和执行证据
```

一句话原则：

> 表单可以消失，但底层 Schema 不能消失；AI 负责填写结构，人负责 Review 结构。

### 7.2 AI 是知识创建者，人是 Reviewer

管理员可以只提供自然语言、链接、文件或外部知识空间：

```text
“把这个 Figma 项目作为小狐狐在 Project A 的设计参考，组件规范可以跨项目使用。”
```

AI 应主动完成：

1. 读取并理解外部来源。
2. 发现文件、页面、目录和节点范围。
3. 识别 Owner、主题、版本、平台和项目适用性。
4. 建议或创建 KnowledgeBase 与 Collection 草稿。
5. 检查精确重复、相似内容和冲突候选。
6. 生成 Source Mapping Rule。
7. 生成知识包和 Employee / Project Role 关联建议。
8. 选择合理的 `canonical/reference/experimental`。
9. 选择合理的基础/专业/项目/任务层级。
10. 选择合理的 `core/conditional/on-demand`。
11. 计算下游影响、风险和知识预算。
12. 生成一个完整、可修改、可审阅的知识变更提案。

人不需要逐字段填写上述内容。

### 7.3 推荐交互：Knowledge PR

知识创建应类似代码 Pull Request：

```text
用户表达意图或提供来源
  → AI 生成 Knowledge PR
  → Core 校验并补充影响
  → 人查看摘要、证据、Diff 和风险
  → 人用自然语言要求修改，或批准 / 拒绝
  → AI 重新编译提案
  → Core 确定性执行
```

AI 拥有创建和修改草稿的权限，但没有自我批准和直接生效的权限。

### 7.4 Review 界面应该展示什么

默认 Review 不展示完整技术表单，而展示面向决策的摘要：

- 来源是什么、读取了哪些范围。
- AI 生成了哪些 KnowledgeBase 和 Collection。
- Owner、Visibility、Classification 和 Authority。
- 发现了哪些重复、冲突和替代关系。
- 将关联哪些知识包、Employee 和 Project Role。
- 哪些知识会成为基础层或 `core`。
- 预计影响多少员工、项目和调用场景。
- 使用哪些个人凭证或外部连接。
- 检索试跑和代表性样例。
- 风险、警告和仍不确定的事项。

用户操作保持简单：

```text
批准
拒绝
要求 AI 修改
查看高级结构
```

高级结构和完整 Schema 只在需要精确调整或审计时展开。

### 7.5 人通过自然语言修正，而不是返回表单

例如 AI 提案：

```text
公司设计系统
  → 组件、Token、业务页面全部关联到小狐狐基础层
```

管理员可以直接回答：

```text
“组件和 Token 可以作为小狐狐的跨项目专业知识，业务页面只给 Project A，全部按需查询，不要 core。”
```

AI 将这句话重新编译成结构化修改：

```text
components / tokens
  → employee layer: professional
  → activation: on-demand

business pages
  → project role: Project A / designer
  → activation: on-demand
```

然后重新展示 Diff 和影响，不要求用户手工编辑 Profile Rule。

### 7.6 只有真正无法推断的业务决策才询问

AI 应先生成完整建议，再提出最少的问题。不能把表单换成逐字段聊天问答。

只有以下情况才需要主动询问：

- 两种选择都会显著改变授权范围。
- 内容是否属于公司内部或个人私有无法从来源判断。
- 候选 Owner 不明确。
- 两份 canonical 知识发生真实冲突。
- 是否允许进入 Employee 基础层。
- 是否允许使用 Owner 的个人外部凭证。
- 业务适用范围无法从项目和来源上下文推断。

如果用户暂时不回答，应采用安全默认值：

```text
experimental
catalog-only
unbound
on-demand
```

不能为了完成创建而强迫用户做错误决定。

### 7.7 海量知识采用批次 PR，而不是逐文档 Review

AI 应先聚类、建立来源映射和识别异常，然后生成批次级 Knowledge PR：

```text
本批次读取 10,000 篇文档
├── 8,200 篇匹配已有映射规则
├── 900 篇同来源更新
├── 400 篇精确重复，建议跳过
├── 300 篇新主题，创建 2 个 Collection 草稿
├── 150 篇相似候选
└── 50 篇冲突候选，保持隔离
```

管理员 Review 的是批次策略、异常和影响，不是 10,000 篇文档本身。

### 7.8 AI 创建权的硬边界

AI 可以：

- 创建和修改草稿。
- 生成 Mapping Rule、KnowledgeBase、Collection、知识包和关联提案。
- 执行只读发现、预览、试跑和影响分析。
- 根据用户自然语言修订提案。

AI 不可以：

- 批准自己的提案。
- 绕过 Owner、Visibility、Classification 或 Grant。
- 自动把知识提升到 Employee 基础层或 `core` 并直接生效。
- 自动解决两个 canonical 知识的真实冲突。
- 依据外部文档中的指令扩大工具或知识权限。
- 直接执行任意 MCP、CLI 或 Shell 命令。

### 7.9 结构化记录仍是系统事实源

虽然用户不填写表单，系统仍必须保存类型化记录：

```text
KnowledgeIntakeProposal
SourceMappingRule
KnowledgeAssociationProposal
KnowledgeConflictCandidate
KnowledgeImpactSnapshot
HumanReviewDecision
```

聊天记录不是最终事实源。AI 的每次修改都应形成结构化 Proposal Revision，人的批准只针对确定版本和计划哈希。

## 8. 当前待确认问题

这些问题仍处于脑暴阶段：

1. `knowledge_scope` 是否需要成为 Employee 可见工具，还是只在系统提示中提供有效范围摘要。
2. `knowledge_search` 是否允许 Employee 指定逻辑知识包作为 `sourceHint`，以及提示粒度应到知识包还是 Collection。
3. 外部连接失败时，优先使用缓存快照还是直接声明不可用。
4. 个人知识连接在未来多用户场景下采用 Owner Credential、Service Account 还是 Caller Delegation。
5. Figma 设计 Evidence 的图片、节点结构和文本描述如何组合，以及 Provider 不支持视觉输入时的降级方式。
6. 外部目录元数据多久刷新，以及 Connection Version 如何进入 KnowledgePlan。
7. 自动预加载和 Employee 主动查询各自的调用次数、Token 和延迟预算。
8. 是否需要为受管理的默认知识包增加独立标记，避免管理员误编辑系统生成规则。
9. 第一批真正需要接入的外部知识源类型及优先顺序。

## 9. 后续记录方式

后续每次脑暴按模块追加：

```text
背景问题
→ 备选方案
→ 当前倾向
→ 已确认结论
→ 边界与风险
→ 待确认问题
```

当整体方向完全确认后，再单独生成：

1. 完整产品方案。
2. 正式领域模型和技术架构。
3. 管理员与 Employee 交互设计。
4. 数据兼容与迁移方案。
5. 分阶段实施计划和验收标准。
