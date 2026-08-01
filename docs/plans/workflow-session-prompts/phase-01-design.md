# Phase 01 — 设计与实现说明

## Context links

- [`WorkflowPage.tsx`](../../../client/src/WorkflowPage.tsx)
- [`components.tsx`](../../../client/src/components.tsx)（`DossierSection`、`ReadonlyEvidence`）
- [`styles.css`](../../../client/src/styles.css)
- [`types.ts`](../../../client/src/types.ts)

## Overview

- 日期：2026-07-30
- 优先级：P1
- 状态：已完成
- 置信度：92%；现有 MCP 工具与 Publication 数据已能覆盖，无需后端变更。

## Key Insights

- 当前详情在 `04 / 版本` 后直接进入本地运行工单，缺少“交给其他会话”的出口。
- `ReadonlyEvidence` 已提供可复制代码块和“已复制”反馈，应直接复用。
- Publication 是稳定入口；`run_workflow` 仅作为未打包时的可用调试入口。

## Requirements

- 在 `04 / 版本` 与 `run-workflow` 之间加入 `05 / 其他会话使用`。
- 首屏说明行显示文字状态章、入口类型和说明；多 Publication 时复用产品化 `SelectControl`，同时覆盖展开态、键盘路径和视口边界。
- 纵向展示两个证据块：`给 Codex 会话的提示词 · 推荐`、`MCP 参数示例`。
- 有 Publication：生成 `invoke_publication`；无 Publication：生成 `run_workflow`，并显示“未打包”及前往 `#publications`。
- 自然语言示例须包含工具名、目标 ID、任务占位、project、可选 contextId，并要求返回 Run ID。

## Architecture

- 在客户端过滤 `data.publications`：活动、`target.kind === "workflow"`、目标为当前 Workflow。
- 新建纯函数模块 `workflowSessionPrompts.ts`，输入 Workflow、可选 Publication 和示例 input，输出 humanPrompt/mcpJson/mode。
- 示例 input 从 Workflow input schema 生成最小占位对象；无法推断时回退 `{ "message": "在这里填写任务" }`。
- 纯函数不读取节点、Employee Prompt 或 Skill，避免内部实现泄露。

## Related code files

- 修改：`client/src/WorkflowPage.tsx`、`client/src/styles.css`
- 新增：`client/src/workflowSessionPrompts.ts`
- 可选文档：`docs/workbench-ui.md`、`docs/live-invocations.md`
- 不修改：`src/workbench/service.ts`、MCP/A2A/Run Store。

## Implementation Steps

1. 实现输入占位与两种调用文本的纯函数。
2. 在详情中计算匹配的调用包及当前选择；切换 Workflow 时校正选择。
3. 插入第 05 节并复用 `ReadonlyEvidence`；无包状态加入文字章和导航动作。
4. 添加 `.workflow-session-*` 的布局规则，全部使用现有 token。

## Todo list

- [x] 已发布、未发布、多包内容分支
- [x] 两个复制块与成功反馈
- [x] 移动端堆叠和长 JSON 收纳
- [x] 不泄露内部 Prompt/Graph 内容

## Success Criteria

- 复制出的自然语言可直接粘贴到新 Codex 会话。
- MCP JSON 与现有 `invoke_publication` / `run_workflow` schema 一致。
- 900px 以下页面堆叠；640px 以下选择器和动作满宽；代码仅在自身块内换行/滚动。
- 按钮、选择器保持 DOM 阅读顺序、可见焦点及粗指针最小 44px 命中区。

## Risk Assessment

- 多包默认项可能含糊：按名称稳定排序并允许选择，避免静默随机。
- Schema 过复杂可能生成误导示例：标注“示例”，无法推断时使用通用 message 回退。

## Security Considerations

- 不复制系统 Prompt、Skill 配置、节点 `with`、本地路径或密钥。
- 保持“本机 MCP”措辞，不暗示公网能力。

## Next steps

- Phase 02 已完成：纯函数、状态分支、复制反馈和多视口行为均已验证。
