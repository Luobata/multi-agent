# 档案室视觉回归与 Provider 运行身份

## 目标

回到用户确认的暖灰纸质人事档案风格，并让每位员工显示实际 Provider 的模型与启动指令，不改变 Employee/Provider 分层。

## 约束

- Employee 只持有 `providerId`。
- `model` 是 Provider 可选元数据，adapter 定义仍负责执行。
- 未知模型不猜测；启动参数中的敏感值必须脱敏。
- 不改 Provider、Skill、Role、Architecture、Workflow、Run Store、MCP、A2A 的边界。
- 保持 mock Provider 示例可运行，并通过 `npm run check`。

## 阶段

1. Provider 数据契约：扩展类型、校验、状态迁移与展示解析。
2. 档案室视觉回归：替换 token、组件表面、品牌和响应式表现。
3. 验证：单元测试、构建、daemon 重启和多视口浏览器 QA。

## 完成定义

- 员工列表卡显示模型与启动摘要。
- 员工 Provider 区显示实例、模型、adapter、启动 argv 和最大尝试。
- 视觉不再出现暗色、霓虹、扫描线、像素切角或发光。
- 四个路由在 320–1440px 无页面级横向溢出。
