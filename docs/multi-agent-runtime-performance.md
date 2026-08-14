# Multi-Agent 运行性能与可靠性优化

## 1. 目标与范围

本文记录 Local Agent Workbench 多 Agent 运行变慢、Provider 超时和重复执行问题的证据、原因、已落地改造及后续边界。

本轮目标不是简单延长超时时间，而是先做到：

1. 没有依赖关系的慢节点不再阻塞已经满足依赖的下游节点。
2. 超时、预算耗尽、校验失败等确定性故障不再自动完整重跑。
3. Web 与 MCP 调用长 Workflow 时立即获得受理结果，不再用一次长 HTTP 请求等待整个工作流。
4. 每次失败保留可解释的分类、耗时和是否重试证据。

取消、断点续跑、跨进程全局并发控制和上下文压缩不在本轮冒充完成，统一列入后续阶段。

## 2. 本地运行证据

以下数字来自 2026-08-01 当时本机 `.multi-agent` Run 证据，只用于定位当前项目瓶颈，不等同于线上 SLA：

| 观察范围 | 结果 | 说明 |
| --- | ---: | --- |
| 当日已完成 Run | 22 | 18 个通过，4 个失败 |
| 当日发生重试的 Run | 7 | 重试比例偏高 |
| 当日命中超时的 Run | 3 | p90 总耗时约 1,288 秒 |
| 10 个前后端实现类 Run | 中位数约 12.7 分钟，平均约 14.9 分钟 | Provider 执行占主要时间 |
| 已有完整历史中的已完成 Run | 39 | 8 个失败，11 个发生重试；3 个 Run 共出现 4 次超时 attempt |
| Provider 调用前准备 | 中位数约 32ms，平均约 44ms | 当前 Resolver、Router 与知识物化不是主要耗时来源 |

旧配置中一次 Provider 最长等待 900 秒，`maxAttempts = 2` 时，同一确定性失败可能连续执行两次，单节点最坏等待约 30 分钟。已有证据中还出现过：

- Codex 在 15 分钟超时时仍持续修改文件，说明固定墙钟超时可能中断有效工作。
- Claude/Kimi 以 `error_max_budget_usd` 结束后被完整重试，第二次会重新消耗时间和预算。
- 同一 Session 的排队只在单进程内生效；多个 CLI/daemon 进程仍可能同时调用同一员工。
- `state.json` 约 1MB，其中 Session 历史占比较高；单次 prompt 平均约 38KB、最大约 104KB。它们还不是当前第一瓶颈，但会随使用量增长。

## 3. 根因判断

### 3.1 Provider 执行是当前主耗时

调用前的权限解析、知识路由和运行清单物化通常只有几十毫秒，而单次模型执行以分钟计。当前首先要治理 Provider 生命周期、重试策略和用户等待方式，而不是绕过知识控制层。

### 3.2 旧 Graph 存在整层屏障

旧调度按编译出的 `waves` 逐层等待。同一层只要有一个慢节点，下一层所有节点都会等待，即使其中某个节点自己的依赖早已完成。

示例：`A` 与 `B` 同层并行，`C` 只依赖 `A`。旧行为必须等待 `A + B` 都结束才启动 `C`；新行为在 `A` 结束后即可启动 `C`。

### 3.3 重试没有区分失败性质

超时、预算耗尽、输出 Schema 不合法、启动配置错误通常不会因原样再跑一次自动恢复。统一重试会把 15 分钟失败扩大成 30 分钟，并重复消耗预算。真正适合重试的是明确的限流、服务过载、临时网络中断等瞬态故障。

### 3.4 同步入口把模型耗时传递给调用方

原 `/run` 与 MCP `run_workflow` 会等整个 Workflow 结束才返回。浏览器、反向代理或 MCP 客户端自身都可能先超时；即使后台仍在工作，用户也无法快速得到“已受理”和可追踪编号。

### 3.5 运行状态仍以单 daemon 内存所有权为主

本轮异步任务的执行所有权仍由当前 daemon 内存持有。恢复材料完整且没有 pending 人工决定的 Workflow 可在重启后从同一个 Run 的节点检查点重放，但原 Provider 进程不会恢复，也没有持久 owner/lease、跨进程 Session 锁、Provider 全局配额或项目写入租约。因此当前恢复语义不是跨进程恰好一次执行，仍不适合把本地 daemon 直接扩展为多人共享运行集群。

## 4. 本轮已落地改造

### 4.1 依赖就绪调度

Graph 执行器改为维护 `pending` 与 `running` 集合：

- 节点自己的全部依赖进入终态后即可进入可运行队列。
- 每完成一个节点立即补充空闲并发槽，不再等待整个 wave。
- `maxConcurrency` 继续生效。
- `failFast` 触发后停止发起新节点，已经运行的兄弟节点允许正常收尾，未启动节点记录为 `skipped`。
- 编译结果继续保留 `waves`，用于计划解释和可视化，不再作为运行时屏障。

### 4.2 分类失败与有限重试

Provider 故障统一归类为：

- `aborted`
- `budget`
- `rate-limit`
- `start`
- `timeout`
- `exit`
- `unknown`

默认不重试。只有 Adapter 明确标记 `retryable: true` 的瞬态错误才会进入下一次 attempt。目前限流、429、服务过载和部分临时网络错误可重试；预算耗尽、固定超时、进程启动失败、普通非零退出和校验错误不重试。

每次失败的 `error.json` 与运行事件会保存：

- `kind`
- `retryable`
- `willRetry`
- `durationMs`

这样可以区分“失败过一次后恢复”和“重复执行仍不会恢复”。

### 4.3 异步 Workflow 入口

新增首选 HTTP 调用：

```text
POST /api/workflows/:id/start
```

服务验证并建立 Invocation 后立即返回 `202 Accepted`，响应包含：

- `invocation`：本次调用记录。
- `runId`：Run Store 证据编号。
- `statusUrl`：本次 Invocation 的查询地址。
- `streamUrl`：活动状态 SSE 地址。

状态查询入口：

```text
GET /api/invocations/:id
```

返回 Invocation、节点 Work Instance，以及已经可用的 Run 证据。

MCP 同步新增：

- `start_workflow`：立即开始并返回调用编号。
- `start_publication`：通过稳定的 Workflow Publication 异步开始并返回调用编号。
- `wait_workflow_progress`：基于 cursor 长轮询，变化或默认 30 秒心跳时返回；非终态由宿主继续同一回合。
- `resume_workflow_monitor`：已知 `runId` 时恢复 Invocation 与监听回执。
- `get_invocation`：查询运行状态和最终证据。

原 `/api/workflows/:id/run` 与 `run_workflow` 暂时保留为兼容入口，但新的长任务调用应默认使用异步入口。

### 4.4 中止信号基础能力

Runtime 已能把 `AbortSignal` 传递到 Provider Adapter；command 与 Codex 子进程收到中止后会先终止，再在必要时强制结束。当前还没有对外开放取消 API，因为取消权限、幂等性和 Run 状态收敛需要与持久执行所有权一起设计。

### 4.5 前端非阻塞交互

Workflow 页面改为向异步入口提交。界面中的“运行中”只覆盖提交阶段；服务受理后立即展示 `runId`，并引导用户到运行卷宗或办公室查看后续进度，避免按钮持续等待数分钟。

## 5. 推荐调用方式

对 Web 或 MCP 客户端，统一采用“启动—观察—取证”三步：

1. 为一次逻辑启动生成稳定的 `idempotencyKey`，调用 `start_workflow`、`start_publication` 或对应的 `POST /start`，保存 `invocationId`、`runId` 与 `monitor.initialCursor`；网络重试必须复用原 key，新的逻辑运行必须使用新 key。
2. MCP 会话立即循环 `wait_workflow_progress`，每次传入上次的 `nextCursor`；`terminal=false` 时不得结束当前回合。只有 changed/terminal 结果进入模型或向用户转述，heartbeat 仅作为 transport keepalive。Web 界面也可通过 SSE 观察整体活动。
3. Invocation 进入终态后读取 Run 证据并交付规范化结果。连接中断时使用 `resume_workflow_monitor(runId)` 重挂，不能把 HTTP 连接存活视为任务存活。

调用方超时只应表示“本次查询没有及时返回”，不能直接推断后台 Workflow 失败。后续增加取消能力时，也必须显式调用取消命令，不能依靠浏览器断开连接隐式取消。

## 6. 验收标准

本轮以以下自动化行为作为门禁：

- 当 `C` 只依赖较快的 `A` 时，`C` 会在同层较慢的 `B` 完成前启动。
- `maxConcurrency` 与 `failFast` 语义保持有效。
- 预算耗尽和确定性失败不会重复 attempt。
- 明确标记的瞬态错误仍会按配置重试。
- 异步 HTTP 返回 202，随后可由 Invocation 查询得到运行中与最终状态。
- MCP 暴露并可调用 `start_workflow`、`get_invocation`。
- Workflow Publication 可通过 `start_publication` 异步启动，并能通过 `runId` 恢复监听。
- 旧同步入口继续兼容。
- 前端提交后立即恢复可操作状态，并显示可追踪的 Run 编号。
- 仓库最终通过 `npm run check`。

## 7. 下一阶段（P1）

### 7.1 持久执行队列与租约

- 将异步执行所有权从 daemon 内存 Map 升级为持久队列。
- 为 Invocation 增加 owner、lease、heartbeat 与幂等启动键。
- daemon 重启时区分可恢复、已失联和需要人工处理的任务，并同步修正 Run Store 与活动状态。

### 7.2 全局并发与工作区安全

- Session 顺序锁从进程内扩展到跨进程。
- 为每个 Provider 设置全局并发和速率预算，不只限制单个 Graph。
- 对同一项目区分只读并发与写入租约；多个写员工优先使用隔离 worktree，再由明确流程合并。

### 7.3 可取消、可续跑的长任务

- 对外提供带权限校验的取消 API/MCP Tool。
- Provider 增加结构化心跳，区分“仍在有效工作”和“无输出卡死”。
- 将单一绝对超时拆成空闲超时、阶段预算与最终上限。
- 在安全边界内保存检查点，避免有效工作因瞬态故障从头再来。

### 7.4 上下文与状态瘦身

- Skill 按需加载，避免把完整能力说明反复内联到每次 prompt。
- 上游节点只投影下游需要的字段，不传递完整原始输出。
- Session 使用摘要加最近窗口，原始历史仍保存在 Run Store。
- 拆分单体 `state.json`，为常用索引和启动数据建立增量缓存。
- 为知识索引增加版本缓存、去重和按已授权集合读取，避免知识库增长后每次全量扫描。

## 8. 决策记录

- 不以继续提高 900 秒超时作为首要方案。长任务应该异步、可观察、可恢复，而不是要求调用方维持更久连接。
- 不删除同步入口，先提供兼容期；新 UI 与新 MCP 调用默认转向异步入口。
- 不为了提速绕过 Resolver、Router、权限检查或 Run Store。当前证据表明它们不是主瓶颈，绕过会损失访问边界与审计能力。
- 不对所有错误自动重试。重试是 Provider Adapter 对瞬态故障的显式判断，不是 Workflow 的默认兜底。
- `waves` 保留为解释模型，运行时使用依赖就绪队列；计划可读性与调度效率保持分层。
