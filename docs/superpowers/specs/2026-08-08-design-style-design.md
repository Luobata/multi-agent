# 设计风格沉淀设计（#4）

状态：设计待评审
日期：2026-08-08
主题：把设计风格（双叶幼儿园/治愈像素等）沉淀成可复用形态——可注入指令入 Skill，参考资料入 Knowledge

## 1. 背景与目标

已有设计资产散落：design.md（118 行视觉契约）、client/src/theme.ts + tokens.css（crayon/pixel 双主题 token）、docs/avatar-sources.md。用户希望"一个关键词就能和员工描述整套风格"。

**决策（已确认）**：
- **可注入的风格指令 → Skill**（员工绑定即注入 prompt）。
- **参考资料 → Knowledge base**（按需检索，不注入）。

## 2. 划分（依据 design.md 结构）

**Skill `design-style-futaba`（指令，注入）** —— 提取 design.md 中可执行的风格规则：
- §2 核心色彩（token 角色与用途）
- §3 字体/像素/密度（2px 硬边、针脚虚线、硬阴影、按压反馈）
- §3.1 皮肤切换（crayon/pixel）
- §5 视觉组件规范（Shell/角色卡/表单/弹窗的硬性规则）
- §7 交互与无障碍（键盘焦点、状态矩阵、对比度、reduced-motion）
- 表达为 skill `instructions`：简洁、祈使句、可直接指导生成。`injection` 设为注入态（照现有 skill 模板的 injection 字段）。

**Knowledge base `design-language-reference`（参考，检索）** —— 收纳理念与素材：
- §1 产品隐喻、§4 应用骨架与季节路由、§6 Provider/架构边界、§8 验收清单
- avatar-sources.md 内容
- design.md 全文作为一个 source（保留完整上下文供检索）

## 3. 落地形态

- **Skill 模板**：`templates/workbench/design-style-futaba.skill.json`（照现有 *.skill.json：id/version/status/displayName/description/summary/instructions/tools:[]/owner/injection/时间戳）。tools 为空（纯风格指令，不带工具）。
- **Knowledge base 模板**：`templates/workbench/knowledge/design-language.knowledge-base.json`（照现有 knowledge-base 模板形态，collections + sources 指向 design.md/avatar-sources 内容）。
- **文档**：docs/design-language.md 说明"风格如何沉淀与复用"——员工绑 design-style-futaba skill 即获得风格指令；需要理念/案例时查 design-language knowledge base。

## 4. 范围（YAGNI）

- 只沉淀现有风格（futaba/双叶幼儿园 + 治愈像素），不新造风格。
- 不改 theme.ts/tokens.css 运行时（那是 UI 实现，风格 skill 是给员工的"设计语言"，两者并存）。
- 不做风格的自动应用/校验（skill 是指导性注入，非强制门禁）。
- 一个 skill + 一个 knowledge base；未来可加更多风格 skill。

## 5. 测试策略

- Skill/knowledge-base 模板能被 CLI 成功创建（临时数据目录验证，验证后删脚本）。
- 员工绑定 design-style-futaba skill 后，其有效 prompt 含风格指令（若有现成的 effective-profile 编译测试可复用断言）。
- 全量 `npm run check` 绿（主要是模板 JSON 合法 + 不破坏现有）。

## 6. 组件边界

| 组件 | 职责 |
|---|---|
| design-style-futaba skill 模板 | 可注入的风格指令 |
| design-language knowledge-base 模板 | 参考资料（理念/骨架/素材/验收） |
| docs/design-language.md | 说明沉淀与复用方式 |
