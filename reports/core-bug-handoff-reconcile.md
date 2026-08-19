# core-bug — handoff 强制化 + hub-reconcile + flake 根治

合同：`seed-gsb-core-bug-handoff-reconcile`（`contracts/core-bug.md`）
日期：2026-08-19 ｜ 角色：core-bug ｜ 状态：实现完成，验证通过

---

## A. member session handoff 强制化（保守三层）

### Layer 1 — prompt 强制（`src/workbench/materialize.ts:267`）

委派模板收尾指令改为强制：

> When a handoff file path is listed above, read that file at the start of your work if it exists. Before finishing, you **MUST** write your updated handoff back to the same absolute path: files touched, key decisions, and unexplored areas, within 4000 characters. Write the handoff even when you have no new findings (state that explicitly); a delegation attempt that leaves no handoff file is recorded as incomplete. When no path is listed, skip handoff entirely.

保留了原模板 "write your updated handoff back to the same absolute path" 短语，既有断言不受影响。无 handoff 路径时明确要求跳过，避免无 sessionKey 委派产生噪音。

### Layer 2 — 检测层（默认行为，只观测不阻断）

`src/architectures/supervisor.ts`：

- 新增 `inspectMemberHandoff(context, sessionKey)`：stat handoff 文件 → `missing`（非普通文件或 0 字节）/ `content`（经既有 `readMemberHandoff` 读取，异常一律视为 missing 并保守记录）。
- 两条委派完成路径都接入检测：
  - **gate 路径**（`~:1837`）：MIDSCENE 熔断检查保持在 raw result 上不变；检测在其之后执行。缺失时 emit `supervisor.member-session.handoff-missing`（载荷 `memberSessionId/sessionKey/todoId/bytes`，落 `<runDir>/events.jsonl`），turn 记录 `handoff: content` + `handoffMissing: true`，closed 事件与 `results.push` 使用 effective status。
  - **delegation 路径**（`~:3197`）：同样 emit 事件 + turn 标记；`record.result` 的原地修改发生在 dagTrackers 循环（`:3162`）与 workerResults.push（`:3257`）之前，effective status 对所有下游可见。
- `MemberSessionTurn`（`src/architectures/supervisor.ts:205`）新增 `handoffMissing?: boolean`，经既有 `memberSessionSnapshot` 原样进入下一次委派的 `__memberSession`。

**默认语义：run 不因此失败。** 缺失只产生事件 + turn 标记（UI/日志可观测）。

### Layer 3 — 硬门禁开关（默认 OFF）

**开关机制选型（调查结论）**：Management Policy 路径不可行——`normalizeManagementPolicy`（service.ts，allow-list 外）把 execution 配置裁剪为只剩 `{isolation}`，且 `WorkflowRunIsolation` 类型定义在 core/types.ts（allow-list 外）。沿 Management Policy 加字段必须改 allow-list 外文件，超出本合同权限。

**选定方案**（双入口，默认 OFF）：

1. 类型化选项：`RunWorkflowOptions.requireMemberHandoff?: boolean`（`src/runtime/runner.ts:60`）→ `ArchitectureExecutionContext.requireMemberHandoff`（`src/architectures/types.ts:72`）→ supervisor。CLI `run --require-member-handoff`（`src/cli/main.ts:161`）。
2. 环境变量 `MULTI_AGENT_REQUIRE_MEMBER_HANDOFF`（`memberHandoffGateEnforced`，supervisor.ts:1345）：trim+lowercase 后 ∈ {1, true} 即启用。沿用仓库 `MULTI_AGENT_*` 环境变量先例，使 daemon 启动的 run 无需改 service.ts 即可启用。

**门禁语义**：缺失 handoff 时把该 attempt 的 effective status 覆盖为 `"blocked"` + `error: member handoff required by execution config was not written for session <key>`。选 blocked 而非 failed 的取舍：

- 复用既有 observe-and-replan / 失败处理机械，不引入新的完成语义；
- fail-fast 只对 failed/skipped 触发，blocked 不会触发；因此门禁测试用 `completion.requireAllDelegationsSuccessful: true` + maxRounds 3 得到确定性的非 passed run（supervisor 会重试同一委派，最终 round 耗尽）。
- 取舍：blocked 语义上是" attempt 未完成"，与合同要求一致；但调用方若只看 failed 不看 blocked，门禁表现为"run 卡住/重试耗尽"而非显式失败。这是刻意保守——不破坏既有 run 完成路径（合同 stop condition 要求）。

**默认值**：OFF。Layer 2 的检测与事件始终生效；Layer 3 仅在显式开启时阻断。

---

## B. hub-reconcile 工具

`src/runtime/worktreeDelivery.ts` 新增两个导出（复用既有原语，不重写校验逻辑）：

### `inspectDeliveryChain(runDir, runId, { expectedMergeCommit? })` — 只读 dry-run

逐环校验，输出 `DeliveryChainReport { runId, status, highestRevision, projectionRevision?, findings[] }`：

- **快照环**：`delivery-revisions/<20位>.json` 逐文件检查 envelope（schemaVersion/revision）、文件名↔revision 对齐、record 经既有 `validateDeliveryRecord` 校验、record.revision↔快照 revision、event 五字段（id/type/actor/at/fromRevision/toRevision）对齐 record.lastEvent、revision 连续性（1..N 无空洞）。
- **投影环**：delivery.json 缺失/非法 JSON/record 非法/legacy v1 与快照并存/与最高有效快照 deep-equal/投影领先快照。
- **merge intent 环**（可选）：最高有效快照的 `sideEffects.merge.preparedMergeCommit` 与期望 mergeCommit 比对。
- `status`：`absent`（无快照无投影）/ `aligned`（零 finding）/ `corrupt`（任一 attention）/ `misaligned`（仅 repairable）。
- finding 分两级：`repairable`（可走 CAS 修复）与 `attention`（人工介入，阻断一切修复）。

### `repairDeliveryChain(runDir, runId, options)` — 显式 apply，全有或全无

- 前置：`inspectDeliveryChain` 结果非 `misaligned` 一律不动（corrupt 直接拒绝，applied 为空）——任何 attention 都阻断全部修复。
- 全程在既有 `withDeliveryMutex(runDir, ...)` 内。
- 修复顺序（逐步落盘、applied 列表可审计）：
  1. 文件名改名（`writeSyncedFile` 同目录 rename；目标名冲突 → 重新 inspect 并拒绝）；
  2. `record.lastEvent` 从**该快照自己的 event 块**重写（tmp + writeSyncedFile + rename + fsyncDirectory；event 证据本身永不触碰）；
  3. delivery.json 投影修复走既有 `RunDeliveryStore.repairProjectionFromSnapshot`（CAS 安全原语，未新写投影逻辑）。
- 修复后重新 inspect，返回 `{ ...after, applied, repaired }`。

**取舍**：lastEvent 重写严格来说修改了不可变快照文件。但该文件本已 corrupt（lastEvent 与 event 块不一致），重写来源是同一文件内未损坏的 event 块——不丢失任何有效不可变性，且这是唯一能在不伪造事件的前提下恢复一致性的来源。已在 finding.repair 文案与 applied 步骤中明确标注。

### 入口

- **CLI（已交付）**：`src/cli/main.ts` 新增 `workbench hub-reconcile <run-id> [--apply] [--merge-commit <sha>]`，默认 dry-run，JSON 报告写 stdout；corrupt 或 apply 后未对齐时 exit 1。
- **daemon API（未接，follow-up）**：`src/daemon/server.ts` 在 allow-list 内但本次未动——CLI 已满足合同"至少提供 CLI"。接 daemon API 需要新增路由 + 请求/响应类型，建议 Hub 单独立项。

---

## C. flake 根治（merge-queue-retest-preview worktree 清理竞态）

**根因**：delivery 状态机先落终态（validation.passed → mergeValidation.status=passed），`finally` 块里的 `.multi-agent/merge-validation` worktree 清理在其后异步发生。原断言在 delivery 终态后立即检查目录不存在——并行负载下清理尚未执行，偶发失败；隔离运行时清理足够快所以必过。这是真实的时序断言缺陷，不是实现 bug。

**修复**（`tests/merge-queue-retest-preview.test.ts`）：新增 `waitForValidationWorktreeCleanup(repo, timeoutMs = 10_000)`，100ms 轮询直到 `.multi-agent/merge-validation` 不存在或为空；超时仍失败并输出残留清单 JSON 作为证据。两个断言点（evidence-survival 用例与 cleanup 用例）统一改用该等待。

**无 retry/skip 掩盖**：没有重跑逻辑、没有 skip；等待的是被测不变量本身（清理最终发生），超时以证据失败。

---

## 验证证据

### 聚焦测试（18/18 通过）

```
npx vitest run tests/supervisor-handoff.test.ts tests/hub-reconcile.test.ts tests/merge-queue-retest-preview.test.ts
 ✓ tests/supervisor-handoff.test.ts (8 tests) 4652ms
   ✓ ... records handoffMissing on the member session turn and emits an event when no handoff is written (default: run still passes)
   ✓ ... treats an attempt without a handoff as blocked when the hard gate is enabled
 ✓ tests/hub-reconcile.test.ts (6 tests) 370ms
   ✓ aligned chain no-op / filename 错位检测+修复 / lastEvent 背离检测+修复 /
     projection 背离检测+修复 / projection 领先（attention）拒绝修复 / merge intent commit 比对
 ✓ tests/merge-queue-retest-preview.test.ts (4 tests) 9575ms
 Test Files  3 passed (3) ｜ Tests  18 passed (18)
```

A 项覆盖：prompt 强制指令存在（"MUST write your updated handoff" + "recorded as incomplete"）；不写 handoff → events.jsonl 含 `supervisor.member-session.handoff-missing`、第二次委派的 `memberSession.turns[0].handoffMissing === true`、run 仍 passed（默认 OFF）；env 开关 + `requireAllDelegationsSuccessful` 下 run 非 passed。

B 项覆盖：手工构造三类不对齐（文件名/lastEvent/delivery.json）dry-run 正确分类、apply 后 `readRunDelivery` 通过且链一致、健康记录 no-op、projection-ahead attention 全有或全无拒绝。

### typecheck

`npm run typecheck:server` → exit 0（修复了测试里一处 `session.turns` possibly-undefined）。

### 全量 check

`npm run check`（typecheck + 全量测试 + build）→ **exit 0**：

```
Test Files  110 passed (110)
     Tests  955 passed (955)
✓ built (client bundle)
```

无既有无关失败，未触发 stop condition。

### diff 卫生

`git diff --check` 干净；改动严格限于 allow-list 内 8 个文件 + 新增 `tests/hub-reconcile.test.ts`。未 commit、未 push、未重启 daemon。

---

## Caveats

1. **硬门禁表现为 blocked + 重试耗尽**，不是显式 failed run（见 A.Layer 3 取舍）。若产品上希望"缺失 handoff = 显式失败"，需要在 completion 语义里新增 blocked→failed 映射，超出"不破坏既有 run 完成路径"的保守边界。
2. **daemon API 未接**：hub-reconcile 仅 CLI 入口。daemon 路由建议后续立项。
3. **env 开关是进程级的**：`MULTI_AGENT_REQUIRE_MEMBER_HANDOFF` 影响该进程启动的所有 run；按 run 控制请用 `RunWorkflowOptions.requireMemberHandoff`（CLI `--require-member-handoff`）。
4. **lastEvent 修复修改 corrupt 快照文件**（见 B 取舍）——修复的是已损坏文件，来源为同文件 event 块。
5. Management Policy 路径的裁剪行为（execution 只剩 isolation）是本次调查的附带发现，若未来要把 handoff 门禁做进 Policy，需要先改 `normalizeManagementPolicy` 与 core/types.ts（均在本合同 allow-list 外）。
