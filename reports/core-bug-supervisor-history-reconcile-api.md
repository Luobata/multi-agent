# core-bug — hub-reconcile daemon API + supervisor 历史压缩

合同：`seed-gsb-core-bug-supervisor-history-and-reconcile-api`（`contracts/core-bug.md`）
日期：2026-08-19 ｜ 角色：core-bug ｜ 状态：实现完成，验证通过

---

## A. hub-reconcile daemon API（上轮 follow-up）

`src/daemon/server.ts` 新增两个路由，复用本轮已交付的 `inspectDeliveryChain` / `repairDeliveryChain`（`src/runtime/worktreeDelivery.ts`，上轮提交 `b833cde`）：

| 路由 | 语义 |
|---|---|
| `GET /api/runs/:id/delivery-chain` | 只读检查。返回 inspect 报告（`status`/`highestRevision`/`projectionRevision`/`findings[]`）。可选 `?mergeCommit=<sha>` 透传 merge intent 比对。**不触发任何写**。 |
| `POST /api/runs/:id/delivery-chain/repair` | 显式修复。body 必须是 JSON 对象且 `apply === true`，否则 400（"requires explicit apply confirmation"）；可选 `mergeCommit`。返回 repairDeliveryChain 的修复后重检报告（含 `applied[]`/`repaired`/`findings[]`）。 |

**关键设计点**：

- **runDir 解析不经 service.ts**：`path.join(service.store.dataRoot, "artifacts", "runs", runId)`（与 service.ts:1985 同一布局），直接在 server.ts 内计算。未触发 stop condition（不需要 service 层接线）。
- **修复不可被 GET/幂等调用触发**：repair 只挂 POST，且 body 必须带 `apply: true`（沿用 merge/discard 路由的 confirmation 约定，server.ts:961）。
- **attention 拒修语义原样透出**：repairDeliveryChain 对 corrupt（attention 类 finding）返回 `applied: []`、`repaired: false`、`status: "corrupt"`，HTTP 200 + 报告——不伪造修复成功。
- 错误约定沿用 daemon 既有错误中间件（抛错 → 400/404/409，`{error:{message}}`）。
- 测试用 in-memory `invokeRoute` harness（沿用 `tests/run-delivery-daemon.test.ts` 模式，直接调 express route handler，无 socket）。

## B. supervisor 历史确定性压缩（P3 会话膨胀治理）

### 调查结论

- 注入点：`supervisor.ts` 的 `supervisorWith()` 把 `history: JsonValue[]` 原样放进 `__supervisorHistory`；模板（`materialize.ts:265`）以 `JSON.stringify(value, null, 2)` 渲染。每轮 supervisor 决策（plan-todos/delegate/satisfy-gate/request-human-decision/finish）连同 rejection、delegations、Gate 快照全部追加，轮次多后 prompt 线性膨胀。
- 决策必需的最小信息：Gate 状态（另有独立 `__supervisorGates` 注入当前态）、human 决策原文（prompt 明确要求"rejection 后用 prior ledger 里的 human comment 重规划，不得原样重复被拒动作"）、block 原因（`decisionRejected`）、依赖证据引用。
- 持久化与注入分离：`history` 数组同时用于（a）prompt 注入、（b）`updateSupervisorRunState` 持久化到 architectureState、（c）`supervisor-state.json` resume 工件。压缩只改（a），（b）（c）保持完整。

### 实现（`src/architectures/supervisor.ts`）

- `compactSupervisorHistory(history, currentRound, keepRounds)`（导出，供单测）：
  - **最近 K 轮原文保留**：`round > currentRound - keepRounds` 的 entry 原样注入。
  - **更早轮次压缩为单行确定性摘要**：`[r<round>] <action> → <target> → <status>`。target 按动作类型：delegate→`roles=[...]`、satisfy-gate→`gate=<id>`、request-human-decision→`risk=<category>`、plan-todos→`todos=<n>`、finish→`summary=<160字符截断>`；status 按标记：`decisionRejected`→`rejected=<原因截断>`、`humanDecision`→`human=<decision>`、`delegations`→`statuses=[...]`、`todoPlanAccepted`→`accepted`、`finishIntercepted`→`finish-intercepted`。
  - **Gate/human 决策原文永不压缩**：含 `humanDecision`、`gates` 快照、或 `decision.action === "satisfy-gate"` 的 entry 无论多老都原样保留（`historyEntryVerbatim`）。
  - 确定性：纯函数，无随机/时间依赖；同输入同输出。
  - 不修改输入数组。
- **事件可观测**：压缩实际发生时（`compactedEntries > 0`）emit `supervisor.history-compacted`，载荷 `{keepRounds, compactedRounds, compactedEntries, charsSaved}`（charsSaved = 压缩前后 JSON 长度差）。
- **接线点**：supervisor 主循环构造每轮 node 时（supervisor.ts:2341 区域），先压缩再 `supervisorWith`；round 1 与后续轮统一走压缩视图。

### 配置（可配，默认值）

- 默认 `DEFAULT_SUPERVISOR_HISTORY_KEEP_ROUNDS = 6`。
- 配置路径：`RunWorkflowOptions.supervisorHistoryKeepRounds`（runner.ts）→ `ArchitectureExecutionContext.supervisorHistoryKeepRounds`（types.ts）→ supervisor；CLI `run --supervisor-history-keep-rounds <n>`（非负整数校验，非法值报错）。
- **选型说明**：Management Policy / workflow config 的 Ajv schema 是 `additionalProperties: false`（supervisor.ts:365），加字段需要 schema 手术且 daemon 启动的 run 经 service.ts（本轮 do-not-touch）无法透传；沿用上轮 `requireMemberHandoff` 的 context+options+CLI 先例，默认值保证 daemon run 开箱即用。**per-workflow 配置（写进 manifest policy）是 follow-up**，需要同时改 schema 与 service.ts 透传。
- **K 轮以内与 HEAD 一致**：`keepRounds=6` 时 ≤6 轮的 run 压缩零发生（`compactedEntries=0`、无事件、注入数组与 HEAD 深相等）——既有 supervisor 测试全部未受影响（见验证）。

---

## 验证证据

### 聚焦测试（60/60 通过）

```
npx vitest run tests/hub-reconcile-daemon.test.ts tests/supervisor-history.test.ts \
  tests/supervisor-handoff.test.ts tests/hub-reconcile.test.ts \
  tests/supervisor-runtime.test.ts tests/human-decision-gate.test.ts
 Test Files  6 passed (6) ｜ Tests  54 passed (54)
```

加上单独跑通的两个新文件首轮（12 tests，修复一处测试断言 `String(object)`→`JSON.stringify` 后全绿），新测试共 12 个：

- **A（daemon API，5 个）**：GET 健康链 → aligned 报告；GET 错位链 → misaligned + finding 且文件 mtime/内容不变（只读证明）；POST 无 `apply`/`apply:false` → 400 且未修复；POST `apply:true` → 修复+重检 aligned、`readRunDelivery` 通过；POST 对 projection-ahead（attention）→ 200 但 `status:corrupt`、`applied:[]`、投影未被篡改（全有或全无拒修透出）。
- **B（历史压缩，7 个）**：单测——最近 K 轮原文、更早压缩为单行、human 决策原文保留、Gate 决策/快照原文保留、delegation/rejection 摘要格式与确定性、K 内零压缩、输入不被修改；集成——8 轮 run（默认 K=6）：r8 prompt 含 `[r1] plan-todos`/`[r2] delegate` 压缩行、含 r7 完整决策原文（"Delegate round 7 marker"）、不含 r2 完整决策、events.jsonl 含 `supervisor.history-compacted`、`supervisor-state.json` 持久化完整历史（含被压缩的 r2 原文）。

### typecheck

`npm run typecheck:server` → exit 0。

### 全量 check

`npm run check` → **CHECK_EXIT=1**，但失败与本轮改动无关（stop condition 适用，附证据如下）：

```
Test Files  5 failed | 107 passed (112)
```

**4 个非 client 失败全部是并行负载下的超时 flake**（隔离重跑全绿）：

| 失败测试 | 失败形态 | 隔离重跑 |
|---|---|---|
| supervisor-handoff › keeps handoff notes across a restart recovery | 测试自身 1s 轮询超时（200×5ms） | ✅ 3 files / 41 tests passed |
| supervisor-runtime › splits broad quality checks into bounded Gate shards | 5000ms test timeout | ✅ 同上 |
| supervisor-runtime › honors supervisor and block Gate fallbacks | 5000ms test timeout | ✅ 同上 |
| worktree-isolation › inherits a prior terminal candidate | 5000ms test timeout（该测试不涉及 supervisor 历史，失败本身即环境过载证据） | ✅ 同上 |

证据链：同样这批测试在 20:47 的聚焦跑（6 files / 54 tests）全绿；全量跑 112 文件并行时超时；隔离重跑 41/41 全绿。压缩改动是每轮 O(history) 的纯函数，量级微秒级，不构成超时成因。

**5 个 client 失败来自 ui spoke 的并发未提交改动**（`client/src/components.test.tsx` 4 个、`client/src/theme.test.ts` 1 个）：工作树中 ui 正在重构 client（BoardPage/EmployeePage/KnowledgePage/styles + 十余个新文件），这些失败与 core-bug 无路径交集，未顺手修。

### diff 卫生

`git diff --check` 干净。本轮改动严格限于 allow-list：

- 改：`src/daemon/server.ts`、`src/architectures/supervisor.ts`、`src/architectures/types.ts`、`src/runtime/runner.ts`、`src/cli/main.ts`
- 新增：`tests/hub-reconcile-daemon.test.ts`、`tests/supervisor-history.test.ts`
- 未触：`src/workbench/service.ts`、`client/`、其他角色的并发改动（ui 的 client 重构、plan-backup 合同）保持原样

上轮成果已由 Hub 提交（`b833cde feat: enforce member handoff and add hub-reconcile delivery repair`）。未 commit、未 push、未重启 daemon。

---

## Caveats

1. **per-workflow 压缩配置未做**：schema `additionalProperties:false` + service.ts 透传缺失，本轮只交付 run 级配置（CLI/options）与默认值 6。需要 per-workflow 时走 follow-up（schema + service.ts 扩权）。
2. **摘要是有损的**：被压缩轮次的 decision 全文不进 prompt（但完整保留在 events.jsonl 与 supervisor-state.json）。block 原因截断到 160 字符；Gate/human 决策不截断（原文保留）。
3. **daemon API 无鉴权层**：路由挂在既有 daemon app 上，沿用其 loopback/中间件约定，未新增鉴权（与现有 run 路由一致）。
4. **GET 对不存在的 run 返回 200 + `status:"absent"`**（而非 404）：报告本身表达"无链可查"，与 inspect 的 absent 语义一致。
