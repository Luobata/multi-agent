# UI 审计报告：卡死任务（交付/合并队列）页面 UX

- 合同 ID：`seed-gsb-ui-stuck-delivery-ux`
- 日期：2026-08-16
- 范围：只读代码审计（`client/src/`、`src/`），未点击生产环境任何按钮，未改任何文件
- 核心问题：**用户能否理解现状并采取合理操作走向终态？** 结论：不能。页面同时给出相互矛盾的绿色/红色信号，唯一真正有效的恢复动作被错误文案掩盖，根因从未用人话表达。

## 1. 状态表达诚实性：矛盾成立，「完成」不是按钮

绿色横幅来自 `client/src/RunsPage.tsx:1442` 的 dossier header：Run 为终态（passed/completed）时显示「流程完成，证据已归档。」，右上角是 `<Stamp status={selected.status}>`。

- 「完成」点击行为（代码级追踪，非猜测）：`Stamp` 在 `client/src/components.tsx:400-405` 渲染为 `<span className="stamp stamp--completed">`，无 `onClick`、无 `role="button"`、无键盘交互；绿色样式来自 `client/src/styles.css:1058` 与 `:2811`（`seal-green`）。**点击什么都不会发生**——它不是按钮，但视觉重量（绿色、右上角、徽章造型）会让用户把它当成状态确认甚至可操作元素。
- 矛盾：同一屏下方红色 callout（`client/src/RunsPage.tsx:657`，`failureClass === "evidence-incomplete"` 分支）写着「候选证据不完整，不得放行」。绿色说的是「Run 终态、证据归档」，红色说的是「交付仍在合入队列、不得放行」。整页没有任何一处显式表达「Run 完成 ≠ 交付完成；候选仍卡在待合入队列」。用户会信绿色，认为事情已结束，然后离开——任务就此被遗忘在队列里。

## 2. 动作充分性：有效动作被错误文案掩盖，逃生路径无指引

- 「核对交付与验收」（`client/src/RunsPage.tsx:1453`）：纯导航。调用 `onOpenRequirement(taskId, "run")`；在本需求卷宗内嵌场景经 `client/src/RequirementDetailPage.tsx:336-339` 映射到 `?section=acceptance`，展示的是同一个交付面板。**不解决任何问题，只是换到同一屏的另一幕。**
- 「重新让原领队处理冲突」（`client/src/RunsPage.tsx:1296-1321`）：POST `/api/runs/:id/merge-conflict-retry`（`src/daemon/server.ts:989-993`）→ `retryRunMergeConflict`（`src/workbench/service.ts:9347-9393`）。关键事实：当候选已完成 rebase 时，服务端直接回到 `retesting` 并**重新启动候选预览环境**（`service.ts:9368` 自述「保留 rebase 记录并重新启动候选环境」；预览重启在 `service.ts:8982` `startCandidatePreview`）。所以对「预览服务已死」这个根因，**这个按钮实际上是唯一能走向恢复的动作**——但按钮文案只说「处理冲突」，而它正上方的红字是「候选证据不完整，不得放行」，用户无法建立「点它 = 重启预览重跑验收」的认知。
- 同屏其实还有出口：`actionable` 条件（`client/src/RunsPage.tsx:624`）包含 `conflict` 状态且 resolution failed 时 `conflictBusy=false`，因此「丢弃候选结果」「人工保留」（`:710-711`）实际可用——存在到终态的逃生路径，但页面没有任何指引告诉用户「修不好可以保留或丢弃」。
- 缺失的关键动作：没有与根因对齐的「重启候选预览并重跑验收」显式表达；「让 test-engineer 补采证据」（`client/src/RunsPage.tsx:697-704`）只在媒体缺失/补采失败时出现（`:622`、`:633`），且服务端在已有媒体时拒绝重复补采（`src/workbench/service.ts:8748-8750`），对本场景（E2E 门禁失败而非媒体缺失）大概率不可见或不可用。
- 分类放大误导（表达后果记录，分类裁决属 core-bug 合同）：`classifyConflictRetestFailure`（`src/workbench/conflictResolution.ts:77-83`）在 message 未命中环境正则且 `evidenceIssues` 非空时归 `evidence-incomplete`。本案根因是 `MIDSCENE_ENVIRONMENT_BLOCKED`（`src/architectures/supervisor.ts:1753-1756`），但页面落到了「证据不完整，不得放行」文案，而不是 environment-blocked 分支的「候选环境阻塞，可重试验收」——后者至少指向了正确方向。

## 3. 可理解性：红区是原始技术转储，根因从未显性表达

- 红区正文 = `delivery.message`，由 `src/workbench/service.ts:9119` 拼成 `AI 冲突处理未通过：${message}；候选仍在待合入队列…`，其中 message 来自 `:9031-9035` 的 `冲突修复后的独立测试未通过：${testResult.message}；${evidenceIssues}`。`testResult.message` 携带 `MIDSCENE_ENVIRONMENT_BLOCKED`、候选 URL（127.0.0.1:59319）、sourceCommit、candidateRevision、e2eEvidence 数组、risks 数组——原始结构化错误直接进 `<p>`（`client/src/RunsPage.tsx:657`）。
- 根因「临时候选预览服务（127.0.0.1:59319）已停止，验收脚本无法访问真实页面」从未用一句自然语言表达。「不得放行」是系统约束陈述，不是用户指引；用户看完不知道自己该做什么。

## 4. 信息架构：因果链断裂，Run 引用不可点击

- 「领队计划 Run / 执行角色 / 工程修复 Run」（`client/src/RunsPage.tsx:657` 内 `<small>+<code>`）是纯文本，没有到对应运行卷宗的深链——尽管应用已有 `runs/<id>` 路由与独立卷宗入口（`client/src/RequirementDetailPage.tsx:317`）。用户无法点击查看领队计划或工程修复的证据来理解「两个 passed 的 Run 为什么没能救回合入」。
- 因果链零解释：为什么一次合入会衍生三个 Run、各自结论是什么（领队计划 passed、工程修复 passed、验收被环境门禁拦下），没有任何一句话串联。
- 轻度重复：Run ID 在 header file-index、交付区 ledger、callout small 多处重复出现。

## 5. 移动端 375px（代码级判断，未截图）

- 结构性适配到位：≤700px 时 `.run-control-bar` 单列、按钮 100% 宽且 `min-height: 44px`（`client/src/styles.css:4259-4261`）；`.run-delivery-actions` 按钮全宽（`:4258`）；内嵌模式隐藏左侧 record-list（`:4246`）。主操作在移动端可点可达。
- 真实风险：冲突 callout 的 `<p>`（delivery.message）与 `<small><code>` **没有 overflow-wrap 规则**（`:4139-4140`；全局 `code` 仅有字体声明 `:16`）。Run ID 含连字符尚可断行，但消息正文里的 40 位 commit hash、URL、长错误 token 无断点，375px 下会横向撑破 callout。对照组 `.ledger dd`、`.path-code` 均有 `overflow-wrap: anywhere`（`:1111`、`:1575`、`:4148`），独缺 callout 文本。

## Top-3 修复建议（如果只能改三件事）

1. **消除状态矛盾**：当 `preview.status` 为 `conflict`/`queued-for-merge` 等非终态交付状态时，在 dossier header 或红区首行加显式桥接文案（「Run 已完成 ≠ 交付完成；候选仍在待合入队列，需要你的处理」），或让绿色 Stamp 在交付未终态时附加交付状态，避免绿色「完成」单独定调。
2. **动作对齐根因**：retry 按钮按 `failureClass` 分文案（`environment-blocked` → 「重启候选预览并重跑验收」），并在 callout 内一句话说明重试会做什么（保留 worktree、重启预览、重跑 E2E）；同时把「人工保留 / 丢弃候选」写成显式逃生指引而不是两个孤立按钮。
3. **技术文本分层 + Run 深链**：红区首行用一句人话根因（「候选预览服务已停止，验收无法访问真实页面」），原始 message 折叠进 `<details>`；领队计划/工程修复 Run ID 改为指向对应运行卷宗的链接。

## Caveats

- 只读代码审计：未在真实页面点击任何按钮、未截图；移动端结论为 CSS/结构代码级判断。
- 「让 test-engineer 补采证据」按钮在本场景是否可见取决于媒体资产状态（`evidenceMissing || evidenceFailed`），无法仅从代码唯一确定。
- `failureClass` 误分类（environment-blocked → evidence-incomplete）的裁决与修复归属 core-bug 合同；本报告只记录其 UX 表达后果。
- 重试在「候选未 rebase」分支会回到 `resolving`（完整领队重规划）而非直接重跑验收；按钮实际走哪条路径取决于交付记录的 commit 对账（`src/workbench/service.ts:9359-9361`）。
