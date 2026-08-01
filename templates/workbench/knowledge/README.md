# Workbench Knowledge Seed

这个目录是当前 Workbench 知识控制面的声明式种子，不保存运行时索引。知识库正文从仓库文档同步，Revision 与派生索引由 Workbench 写入配置的数据目录。

## 首次建立

请从仓库根目录执行：

```bash
npm run cli -- workbench knowledge-base create templates/workbench/knowledge/local-agent-workbench.knowledge-base.json
npm run cli -- workbench knowledge-base sync local-agent-workbench
npm run cli -- workbench knowledge-base publish local-agent-workbench

npm run cli -- workbench knowledge-profile create templates/workbench/knowledge/product.knowledge-profile.json
npm run cli -- workbench knowledge-profile create templates/workbench/knowledge/design.knowledge-profile.json
npm run cli -- workbench knowledge-profile create templates/workbench/knowledge/engineering.knowledge-profile.json
npm run cli -- workbench knowledge-profile create templates/workbench/knowledge/quality.knowledge-profile.json
```

同步只生成草稿 Revision；必须显式发布后，员工才会使用新内容。

## 当前员工映射

| Employee | Knowledge Profile |
| --- | --- |
| `lin-mo-product-designer` | `workbench-design-knowledge` |
| `xiaomiwang-product-manager` | `workbench-product-knowledge` |
| `huotuizhu-product-manager` | `workbench-engineering-knowledge` |
| `yaoxi-programmer` | `workbench-engineering-knowledge` |
| `xiaomixiang-tester` | `workbench-quality-knowledge` |
| `mihuhu-frontend-engineer` | `workbench-engineering-knowledge` |

可使用公开 CLI 更新员工档案：

```bash
npm run cli -- workbench employee knowledge lin-mo-product-designer workbench-design-knowledge
npm run cli -- workbench employee knowledge xiaomiwang-product-manager workbench-product-knowledge
npm run cli -- workbench employee knowledge huotuizhu-product-manager workbench-engineering-knowledge
npm run cli -- workbench employee knowledge yaoxi-programmer workbench-engineering-knowledge
npm run cli -- workbench employee knowledge xiaomixiang-tester workbench-quality-knowledge
npm run cli -- workbench employee knowledge mihuhu-frontend-engineer workbench-engineering-knowledge
```

## 日常改进

1. 修改仓库中的权威文档。
2. 执行 `knowledge-base sync local-agent-workbench` 生成新 Revision。
3. 在知识库页面检查文档数和命中预览。
4. 执行 `knowledge-base publish local-agent-workbench` 或在页面发布。
5. 如发现质量下降，可用 `--revision <n>` 把 published 指针回滚到已知稳定版本。

管理台的“知识控制台”提供等价闭环：总览 → 知识目录 → 发布车道 → 员工 Profile → 影响与授权。新增知识库的首份人工内容只生成草稿；在发布车道完成质检、检索试跑和影响确认后再显式发布。

项目内 AI 管理入口还需要登记专用 Skill 与内部员工，然后重新连接和绑定当前项目：

```bash
npm run cli -- workbench skill-create templates/workbench/knowledge-control-conversation.skill.json
npm run cli -- workbench employee create templates/workbench/knowledge-steward.employee.json
npm run cli -- workbench project connect .
npm run cli -- workbench project bind local-agent-workbench templates/workbench/local-agent-workbench.binding.json
```

这个员工通过 `internalProjectId` 只能用于 `local-agent-workbench/knowledge-steward`，不能直接调用、绑定给其他项目或发布成调用包。对话只会生成等待人工审批的 KnowledgeChangeRequest。

不要把员工 ID 写入 Knowledge Base 或 Profile；员工映射属于 Employee/Project Binding 层。
