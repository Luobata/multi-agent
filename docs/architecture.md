# 架构说明与抽象来源

## 1. 从源方案保留了什么

本项目对 `cart-fe-workflow-review` 做了只读分析，没有修改该仓库。源方案中最值得复用的不是三个具体角色，而是以下结构：

| 源方案结构 | 可复用含义 | 本项目落点 |
| --- | --- | --- |
| Provider registry 与 Role registry 分离 | 角色身份不绑定模型供应商 | manifest 的 `providers` / `roles` |
| 稳定身份与单次请求分离 | 背景、职责和能力不应混进每次任务输入 | `identity` + `skills` + `instructions` / `requestTemplate` |
| 每个角色声明 JSON Schema | 输出先结构化，再进入流程 | `outputSchema` + AJV 校验 |
| 三个验收角色并行启动 | 独立证据不应串行放大延迟 | Workflow DAG 的同一 wave |
| 每次运行保存 prompt、raw output、report | 结论必须可追溯 | `.multi-agent/runs/<run-id>` |
| Pass/Block 与进程失败分开 | 领域否决不等于系统故障 | `blocked` / `failed` 状态 |
| Provider 输出 envelope adapter | 供应商格式不污染角色逻辑 | `outputProtocol` |

## 2. 没有照搬什么

源方案为了服务一个具体评审产品，存在合理但不适合通用库的耦合：

- 角色 ID 是 TypeScript union，新增角色需要改源码。
- 产品、设计、测试各有一套相似的 runner、parser、report builder 和落盘流程。
- 运行上下文直接依赖 Review Bundle、session event、dashboard URL 和特定目录布局。
- 异步 job 与 HTTP 路由绑定，进程重启后运行态不可恢复。
- `claude-relay`、`claude-kimi` zsh alias 和 Claude Code 参数属于本机 Provider 细节。
- 三角色聚合由固定 endpoint 完成，不是可扩展的 DAG。

本项目把这些部分改为 manifest、通用模板上下文、可组合 Role Profile、Architecture Adapter 和显式工作流配置。示例角色只是模板，不进入核心代码。

## 3. 架构模型

### Authoring Plane

Authoring Plane 负责“设计是否合理”：

1. 用 Role Profile 的 `identity` 表达背景、职责、目标、约束和业务元数据。
2. 用 Skill registry 表达可复用能力、配置契约和所需工具；Role 只组合需要的 Skill。
3. 用 Role 的请求模板与输出 Schema 表达单次交接契约，不把运行输入固化进身份。
4. 用 Workflow 选择协作架构；当前 `graph` 用 Node 表达具体执行，用 `needs` 表达真实信息依赖。
5. 用 verdict 定义领域 Pass/Block，不用自然语言猜结果。

CLI 的 `validate` 和 `plan` 都不调用模型，适合在设计阶段快速迭代。

### Runtime Plane

Runtime Plane 负责“执行是否确定”：

1. 将 Workflow 分派给已注册的 Architecture Adapter。
2. 由 Adapter 校验配置、编译计划、生成文本/Mermaid 表示并执行该模式的控制流。
3. 当前 `graph` Adapter 把 DAG 编译为并行 wave，并在并发上限内启动同一 wave 的节点。
4. Runtime 将 `input`、依赖结果、组合后的 Role Profile、有效工具和运行目录注入模板。
5. Provider Adapter 启动进程，并区分超时、非零退出、解析失败和 Schema 失败。
6. 只对技术失败重试；`Block` 是有效领域结论，不自动重试。
7. 先保存系统 prompt、请求 prompt 和原始输出，再保存规范化结果与状态事件。

如果依赖节点为 `Block`，综合节点仍可运行并解释分歧；如果依赖节点技术失败，下游节点会 `skipped`，避免把缺失证据当成一致意见。

## 4. 为什么现在增加 MCP，但不让它承担编排

Workbench 阶段已经出现了适合 MCP 的真实条件：

- 任意 MCP 会话需要发现和调用同一批本地 Employee；
- UI、CLI 与会话入口需要共享一份 Session/Run Store；
- Employee context、Workflow 启动和 Run 查询需要成为标准工具。

因此 v1 增加了一个薄 stdio MCP server，但它只代理 loopback daemon。确定性校验、Graph 计划、Provider 调用、版本固定和证据持久化仍在 TypeScript core。A2A 同样只负责把一个 Publication 暴露为 Agent Card/Task/Artifact。MCP、A2A 都不替代 Architecture Adapter。

## 5. 为什么 Skill 不能做核心

Skill 适合帮助 Codex 判断：是否真的需要多个角色、如何拆责任、哪些节点可并行、怎样设计输出契约。它不适合负责：

- 循环依赖检测；
- 并发上限与超时；
- 结构化输出验证；
- 进程退出与重试；
- 原子落盘和运行状态；
- CI 中稳定的退出码。

因此本项目中的 Skill 只指导创建和审阅 manifest，并调用 CLI 完成确定性检查。

## 6. 扩展顺序

建议按真实需求逐步扩展：

1. 增加具体 Provider adapter，并把权限声明编译为供应商的 sandbox/tool flags。
2. 在 `graph` 内增加条件节点、人工审批节点、显式 gate policy，以及可复用的 fan-out/gather/debate 模板。
3. 只有出现不同控制循环时才增加 Architecture Adapter，例如 supervisor、handoff 或动态 group-chat。
4. 将文件 state/Run Store 替换为可恢复的 SQLite store，并增加取消、续跑和幂等 run key。
5. 为现有 MCP/A2A/HTTP 门面增加认证、tenant 隔离与 Plugin 分发。

不要先增加“更多角色”。先确认每个角色是否拥有独立责任、独立证据源和机器可检查的交接契约。
