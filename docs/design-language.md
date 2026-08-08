# 设计语言：沉淀与复用

Workbench 的视觉风格（双叶幼儿园 / 治愈像素档案）现在以两种可复用形态沉淀，员工可"一个关键词"获得整套风格语言。

## 两半：指令 vs 参考

- **可注入指令 → Skill `design-style-futaba`**（`templates/workbench/design-style-futaba.skill.json`）。
  提炼自 `design.md` 的硬规则：语义配色 token（--sky/--cloud/--season-*/--ink）、字体栈、2px 硬边/针脚虚线/硬阴影/按压反馈、crayon/pixel 皮肤切换、无障碍状态矩阵与对比度。员工绑定该 skill，即把这套风格指令注入其 prompt——产出界面时自带设计语言。
  ```bash
  npm run cli -- workbench skill-create templates/workbench/design-style-futaba.skill.json
  # 然后在员工定义的 skills 里加 "design-style-futaba"
  ```

- **参考资料 → 现有 `local-agent-workbench` 知识库的 `design` collection**（交互与视觉设计）。
  理念（产品隐喻、季节路由、架构边界、验收清单）与素材（avatar 来源）归此，供员工按需检索，不注入。design.md 全文作为该 collection 的参考 source。

## 为什么这样分

- Skill 是"做界面时必须遵守的规则"——短、祈使、注入即生效，适合硬约束。
- Knowledge 是"想了解背景/案例时去查的资料"——长、叙述、检索获取，适合参考。
- 两者并存，不与 `theme.ts`/`tokens.css` 的运行时主题实现冲突：那是 UI 代码的 token 落地，本 skill 是给员工的"设计语言"描述。

## 扩展

未来新增风格（如另一套主题）→ 新建一个 `design-style-<name>.skill.json`，参考资料继续归入 design collection。一个关键词（skill id）承载一套完整风格。
