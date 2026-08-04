# 有效执行配置与来源追踪

有效执行配置（Effective Execution Profile）不是 Employee 的新一级属性，也不是另一套 Prompt。它是每个运行节点在执行前，由 Workbench 根据已固定版本编译出的只读证据。

## 为什么存在

Employee、Project Contract、Project Binding、Skill、Knowledge Profile、Provider、Workflow 和 Task 分别由不同边界管理。运行时需要把它们组合起来，但组合结果不能成为新的人工维护表单。有效执行配置解决两个问题：

1. 展示本次运行最终生效了什么；
2. 说明每个值来自哪里、采用了追加、选择、覆盖还是权限收窄规则。

## 运行产物

每个节点准备时会写入：

```text
artifacts/runs/<run-id>/effective-profile/<node-id>.json
```

产物包含：

- 最终字段值和合并规则；
- Employee 与项目 assignment 的固定版本；
- Project Contract、Project Binding、Skill、Knowledge、Provider、Workflow、Task 的来源引用；
- 可供界面原地展开的不可变来源快照。

Provider 来源只保留适合审计的 adapter、model、runtime profile 和输出协议，不复制命令、参数、环境变量或工作目录。

## 查看方式

- 员工档案的“上下文检查器”展示该 Session 最近一次运行的有效配置；
- “运行卷宗”按节点展示所有有效配置；
- 每条来源可以原地展开完整快照；有管理台账的来源还提供跳转入口；
- 旧 Run 没有该产物时继续展示原有 Prompt 与 Knowledge 证据，不做推测性补编译。

## 边界

- Employee、Project、Skill 等版本化记录仍是唯一配置来源；
- Effective Prompt 仍是最终 Provider 输入证据；
- 有效执行配置只解释组合过程，不参与人工配置，也不反向修改来源；
- 后续新增 Cognitive 等配置组时，应先进入来源模型，再由编译器增加对应字段和合并规则。
