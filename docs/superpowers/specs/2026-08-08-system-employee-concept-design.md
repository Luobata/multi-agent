# 系统员工（System Employee）一等概念设计

状态：设计待评审
日期：2026-08-08
主题：把“系统员工”从纯 metadata 标注升级为系统认定的一等概念，并施加访问/生命周期约束

## 1. 背景与问题

探查确认：`employeeKind` 字段目前**没有任何代码消费**——`isSystemManagedProviderId` 管的是 provider，不是员工。小配（配置管家）、小知（知识管家）、小忆（运行经验提炼器）的 `employeeKind` 全是写在模板 metadata 里的**纯标注**，系统不认、`listEmployees` 扁平返回、UI 不区分。结果：这些内部员工和业务员工混排，且没有任何约束防止它们被误绑定/误发布/误调/误删。

**目标**：加一个显式字段把“系统员工”变成一等概念，据此施加 4 类约束。

## 2. 数据模型

在 `EmployeeDefinition` 与 `EmployeeCreateInput`（`src/workbench/types.ts`）新增可选字段：

```ts
systemRole?: "automatic" | "conversational";
```

- `automatic`：系统自动触发型（小忆）——禁人工直调。
- `conversational`：对话控制型（小配 / 小知 / 未来的小关）——允许人从专用入口对话调用。
- 缺省（无字段）：业务员工，现状完全不变。

采用**新显式字段**而非复用 `metadata.employeeKind`（metadata 是自由形式、不可靠）。旧模板里的 `employeeKind` metadata 保留但不再承载语义；模板迁移见 §4。

## 3. 约束矩阵

| 约束 | automatic | conversational | 业务 |
|---|---|---|---|
| UI 单独分区标识（**不折叠**） | ✓ | ✓ | 正常 |
| 禁绑定为项目角色 | ✓ | ✓ | 允许 |
| 禁对外发布 Publication | ✓ | ✓ | 允许 |
| 禁人工直调（source=workbench 的直调） | ✓ 拒绝 | 允许（专用入口） | 允许 |
| 只读 / 防误删（**软保护**：默认拒绝编辑/归档，显式确认后可改） | ✓ | ✓ | 允许 |

**关键细节**：
- “禁人工直调”只拦**人工来源**（`InvocationSource.kind === "workbench"` 的直接调用）。系统自动触发（小忆经 `extractMemoryForRun` 内部 `invokeEmployee`）不走这条拦截。
- **软保护**：`updateEmployee` / `archiveEmployee` 对系统员工默认拒绝并提示，但接受一个显式确认标志（如 `allowSystemEmployeeMutation: true`）后放行——这样小忆等的 prompt 以后可调，不必删了重建。

## 4. 实现落点

- **types**：`EmployeeDefinition` + `EmployeeCreateInput` 加 `systemRole`；`buildEmployeeDefinition` 透传。
- **service 校验**（`src/workbench/service.ts`）：
  - `bindProjectRole`：目标员工有 systemRole → 抛错拒绝。
  - `createPublication`：目标是系统员工 → 拒绝。
  - `invokeEmployee`（人工来源路径）：`systemRole === "automatic"` 且来源为人工 → 拒绝。
  - `updateEmployee` / `archiveEmployee`：系统员工 + 无确认标志 → 拒绝并提示。
  - 一个纯 helper `isSystemEmployee(e)` / `systemRoleOf(e)` 便于测试与复用。
- **client**（`EmployeePage` / `OfficePage`）：按 `systemRole` 分区展示，加“系统员工”标识区；不折叠。
- **模板迁移**：
  - `memory-summarizer.employee.json` → `systemRole: "automatic"`
  - `configuration-steward` / `knowledge-steward` → `systemRole: "conversational"`
  - 保留其 metadata.employeeKind 不动（向后兼容）。
- **小关预留**：spec/文档注明“小关（下一轮实现）将是 `conversational` 系统员工”，本轮不写代码。

## 5. 边界（YAGNI）

- 不做默认折叠（用户明确：员工不多，分区标识即可）。
- 不实现小关（gate-control-conversation / WorkflowChangeRequest 下一轮独立做）。
- 不迁移删除旧 `employeeKind` metadata（保留，避免破坏）。
- 只读用软保护，不做硬只读。

## 6. 错误处理

- 所有拒绝都给**明确的中文错误信息**，说明“这是系统员工（systemRole=…），不允许 X；如需 Y 请通过 Z”。
- 校验失败不影响其它员工/运行。

## 7. 测试策略

- **service 单测**：系统员工被拒绑定 / 拒发布 / 拒人工直调 / 拒编辑归档（无确认）；带确认标志可编辑；automatic 拒人工直调但允许系统自动触发；conversational 允许人工调；业务员工全部不受影响（回归）。
- **client 测试**：员工列表按 systemRole 分区渲染，系统员工出现在系统区。
- 全量 `npm run check` 绿。

## 8. 组件边界小结

| 组件 | 职责 |
|---|---|
| `systemRole` 字段 + `isSystemEmployee` helper | 认定与判定 |
| service 校验（bind/publish/invoke/update/archive） | 施加 4 类约束 |
| client 列表分区 | UI 区分 |
| 模板 systemRole 标注 | 让现有 3 个内部员工被认定 |
