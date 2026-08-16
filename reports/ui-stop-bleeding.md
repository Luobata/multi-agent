# UI 修复报告：卡死交付页止血 UX

- 合同 ID：`seed-gsb-ui-stop-bleeding`
- 日期：2026-08-16
- 前置审计：`reports/ui-stuck-delivery-ux.md`

## 修改文件（合同 allow-list 内，共 3 个）

- `client/src/RunsPage.tsx`
- `client/src/styles.css`
- `client/src/RunsPage.test.tsx`

## 五项修复落点

1. **绿红矛盾桥接**：`RunsPage.tsx` 主渲染在 dossier header 下方新增 `.run-delivery-bridge`（`role="status"`）：当当前选中 Run 的 delivery 状态为 `conflict`/`queued-for-merge`/`retesting`/`merging`/`returned-to-acceptance` 时显示「Run 已完成 ≠ 交付完成；候选仍在待合入队列，需要你的处理。」。Stamp 未隐藏、未改动（`components.tsx` 未触碰）。`merged`/`kept`/`discarded`/`awaiting-acceptance` 不显示（前三个已终态；`awaiting-acceptance` 下「仍在待合入队列」文案不成立）。
2. **重试按钮按 `failureClass` 分文案**：`conflictRetryLabel()`（`environment-blocked` → 「重启候选预览并重跑验收」；`evidence-incomplete` → 「重新收集证据并验收」；`product-failed`/未知 → 保持「重新让原领队处理冲突」）。按钮行为不变，仍 POST `/api/runs/:id/merge-conflict-retry`。
3. **红区人话根因 + 技术折叠**：`conflictResolution.status === "failed"` 时先显示 `conflictFailureRootCause()` 派生的一句根因（`.run-delivery-rootcause`），原始 `delivery.message` 包进 `<details class="run-delivery-tech-detail"><summary>技术详情</summary>…</details>`。非 failed 的冲突状态（resolving/retesting/leader-review/无 resolution）保持原有直显。
4. **逃生指引**：failed 状态 callout 底部新增 `.run-delivery-escape`：「如果多次重试仍失败，可以[保留候选]或[丢弃候选]结束本次交付。」`actionable`（已有条件，含 conflict 且非 busy 且有 worktree）为真时两个词是触发既有 `onOpenKeep`/`onOpenDiscard` 的按钮；不可用时退化为纯文本，不强行启用（符合合同 stop condition）。
5. **Run 深链 + 移动端溢出**：领队计划/工程修复/复测/领队复验 Run ID 经 `ConflictRunLink` 渲染为 `<a href="#/runs/<id>">`（`pageFromHash` 的 `split("/").filter(Boolean)` 兼容前导斜杠，路由已验证可达 runs 页）；`styles.css` 为 `.run-delivery-callout` 的 `p`/`small`/`code` 补 `overflow-wrap: anywhere`，并新增 bridge/rootcause/tech-detail/escape/escape-link 样式。

## 验证（当前运行证据）

- `npm test -- client/src/RunsPage.test.tsx`：62/62 PASS（57 既有 + 5 新增）。新增覆盖：桥接文案出现/merged 后不出现、`environment-blocked` 按钮文案且仍可 POST 重试、`evidence-incomplete` 文案 + `<details>` 折叠 + 根因句、Run 深链 `href="#/runs/..."`、逃生指引存在且「保留候选」「丢弃候选」可分别打开既有 keep/discard 弹窗。
- `npm run typecheck`（server + client）：PASS，exit 0。
- `git diff --check`：PASS。
- 未截图（合同注明代码级测试即可）。

## Caveats

- 共享工作树中 `src/workbench/conflictResolution.ts`、`src/workbench/service.ts`、`tests/conflict-resolution.test.ts`、`tests/run-delivery-daemon.test.ts` 存在非本合同的并发/既有改动；本轮未读取内容、未触碰，diff 范围已由 `git diff --stat` 核对仅限三个 allow-list 文件。
- `failureClass` 误分类（environment-blocked 落到 evidence-incomplete）属 core-bug 合同范围；本轮只对两个分类分别给了正确文案，分类本身未改。
- 重试成功后的 notify 文案（「原领队会继续使用保留的 worktree」）未随按钮文案调整——属既有服务端回执陈述，未在本合同五项范围内。
- 未重启服务、未在真实 4318 页面验证（合同禁止服务重启）。
