# Phase 01 · Provider 数据契约

## 实现

- 在 `ProviderDefinition` 增加可选 `model` 元数据。
- command/mock adapter 校验 `model` 必须是非空字符串。
- 初始 mock Provider 登记 `deterministic-mock`，并为旧本地状态做无损补全。
- 前端由 `employee.providerId` 解析 Provider，不往 Employee 复制模型或命令。
- command 启动指令由 `command + args` 生成 shell-safe 文本。
- 支持从顶层或 shell 内层 `--model/-m` 读取模型；无值时显示“由 Provider 决定”。
- token、key、password、secret 等敏感 argv 值显示为 `***`。

## 测试

- adapter 接受合法 model，拒绝空 model。
- 显式 model、model flag、mock fallback 和 shell wrapper 摘要均有单元测试。
- 直接参数与 shell 内层命令的敏感值脱敏有单元测试。
