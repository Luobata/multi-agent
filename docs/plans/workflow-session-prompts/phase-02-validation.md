# Phase 02 — 验证与交付

## Context links

- [总计划](./plan.md)
- [Phase 01](./phase-01-design.md)
- [`providerRuntime.test.ts`](../../../client/src/providerRuntime.test.ts)（客户端纯函数测试范式）
- [`workbench-ui.md`](../../workbench-ui.md)

## Overview

- 日期：2026-07-30
- 优先级：P1
- 状态：已完成
- 置信度：90%；纯函数测试加浏览器检查可覆盖主要风险。

## Key Insights

- 主要失败面是示例与 MCP schema 漂移、错误选择 Publication、长内容溢出和无障碍反馈缺失。
- 现有项目没有完整组件测试基建，优先测试生成逻辑并用真实页面做交互验收。

## Requirements

- 覆盖 published、unpublished、multiple publications、复杂/空 input schema。
- 覆盖 Workflow 切换、Publication 选择和剪贴板成功反馈。
- 在 320、768、1280、1440px 检查布局、滚动和焦点顺序。

## Architecture

- 新增 `client/src/workflowSessionPrompts.test.ts`，直接测试纯函数输出。
- UI 验收使用本地 mock provider 与现有 Workbench daemon，不新增测试专用后端路径。
- 最终执行仓库标准门禁 `npm run check`。

## Related code files

- 新增：`client/src/workflowSessionPrompts.test.ts`
- 验证：`client/src/WorkflowPage.tsx`、`client/src/styles.css`
- 如文案职责变化，更新：`docs/workbench-ui.md`、`docs/live-invocations.md`

## Implementation Steps

1. 断言有包时输出 `invoke_publication` 与正确 publicationId。
2. 断言无包时输出 `run_workflow`、workflowId 和“调试入口”语义。
3. 断言示例不含节点、Prompt、Skill、文件路径或未知字段。
4. 用键盘完成选择调用包、复制两个块和跳转调用包页面。
5. 完成四档视口、离线只读、长 ID/长 JSON 检查并运行 `npm run check`。

## Todo list

- [x] 纯函数单测
- [x] 复制成功与失败反馈检查
- [x] 键盘/读屏名称和焦点检查
- [x] 响应式与无横向溢出检查
- [x] `npm run check`

## Success Criteria

- 两种 MCP payload 均可被现有工具接受，字段名无漂移。
- 状态不只靠颜色表达；复制后有可读文字反馈且焦点不跳走。
- daemon 离线时仍可阅读和复制示例，运行/写入限制保持不变。
- 所有门禁通过，mock provider 示例仍可运行。

## Risk Assessment

- 剪贴板权限失败：必须给出可读错误并保留可手动选择的 `<pre>` 内容。
- UI 回归：不得改变已有 Dossier、运行工单和 Publication 页面行为。

## Security Considerations

- 测试包含泄露否定断言；复制内容仅为调用契约和用户占位输入。
- 不在快照、日志或文档样例中加入真实项目名、会话 ID、密钥或绝对路径。

## Next steps

- 已复核文案并更新调用说明，可以交付。
