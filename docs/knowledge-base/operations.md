# Knowledge Control Plane Operations

知识控制台是 Workbench 内的独立管理子系统。它与员工档案、Skill 注册表和 Workflow 分层，但通过 `KnowledgeProfile` 与员工和项目角色建立稳定关系。

## 1. 子 Tab 与职责

| 子 Tab | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 总览 | 治理队列、发布待办、Profile 覆盖与失效引用 | 不直接修改长期配置 |
| 知识目录 | KnowledgeBase、Collection、Source、人工 Document 与目录元数据 | 不给员工逐库授权 |
| 发布车道 | Revision 质检、草稿检索试跑、影响确认、发布与回滚 | 不修改历史 Run |
| 员工 Profile | 多规则目录范围、信任边界、激活条件和单次预算 | 不保存正文和索引 |
| 影响与授权 | 解释 KnowledgeBase → Profile → Employee / Project Role 的确定性关系 | 不使用模型推断权限 |
| AI 管理 | 项目内 Codex 会话、查询、试跑、变更提案和人工审批 | 不允许模型自审或直接写入 |

## 2. 新增知识库

```text
建立目录
  → 定义 Domain / Product / Project / Classification
  → 划分 Collection、Authority 与稳定标签
  → 添加本地 Source 或首份人工知识
  → 生成未发布 Revision
  → 执行质量检查与草稿检索试跑
  → 查看 Profile、员工和项目角色影响范围
  → 显式发布
```

首份人工知识只生成草稿，不自动发布。没有 `publishedRevision` 的知识库不会进入 Employee Resolver。

## 3. 接入员工

发布内容不等于授权员工。新增知识库需要选择一种 Profile 接入方式：

1. **显式纳入**：Profile Rule 列出 KnowledgeBase ID。适合敏感、核心或变更频率低的知识；安全默认。
2. **元数据纳入**：Profile Rule 按 Domain、Product 或 Project 匹配。适合边界稳定、经常扩容的普通知识；发布前必须查看影响范围。
3. **独立 Profile**：敏感度、使用人群或激活方式明显不同，建立新的 Profile，再分配给少数员工或项目角色。

已有员工引用的是 Profile ID。修订现有 Profile 后，后续调用自动采用新版本，不需要逐个修改 Employee × KnowledgeBase 关系。

## 4. 发布门禁

发布前控制台执行确定性检查：

- 空 Revision 是 blocker，不能发布；
- 空 Collection 和“配置了 Source 但无来源文档”是 warning，需要人工确认；
- 草稿试跑直接搜索指定 Revision，不调用 Employee 或 Provider，也不改变授权；
- 影响确认展示匹配的 Profile、直接员工与项目角色；
- 发布或回滚只改变 `publishedRevision` 指针，历史 Revision、索引和 Run 证据不重写。

CLI 等价入口：

```bash
npm run cli -- workbench knowledge-base assess <knowledge-base-id> --revision 2
npm run cli -- workbench knowledge-base preview <knowledge-base-id> "代表性问题" --revision 2
npm run cli -- workbench knowledge-base publish <knowledge-base-id> --revision 2
npm run cli -- workbench knowledge-impact
```

## 5. 日常改进与故障处理

| 场景 | 操作 |
| --- | --- |
| 来源内容更新 | 同步来源 → 检查新 Revision → 试跑 → 发布 |
| 人工内容改进 | 从最新 Revision 编辑文档 → 生成新草稿 → 试跑 → 发布 |
| 检索不命中 | 检查标题、正文、Collection 标签和任务措辞；不要先扩大 Profile |
| 内容质量下降 | 把发布指针回滚到已知稳定 Revision |
| 授权过宽 | 修订 Profile Selector、Activation 或 Budget；不删除历史知识 |
| 知识库停用 | 软归档 KnowledgeBase；Profile 与历史 Run 仍保留可解释引用 |
| Profile 停用 | 软归档 Profile；后续 Plan 记录排除原因 |
| 员工引用缺失 | 在“影响与授权”修复或移除失效 Profile ID |

## 6. 所有权

- **内容负责人**维护 KnowledgeBase、Source、Collection 和 Revision。
- **策略负责人**维护 Profile 与发布影响范围。
- **员工 / 项目负责人**只决定使用哪些 Profile。
- Resolver、Router、Retriever 在运行时确定实际证据；运行结果不会自动反向修改长期配置。

## 7. AI 管理与审批

AI 管理入口调用当前项目的 `knowledge-steward` role。对话中的读取、质检、草稿试跑和影响分析可以立即返回；新增、修改、同步、发布、回滚、归档或授权调整必须先生成 KnowledgeChangeRequest。

审批卡展示计划摘要、Risk、Warning、受影响知识库/Profile/员工/项目角色和计划哈希。批准会重新校验目标版本与影响；任何变化都会使请求进入 `needs-reapproval`。批准、拒绝和取消只向人开放：拒绝或取消只关闭提案，不修改知识状态，并记录决策人和时间。
