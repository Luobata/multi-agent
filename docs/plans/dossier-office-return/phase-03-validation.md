# Phase 03 · 验证与交付

## 自动验证

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run check`

## 本地数据

- 通过 Provider API 为已确认的本地 Provider 登记显式模型。
- 不直接编辑 `.multi-agent/` 运行数据。
- 重启 daemon 后核对 `/api/bootstrap` 返回 model。

## 浏览器 QA

- 依次检查 employees、workflows、runs、publications。
- 覆盖 320、768、1280、1440px。
- 检查页面级溢出、文字截断、弹窗焦点、移动底栏和堆叠布局。
- 员工卡必须可见模型与启动摘要；Provider 详情必须显示完整且脱敏的 argv。
- 保存最终截图，最后恢复用户当前的 employees 页面。
