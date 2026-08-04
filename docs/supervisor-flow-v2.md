# Supervisor Flow v2：声明式 DAG 与动态领队

## 1. 目标

Flow v2 在现有 `supervisor` Architecture 内增加一张可选的声明式 DAG，不新增 Architecture Adapter。DAG 固定任务依赖、角色位置和交付顺序；领队负责补充任务、选择何时启动已就绪节点、观察结果并推进下一轮，但不能创建图外节点、提前运行下游节点、改派角色或覆盖节点的工作类型与 change set。

典型交付图：

```text
frontend-task -> frontend-test --\
                                  -> merge -> integration-test -> delivery
backend-task  -> backend-test  --/
```

`frontend-test`、`backend-test` 和 `integration-test` 可以引用同一个 `tester` roleId。Employee 身份和角色绑定不会被复制；每个 DAG 节点在 Run 中创建独立 WorkInstance。

## 2. 领域边界

- **Employee**：可复用的员工身份与固定版本。
- **Role slot**：Workflow 内的责任槽，绑定 Employee；例如 `tester`。
- **DAG node**：角色在流程中的一次声明式引用；多个节点可以复用同一 roleId。
- **WorkInstance**：某个 DAG 节点在一次 Run 中的实际执行实例。
- **Supervisor**：只能调度已声明且依赖已通过的节点，不能绕过 DAG。

Provider 调用、Skill、Role 身份、Architecture 控制流、Workflow 实例和 Run Store 继续保持分层。Flow v2 只扩展 supervisor 配置和 Adapter，不把 DAG 语义放进 Skill 或 MCP。

## 3. 数据契约

`SupervisorFlowDefinition` 保留原有 `stages` 和 `gates`，新增可选 `dag`：

```json
{
  "stages": [
    { "id": "plan", "kind": "supervisor", "title": "领队计划" },
    { "id": "delegation-loop", "kind": "delegation-loop", "title": "执行 DAG" },
    { "id": "delivery", "kind": "delivery", "title": "交付" }
  ],
  "gates": [],
  "dag": {
    "nodes": [
      {
        "nodeId": "frontend-task",
        "roleId": "frontend",
        "needs": [],
        "kind": "task",
        "task": "完成前端开发",
        "requiredCapabilities": ["code.frontend"],
        "workKind": "code",
        "changeSet": "frontend",
        "required": true
      }
    ]
  }
}
```

节点字段：

- `nodeId`：Workflow 内稳定且唯一的逻辑节点 ID。
- `roleId`：成员角色槽；作者输入兼容 `roleRef`，持久化时统一为 `roleId`。
- `needs`：必须全部通过的前置 DAG 节点。
- `kind`：`task | test | merge | integration | integration-test | other`。
- `task`：固定任务基线；领队可以补充或改写具体执行说明。
- `requiredCapabilities`：节点执行所需能力，领队只能追加，不能移除。
- `workKind`、`changeSet`：静态工作分类和变更边界，领队不能覆盖。
- `required`：为 true 时，节点未通过则禁止 finish。

## 4. 确定性校验

创建或修订 Workflow 时必须拒绝：

- 空 DAG、重复 nodeId、保留运行时 ID；
- 未绑定的 roleId、未知依赖、自依赖、重复依赖和环；
- merge 少于两个前置测试节点，或依赖非 test 节点；
- integration-test 未直接依赖 merge；
- 重复能力、非法 kind/workKind；
- DAG 节点引用不在 Management Policy 允许清册中的角色。

## 5. 运行语义

1. Run 从 `supervisor-r1` 开始，领队上下文包含 DAG 全量状态和 ready 标记。
2. DAG 模式下每个 delegate assignment 必须给出 `nodeId` 和匹配的 `roleId`。
3. 节点只有在所有 `needs` 已通过且自身尚未通过时可执行。
4. 同一轮多个合法节点通过现有并发调度并行执行。
5. WorkInstance 的 `needs` 同时包含当轮领队节点和所有前置节点的通过实例，保证 merge 和 integration-test 消费正确证据。
6. 成员失败时，`observe-and-replan` 策略允许领队重新运行尚未通过的同一逻辑节点；重试使用新的运行节点 ID。
7. 领队请求 finish 时，所有 required DAG 节点和 required Gate 必须通过。

越界 nodeId、错误 roleId、依赖未满足、重复调度、覆盖 workKind/changeSet 或缺少执行能力时，Run 进入 `blocked`，并写入 `supervisor.dag.blocked` 事件和 DAG 快照。

## 6. 兼容策略

- 没有 `flow.dag` 的现有 Supervisor Workflow 保持原输出 Schema、Prompt、节点命名和动态循环行为。
- 旧 Workflow 不自动推断 DAG；升级通过显式修订产生新版本。
- 已启动 Invocation 固定 Workflow、Employee、Policy 和 Skill 版本。
- 原 `graph` Adapter 不修改；Flow v2 是 supervisor 内的约束模板。

## 7. UI

协作编排页面的第 05 节使用与 Graph 编排一致的画布交互，但没有改变 Architecture 或运行时所有权：

- 节点可拖拽，方向键移动 8px，Shift + 方向键移动 24px；自动排版只更新 `presentation.positions`；
- 从上游节点右侧端口连接到下游节点左侧端口会写入下游的 `needs`，属性栏复选框提供完整的键盘编辑路径；
- 属性栏只编辑当前节点的 nodeId、roleId、kind、task、requiredCapabilities、workKind、changeSet 和 required；
- 相同 roleId 在多个节点显示相同角色徽标，但每个节点仍会创建独立 WorkInstance；
- “填入分支-合并示例骨架”生成开发、分支测试、合并、集成测试六节点示例；
- 未知依赖、循环、提前合并和集成测试缺少 merge 在画布旁实时展示，服务端校验仍是最终权威。

保存仍使用原有 `flow.dag`；`presentation.positions` 只保存有限坐标并过滤已删除节点。Graph Canvas 在这里是共享交互语义，不是 Graph Architecture，也不参与调度。运行时唯一调度中心仍是 Supervisor；没有 `flow.dag` 的旧 Workflow 不产生新的画布或调度语义。

## 8. 验收

- 前端与后端开发节点同轮并行。
- 前端测试与后端测试在对应开发通过后同轮并行。
- 任一分支测试未通过时 merge 不可运行。
- merge 通过后 integration-test 才可运行。
- tester role 被三个节点复用并产生三个独立 WorkInstance。
- 领队提前 merge、图外派单或改派角色时 Run blocked 且证据可读。
- 无 DAG 的旧 Supervisor 回归结果不变。
- `npm run check` 全部通过。
