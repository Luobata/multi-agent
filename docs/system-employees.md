# 系统员工（System Employee）

「系统员工」是 Local Agent Workbench 内部自用的一类 Employee：它们支撑系统自身的运行（自动提炼经验、起草配置、管理知识），而不是给外部工作流编排、绑定或对外发布使用。这类员工由 Employee 定义上的顶层 `systemRole` 字段标记，Workbench 据此对它们施加一组一致的边界约束。

本文只描述已实现的行为。

## `systemRole`：两级

`systemRole` 是 `EmployeeDefinition` 的可选顶层字段，只接受两个字面量之一；缺省（未设）即普通员工，不受本文任何约束。

- `"automatic"`：**自动型**。只能由系统内部触发，不支持人工直接调用。例如小忆（`memory-summarizer`）在每次运行结束后被系统自动调用做经验提炼。
- `"conversational"`：**对话型**。允许通过专用入口与之对话，但同样不参与外部绑定/发布。例如小配（配置管家）、小知（知识管理员）通过后台的受限控制面对话使用。

判定辅助函数（`src/workbench/service.ts`）：`systemRoleOf(e)` 返回规范化后的两级值或 `undefined`；`isSystemEmployee(e)` 即 `systemRoleOf(e) !== undefined`。创建/更新时会校验 `systemRole`，非法值直接报错。

## 四类约束

对被标记为系统员工的 Employee（即 `isSystemEmployee` 为真），Workbench 施加四类约束：

1. **UI 分区**：后台客户端把系统员工从外部员工列表中拆出来，单独归入「系统级员工」分区（`client/src/OfficePage.tsx`、`EmployeePage.tsx`）。发布页（`PublicationsPage.tsx`）与入口策略页（`EntrancePolicyPage.tsx`）的可选员工列表则把系统员工过滤掉，不作为候选出现。
2. **禁绑定 / 禁发布**：系统员工不允许被绑定为任意项目角色，也不允许对外发布；工作流若包含系统员工成员同样不允许发布。相关守卫在 `service.ts` 的项目角色绑定（`normalizeProjectRoleBinding`）与发布（`createPublication` 等）路径中，命中即抛错。**例外**：内部对话型系统员工（如小配 / 小知，`scope` 固定到自身内部项目）可以被绑定到**自己所属项目的角色**——这是它们唯一的调用入口（经 `invokeProjectRole` 调用，而非 `invokeEmployee` 直调）。守卫只在目标不是其自身内部项目时才拒绝，从而既防止系统员工泄漏为任意 / 外部项目角色，又不破坏内部员工的既有调用链路。
3. **禁人工直调（仅 `automatic`）**：`invokeEmployee` 中，`systemRole === "automatic"` 的员工只能由系统内部触发——内部触发以调用来源 `source.caller` 以 `"system:"` 前缀标记来识别（内部提炼链路使用 `INTERNAL_CALLER = "system:memory-extractor"`）。非内部来源的人工直接调用会被拒绝。这样既拦住了人工直调，又不会误伤小忆的自动提炼链路。`conversational` 系统员工不受此约束，可经其专用对话入口调用。
4. **软保护（编辑 / 归档）**：`updateEmployee` 与 `archiveEmployee` 默认拒绝修改 / 归档系统员工，属「软」保护——不是完全禁止，而是要求调用方显式确认。

## 软保护如何显式确认修改

`updateEmployee(id, input, options?)` 与 `archiveEmployee(id, options?)` 接受可选参数 `options.allowSystemEmployeeMutation`。默认（未传或为 `false`）时，对系统员工的修改 / 归档会抛错：

> 员工 `<id>` 是系统员工，默认受保护；如确需修改请显式确认（allowSystemEmployeeMutation）

只有显式传入 `{ allowSystemEmployeeMutation: true }` 才放行。这保证了针对系统员工的修改是一次有意的、明确的操作，避免被常规批量编辑流程误改。

## 现有系统员工

仓库内 `templates/workbench/` 下的四个内部员工模板已带 `systemRole`：

- `memory-summarizer.employee.json` → `"systemRole": "automatic"`（小忆 · 运行经验提炼器）
- `configuration-steward.employee.json` → `"systemRole": "conversational"`（小配 · 员工配置管家）
- `knowledge-steward.employee.json` → `"systemRole": "conversational"`（小知 · 项目知识管理员）
- `gate-steward.employee.json` → `"systemRole": "conversational"`（小关 · 工作流门禁管家）

这些模板同时保留了各自 `identity.metadata.employeeKind` 等既有元数据不变；`systemRole` 是新增的顶层标记，与旧元数据并存。

## 小关（Gate Steward）

小关（Gate Steward）作为 `conversational` 系统员工已实现，与小配 / 小知并列：通过受限的 Gate Control MCP 对话式管理 supervisor 工作流门禁，只提案 `WorkflowChangeRequest`、不审批、不 apply，审批走人工经 CLI / HTTP，UI 只读查看。详见 [小关（Gate Steward）· 工作流门禁管家](gate-steward.md)。
