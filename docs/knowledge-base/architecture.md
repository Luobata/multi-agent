# Knowledge Base Architecture

## 1. 分层

### 控制面

控制面面向用户，负责：

- 注册知识库和 Collection；
- 配置本地文件或目录 Source，或从受限 URL 生成一次性结构化快照；
- 创建内容 Revision；
- 通过 Wiki 浏览文档树、显式引用、反向引用和有限的关系候选；
- 查看同步结果并发布或回滚 Revision；
- 管理可复用 Knowledge Profile；
- 通过待审批变更把少量 Profile 授予 Employee 或项目角色，并维护复核台账。

同步只产生新的未发布 Revision，不直接改变员工正在使用的知识。Employee 只读取明确发布的 Revision。

### 运行面

运行面面向一次 Work Instance，负责：

1. 根据 Employee、项目角色、Profile、知识库状态和发布版本解析候选范围；
2. 按 `core / conditional / on-demand` 策略激活 Collection；
3. 在总 Collection、Chunk 和 Token 预算内进行确定性路由；
4. 从发布索引检索证据并分配 Citation ID；
5. 将计划和证据注入当前请求；
6. 把完整结果持久化为 Run 证据。

## 2. 核心实体

### KnowledgeBase

知识库是一个稳定、可寻址的知识域。Definition 保存名称、领域、敏感度、Collection 与 Source，不保存大量正文和 Chunk。

### KnowledgeRevision

Revision 是一次不可变内容快照。正文和检索索引位于独立 Knowledge Store：

```text
<data-root>/knowledge/<knowledge-base-id>/
  revisions/<revision>.json
  indexes/<revision>.json
```

`latestRevision` 表示最新草稿，`publishedRevision` 表示员工可使用的版本。回滚只改变 published 指针，不重写历史 Revision。

### KnowledgeDocument 与 Wiki

Document 采用“正文与结构分离”的格式：

- `content` 保存 Markdown 风格的可读文本，适合编辑、版本比较和检索；
- `title / collectionId / sourceRef / metadata` 保存目录和来源信息；
- `order / parentId` 保存同一 Revision 内的稳定顺序和父子层级；
- `references` 只保存人工确认的类型化关系：`related / supports / contradicts / depends-on / supersedes`。

Wiki 是 Revision 的只读投影，不是第二份内容存储。它从上述字段生成文档树、出向引用和反向引用，同时最多派生 5 个弱关系候选。候选包含分数与信号，但标记为 `persisted: false`；只有人在导入或后续变更中明确选择后，关系才进入 `references`。

这种混合策略避免为每次相似度变化维护整张知识图：写入时固化来源身份、父子层级和已确认强关系；语义相似、标题重合和“可能相关”在查看或导入时按需计算。知识库增长后，持久化复杂度取决于人工确认的边数，而不是文档数量的笛卡尔积。

### URL 快照导入

URL 导入不是常驻爬虫或外部 Connector。流程分三段：

1. 服务端仅抓取 HTTP(S) HTML/XHTML，转为 Markdown 文档，并按页面导语、H2、H3 建立顺序和层级；
2. 预览保存内容哈希、目标知识库版本、基础 Revision 和至多 5 个关系候选；
3. 提案前重新抓取并校验哈希与版本。内容变化时必须重新预览；人工选中的关系随 `knowledge-revision.create` 提案进入未发布草稿。

安全边界包括：禁止 URL 凭据和非 HTTP(S) 协议；每次 DNS 解析及跳转都校验；禁止私网、回环、链路本地、多播、保留地址和常见 IPv4-in-IPv6 绕过；固定解析地址发起请求；10 秒超时、2 MB 上限、最多 5 次跳转、只接收 UTF-8 未压缩 HTML。审批阶段不再访问网络。

### KnowledgeProfile

Profile 是可复用的选择与激活策略。Employee 和 Project Role 只引用 Profile ID，不直接维护大量 KnowledgeBase ID。

Profile Rule 包含：

- Selector：知识库 ID、领域、产品、项目、Collection、权威级别和最大敏感度；
- Activation：`core`、`conditional` 或 `on-demand`；
- Conditions：项目、项目角色、任务标签或请求词项；
- Budget：最大 Collection、Chunk 与 Token 数；
- Priority 与 `required` 标记；`required` 表示预算冲突时优先保留该规则，不会绕过发布、状态、敏感度或相关度门槛。

每条 Selector 必须至少限定 KnowledgeBase、Domain、Product、Project 或 Collection 之一。只写敏感度或权威级别的“全目录 Profile”会被拒绝，避免知识库增长后授权面静默膨胀。
未显式填写信任边界时，安全默认值为 `canonical + reference` 且最高 `internal`；实验内容和更高敏感度必须主动开放。

在管理界面中，这些字段按四个正交维度组织：

1. **目录范围**：KnowledgeBase / Domain / Product / Project / Collection，回答“最多能看哪里”；
2. **信任边界**：Authority 与 Classification，回答“哪些级别允许进入候选”；
3. **激活上下文**：core / conditional / on-demand 及调用项目、角色、标签和请求词，回答“本次为何启用”；
4. **容量预算**：Collection / Chunk / Token 上限及 Priority，回答“最多带多少”。

Employee 只绑定少量 Profile ID。这四个维度由 Profile 统一维护，而不是在 Employee × KnowledgeBase 的每条边上重复配置。

每条绑定同时保存授权元数据：`reason / grantedBy / grantedAt / expiresAt / reviewCycleDays / lastReviewedAt / source`。调整授权时，现有未涉及的绑定元数据原样保留；新增绑定必须给出理由和授权负责人。复核台账只提醒，不会自动续权、收窄或撤权。

`disabled` 不是第四种 Activation，而是 Profile、KnowledgeBase 或绑定的生命周期状态。

### KnowledgePlan

Plan 是一次运行的临时、可解释结果，包含：

- 使用的 Profile 及版本；
- Eligible、Selected 和 Excluded Collection；
- 每个选择或排除的原因；
- 使用的知识库 Revision；
- 检索预算、查询和命中 Citation；
- 路由策略版本。

Plan 不会自动回写长期配置。

## 3. Employee 与项目关系

Employee Definition 新增 `knowledgeProfileIds`。项目角色任用也可以追加 `knowledgeProfileIds`。有效 Profile 为：

```text
Employee profiles
+ current project-role binding profiles
- archived or missing profiles
```

调用行为：

| 上下文 | 知识范围 |
| --- | --- |
| Employee 直接调用 | Employee Profiles |
| 项目角色调用 | Employee Profiles + 当前 Project Role Profiles |
| Workflow Node | Node 对应 Employee Profiles；可结合 Invocation project 和任务输入 |
| queued / waiting | 不检索 |
| running | Provider 调用前生成该 Work Instance 的 Plan |
| archived Employee | 拒绝新调用 |

Project Profile 只在对应任用中加入临时 Employee 视图，不永久写回 Employee 档案。

员工页的知识视角分别展示：

1. `eligible`：授权与状态允许参与的 Collection；
2. `activated`：结合项目、角色、任务标签和请求词后被激活的 Collection；
3. `selected`：Router 在预算与相关度约束下最终选中的 Collection。

每层都返回 Profile、规则、匹配条件和原因，并可关联近期 Run 中实际使用的 Evidence。员工档案编辑器不直接修改 `knowledgeProfileIds`；授权变化统一创建待人工审批的 `employee-profiles.set` 提案。

## 4. Resolver、Router 与 Agent

Resolver 和 Router 是 TypeScript Core 服务，不是可寻址 Employee：

- Resolver 像访问策略编译器，执行确定性选择、状态过滤和预算合并。
- Router 像检索分发器，在 Eligible Collection 中做减法。
- Employee Agent 只看到已检索 Evidence，不参与权限计算。
- Knowledge 使用规范可以由共享 Skill 提供，但 Skill 不能扩权。

首版 Router 使用元数据、条件和词项相关度。将来可以增加 Provider-backed Router，但它必须返回固定 Schema，只能选择 Resolver 已允许的 Collection，并保存 raw/normalized output。

## 5. 内容安全与准确率

- 默认不从未发布、归档或无发布 Revision 的知识库检索。
- Source 内容属于不可信数据，必须作为 Evidence 分区注入，不能覆盖系统指令。
- URL 页面中的脚本、样式和模板内容在结构化时丢弃；正文在界面中按文本安全渲染，不执行页面 HTML。
- Router 先缩小 Collection，再执行 Chunk 检索；禁止对所有可访问知识执行一次全局搜索。
- 中文 on-demand 路由至少需要双字词命中；单个汉字重合不能扩张 Collection 范围，以降低知识膨胀后的偶然漂移。
- 每次检索设置全局 Chunk 和 Token 上限。
- 低于相关度阈值的 Chunk 不注入。
- 每条 Evidence 包含 KnowledgeBase、Collection、Revision、Document 和 Citation ID。
- 同一知识库出现冲突内容时保留来源，不能静默合并为一个事实。
- Profile 更新实时影响后续调用；历史 Run 继续引用当时的 Profile 版本和 Knowledge Revision。

## 6. 持久化边界

- Workbench State：KnowledgeBase/Profile Definition、版本历史和发布指针。
- Knowledge Store：不可变 Revision 正文与派生索引。
- Run Store：当次 Plan、检索查询、命中 Evidence 和实际 Prompt。
- Provider：只消费准备好的上下文，不负责内容授权或索引管理。
- MCP/A2A：只代理 Workbench 能力，不复制知识模型。
