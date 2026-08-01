# Workflow 会话调用提示

## 目标

让“协作编排”详情直接产出可复制到另一 Codex 会话的自然语言提示词与 MCP 参数示例；已有调用包时优先 `invoke_publication`，否则提供明确标注为调试入口的 `run_workflow` 示例。

## 设计结论

- 在版本区之后、现有“签发运行工单”之前增加 `05 / 其他会话使用`，保持档案从定义、结构、版本到使用的阅读顺序。
- 复用 `ReadonlyEvidence` 的复制按钮、反馈和证据块视觉，不新增弹窗或独立页面。
- 有活动 Publication 时显示稳定调用入口；没有时显示“未打包”提示、直接 Workflow 示例和前往 `#publications` 的动作。
- 示例只包含公开 ID、示例 input 与来源元数据，不输出节点 Prompt、Skill 或 Graph 内部上下文。

## 范围

- React + plain CSS 客户端；无需新增后端 API 或修改持久化模型。
- 保留现有本地“运行编排”为调试台，不改变 MCP、A2A、Workflow 和 Publication 边界。
- 视觉沿用暖灰纸张、编号章节、朱红索引与等宽证据块。

## 阶段

1. [Phase 01 — 设计与实现说明](./phase-01-design.md) — 已完成
2. [Phase 02 — 验证与交付](./phase-02-validation.md) — 已完成

## 完成定义

- 用户可在 Workflow 详情一键复制 Codex 提示词和精确 MCP JSON。
- 已发布、未发布、多调用包三种状态均有清晰且可执行的内容。
- 320、768、1280、1440px 无页面级横向溢出，键盘和读屏反馈完整。
- `npm run check` 通过。
