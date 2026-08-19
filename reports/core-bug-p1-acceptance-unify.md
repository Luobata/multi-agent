# Core-Bug 报告：P1 验收路径合并 + 证据统一归档

- 合同：`seed-gsb-core-bug-p1-acceptance-unify`（workspace `contracts/core-bug.md`）
- 角色：core-bug（独占写 allow-list 内作业）
- 状态：**完成**（2026-08-19）
- 改动文件（全部在 allow-list 内）：
  - `src/workbench/service.ts`（仅两段 retest 及归档接线）
  - `src/workbench/conflictResolution.ts`
  - `src/runtime/worktreeDelivery.ts`（证据字段 + 归档函数）
  - `tests/conflict-resolution.test.ts`、`tests/merge-queue-retest-preview.test.ts`、`tests/acceptance-unified.test.ts`（新）

---

## 1. P1-A 收敛结构（duplication-elimination 证据）

**收敛点：`WorkbenchService.runManagedAcceptanceRetest` — `src/workbench/service.ts:9189`**

单一参数化编排，两个入口共用：

1. `candidateWorkspaceSnapshot`（失败 → `conflictRevalidationFailure(..., "environment-blocked")`）
2. `workspaceBinding === "candidate"` 时：测前 `validateCandidateWorkspaceState`
3. `startCandidatePreview`（失败 → environment-blocked）
4. `invokeProjectTestRoleAtTestPath` + `buildAcceptanceRetestRequest` + `determineTestCommands(snapshot.changedFiles)`；`finally { await candidatePreview?.stop(); }`
5. `validateConflictRetestEvidence` + `candidatePreview.wasAccessed()`
6. candidate 绑定时：测后二次 snapshot + workspace 复核（revision 漂移检测）
7. verdict 失败或证据缺口 → failed outcome + `classifyConflictRetestFailure`
8. 通过 → `archiveAcceptanceEvidence` → passed outcome（含 evidenceRef）

**两个调用点（仅注入差异，失败翻译留在调用点以保持各自状态机不变）：**

| | 冲突路径 | 队列漂移路径 |
|---|---|---|
| 调用点 | `service.ts:9430`（`completeConflictRevalidation`，`resolution.status === "retesting"` 分支） | `service.ts:9711`（`processClaimedDelivery`，`assessment.targetChanged` 分支） |
| narrative | `CONFLICT_RETEST_NARRATIVE` | `buildMergeQueueRetestNarrative(targetBranch)` |
| caller | `system:merge-conflict-retest` | `system:merge-queue-retest` |
| evidenceKind | `conflict-retest` | `merge-queue-retest` |
| workspaceBinding | `candidate`（测前/测后身份校验） | `integration`（一次性集成 worktree，不校验——其 HEAD 是目标 commit 且内容永不进入真实合并） |
| 失败翻译 | 抛错 → `conflictRevalidationFailure(error.failureClass ?? classify(message, []))`；failed outcome → `conflictRevalidationFailure("冲突修复后的独立测试未通过：…", outcome.failureClass ?? classify(...))`；通过 → `conflict.stage-completed`(tested) | failed → `validation.failed` + return；通过 → `validation.passed`(required: true)；调用异常照旧上抛到 dispatch 失败 |
| 周边保留 | 不变 | `validation.started`、`handle.renew()/assertActive()`、`createMergeValidationWorktree`、`finally { removeMergeValidationWorktree }` 全部保留 |

**Prompt 构造收敛（`src/workbench/conflictResolution.ts`）：**

- `AcceptanceRetestNarrative` 接口 `:228`；`CONFLICT_RETEST_NARRATIVE` `:236`；`buildMergeQueueRetestNarrative` `:244`
- `buildAcceptanceRetestRequest` `:257`：共享正文（唯一受管候选 URL、CANDIDATE_IDENTITY  attestation、服务端确定性 testScope、接地要求清单）
- `buildConflictRetestRequest` `:300`：变为薄委托（`buildAcceptanceRetestRequest({ ...input, narrative: CONFLICT_RETEST_NARRATIVE })`），输出**逐字节不变**（测试 `toBe` 断言相等）
- 消除了 merge-queue 路径内联 prompt（约 40 行）与重复编排；两文件合计 +553/-120 行（含新测试与归档实现）

## 2. P1-B 归档布局与可追溯性

**`archiveAcceptanceEvidence` — `src/runtime/worktreeDelivery.ts:3038`**

```
<runDir>/delivery-evidence/<testRunId>/
├── retest-output.json        # 结构化载荷：kind, archivedAt, testRunId, url,
│                             # sourceCommit, targetCommit, candidateRevision,
│                             # invocationStatus, message, output
└── midscene/<相对路径>        # 从 <worktreePath>/midscene_run/ 递归复制
                              # 媒体扩展名(.png/.jpg/.jpeg/.webp/.gif/.mp4/.webm/.mov)
                              # → type "screenshot"，其余 → "midscene-report"
```

- 上限：50 文件 / 25 MB / 深度 6；跳过符号链接；best-effort——任何失败记入 ref 的 `archiveError`（截断 4000 字符），**绝不抛错、绝不阻塞状态流转**
- 每个 item：`{ type, relativePath（POSIX，相对 runDir）, sha256, sizeBytes }`

**Delivery 记录持有引用：**

- `AcceptanceEvidenceRef` `worktreeDelivery.ts:50`（kind 枚举 `"conflict-retest"|"merge-queue-retest"` + 归档坐标 + items + 可选 archiveError）
- `conflictResolution.evidence?` `:113`、`mergeValidation.evidence?` `:122`（均为可选字段）
- reducer 在既有通过事件上落库：`conflict.stage-completed`(tested) payload `:299`、`validation.passed` payload `:316`——**不新增事件类型**，CAS/revision 语义不变
- `validateAcceptanceEvidenceRef` `:670` 挂入 `validateDeliveryRecord` `:780`/`:784`（kind 枚举、sha256 正则、禁绝对路径/`..`、非负 size）；损坏证据 → `readDelivery` 返回 corrupt，reason 含 `mergeValidation.evidence`/`conflictResolution.evidence`

**可追溯性样例（端到端）：** `tests/merge-queue-retest-preview.test.ts` 成功用例断言——delivery settle 后 `mergeValidation.evidence` 存在（kind=merge-queue-retest、items 非空、retest-output 文件在 runDir 下真实存在、归档 JSON 的 testRunId 与 ref 一致、summary 含 CANDIDATE_IDENTITY），而临时集成 worktree 目录已空/不存在——**worktree 删除后证据仍可从 delivery 记录直达**。

## 3. 兼容性说明

- evidence 字段全部可选 → 旧记录读取路径完全不变（全量 936 个既有测试通过，含 delivery-recovery）
- 不新增事件类型，evidence 搭车既有 tested/validation.passed payload → revision 计数与 CAS 行为不变
- `buildConflictRetestRequest` 包装保持逐字节相同输出
- 未通过复测的运行，证据仍在原处（`dispatch.lastFailure` / `conflictResolution.message` / worktree 内 midscene_run），行为不变

## 4. 测试输出（本轮亲自执行）

1. 聚焦测试：`npx vitest run tests/acceptance-unified.test.ts tests/conflict-resolution.test.ts tests/merge-queue-retest-preview.test.ts`
   → **3 files / 34 tests PASS**（conflict-resolution 24、acceptance-unified 6、merge-queue-retest-preview 4）
2. `npm run typecheck:server` → **exit 0**（期间修复新测试 `tests/acceptance-unified.test.ts:120` 的 TS2532：`ref.items[0]?.type` 可选链）
3. `npm run check` 首轮：3 个超时 flake（`supervisor-flow-v2`、`supervisor-handoff`、`worktree-isolation`，均为 `Test timed out in 5000ms`，文件均不在本次改动范围、不涉及 retest/证据路径）
   - 单跑这 3 个文件 → **28/28 PASS**（隔离复跑通过）
   - 全量复跑 `npm run check` → **exit 0，109 files / 939 tests PASS，build ✓（built in 1.03s）**
   - 结论：首轮 3 个失败为并行负载下的超时 flake，与本次改动无关（按合同 stop condition 不顺手修无关文件）
4. `git diff --check` → clean
5. diff 范围：仅上述 6 个文件（5 改 1 新），全部在 allow-list 内；工作区 `client/` 改动属 ui 并行合同，未触碰

## 5. Caveats

1. **有意收敛（非纯行为保持）**：merge-queue 路径获得 P0-2 确定性测试范围（`determineTestCommands(snapshot.changedFiles)`）与接地要求措辞，替换旧的硬编码 `npm run check` prompt——这是合同目标的一部分，特此标注。
2. 冲突路径在候选 worktree 干净时 testScope 仍回退到 smoke 测试（P0-2 既有行为；后续可从 baseCommit..sourceCommit 推导范围，属 follow-up）。
3. 证据仅在复测**通过**时归档；失败证据仍在 `dispatch.lastFailure`/`conflictResolution.message`。
4. `conflict.failed` 重试时，`conflictResolution.evidence` 保留上一次的归档引用（历史留存；多次归档以 testRunId 区分，目录互不覆盖）。
5. snapshot 失败的错误文案统一为"候选 worktree"（队列路径旧文案为"集成 worktree"）——仅文案，failureClass 与状态流转不变。
6. 归档为 best-effort：失败只体现在 ref 的 `archiveError`，不阻塞 delivery 状态流转。

---

## 6. 返工 fix1（合同 `seed-gsb-core-bug-p1-acceptance-unify-fix1`，2026-08-19）

**Hub 裁定的门禁回归**：首轮统一把 `determineTestCommands(snapshot.changedFiles)`（P0-2 为 conflict 路径设计的定向语义）注入两条路径，弱化了 merge-queue 入口的整库集成门禁——`3b46951` 确立的语义是队列漂移重测必须在临时集成 worktree 跑 `npm run check`（typecheck + test + build），跨文件类型破坏与集成级失败只有整库 check 能捕获。

**修复（统一编排结构不变，仅参数化测试范围 + 恢复三条指令）：**

- `runManagedAcceptanceRetest` 新增 `testScope: "changed-files" | "full-check"` 参数（`service.ts:9206`）；命令选择（`service.ts:9254`）：`full-check` → `["npm run check"]`，否则 `determineTestCommands(snapshot.changedFiles)`。
- conflict 入口（`service.ts:9450`）→ `testScope: "changed-files"`（P0-2 语义不变）。
- merge-queue 入口（`service.ts:9732`）→ `testScope: "full-check"`，**恒为 `["npm run check"]`**。
- merge-queue narrative 恢复 `3b46951` 三条指令（`conflictResolution.ts:255`，原文逐字）：① 在临时集成 worktree 运行 `npm run check`（typecheck + test + build）并把结果写入 e2eEvidence；② 不把浏览器验收和整库检查拆成不同分片；③ 环境问题（非产品问题）失败时在 summary 明确区分环境失败与产品失败。
- 两个入口现在仅 narrative/binding/testScope 三项差异；证据归档、失败翻译、状态机、CAS 全部未动。
- 明确未做：`classifyTestResults` 运行时接线（P0-2 既有缺口，Hub 指示记 backlog，本轮不碰）。

**返工测试证据（本轮亲自执行）：**

- 聚焦测试：`npx vitest run tests/conflict-resolution.test.ts tests/acceptance-unified.test.ts tests/merge-queue-retest-preview.test.ts` → **3 files / 35 tests PASS**（新增 1 条：conflict narrative 不含整库 check 指令的否定断言；merge-queue 用例断言三条指令 + testScope 段恒为 `- npm run check` 单条命令）
- `npm run typecheck:server` → **exit 0**
- `npm run check` 首轮：4 个失败（merge-queue-retest-preview 的 worktree 清理竞态断言、runner fail-fast 时序用例、worktree-isolation 继承用例、client/App.navigation 用例）——隔离复跑这 4 个文件 → **62/62 PASS**，均为全量并行负载下的 flake（client 文件属 ui 域，未触碰）；全量复跑 → **exit 0，109 files / 940 tests PASS，build ✓**。
- `git diff --check` clean；diff 仍限于 allow-list 的 6 个文件。

**返工 caveats：**

1. merge-queue 入口现在强制整库 `npm run check`——client-only 候选也会跑完整门禁（这是 `3b46951` 的本意，本轮恢复）。
2. merge-queue 测试 provider 是桩实现，不真正执行 `npm run check`；生产中由测试角色在集成 worktree 内执行，prompt 的 testScope 段与三条指令共同约束。
3. worktree 清理竞态断言（merge-queue-retest-preview :401）在全量并行下偶发 flake，隔离必过；如需根治建议 Hub 单独立项（不在本合同范围）。
