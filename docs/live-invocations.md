# 实时调用与员工出勤模型

## 1. 产品取向

Workbench 不是主要的任务分发器。它负责定义员工、组合团队、建立稳定调用包，并观察其他会话发起的工作。内部“直接交办”和 Workflow 运行按钮是调试台；正式调用入口优先使用 MCP Publication 或 A2A Publication。

```text
Publication（单 Agent / 多 Agent 调用包）
  └─ Invocation（一次外部请求）
       ├─ Work Instance（员工 A 在节点 1 的一次出勤）
       ├─ Work Instance（员工 B 在节点 2 的一次出勤）
       └─ Run（不可变输入、Prompt、输出与事件证据）
```

Employee 是长期身份。并发调用不会复制 Employee；每次节点执行只创建一个临时 Work Instance。UI 可以用“出勤分身”表达游戏感，但持久模型始终使用 `WorkInstanceRecord`，避免与“克隆员工档案”混淆。

## 2. 隔离和并发

- 每个 Work Instance 固定 Employee 版本、Provider、模型元数据、Run、节点和调用来源。
- 不同 Session 可以并发使用同一个 Employee；员工大厅显示 `工作中 ×N`。
- 同一 Session 的调用按进入顺序排队，等待实例使用 `waiting-session` 阶段，防止会话历史交叉写入。
- 单 Agent Publication 使用相同来源与 `contextId` 再次调用时，会继续同一条版本固定 Session；省略 `contextId` 时每次创建独立 Session。
- Workflow 的依赖节点在启动前显示 `waiting-dependencies`；真正进入 Provider 时才显示 `running` 并触发头像动作。
- Publication 只暴露稳定入口，不暴露内部 Prompt、Skill 配置和 Graph 结构。

## 3. 状态

Invocation：

```text
queued → running → completed | blocked | failed | cancelled
```

Work Instance：

```text
queued | waiting → running → completed | blocked | failed | skipped | cancelled
```

Invocation 和 Work Instance 都持久保存状态迁移。Run Store 另外保存 `run.started`、`node.started`、每次 attempt、节点终态和 Run 终态。daemon 重启时，未完成的持久实例会标记为 `failed/interrupted`，而不会伪装成仍在运行。

## 4. 调用来源

统一来源字段支持 `workbench`、`http`、`mcp` 和 `a2a`。HTTP 调用方可以附带：

```text
X-Multi-Agent-Source: http
X-Multi-Agent-Source-Label: Codex task
X-Multi-Agent-Project: cart-fe
X-Multi-Agent-Caller: reviewer
X-Multi-Agent-Context: thread-id
```

A2A 自动记录 Publication、context ID 和 task ID。MCP 的调用工具接受可选 `project`、`contextId` 和 `caller`。

## 5. API

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/activity` | 最近 Invocation 和 Work Instance 快照 |
| GET | `/api/activity/stream` | SSE 快照、状态迁移和实时节点事件 |
| POST | `/api/publications/:id/invoke` | 通过稳定调用包执行单 Agent 或多 Agent 团队 |

MCP 推荐入口：

```json
{
  "tool": "invoke_publication",
  "arguments": {
    "publicationId": "design-review-team",
    "input": { "message": "检查当前页面" },
    "project": "local-agent-workbench",
    "contextId": "calling-conversation-id"
  }
}
```

## 6. UI 责任

- 员工大厅：实时状态、并发数量、调用来源、当前节点、模型、上下文 ID 和耗时。
- 员工档案：身份、Prompt、Skill、Provider、版本与 Session 上下文。
- 协作编排：在详情中生成可复制给其他 Codex 会话的提示词与 MCP 参数；优先使用活动 Publication，未打包时明确回退到 Workflow 调试入口。
- 调用包：把 Employee 或 Workflow 发布成 MCP/A2A/HTTP 稳定入口。
- 运行卷宗：只读 Run 证据；通过 SSE 触发刷新，不承担员工身份状态。

运行中的员工才使用轻微上下移动画；排队和依赖等待使用不同的静态/呼吸反馈。`prefers-reduced-motion` 下关闭持续动画。
