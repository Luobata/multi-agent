# Workbench UI：双叶幼儿园

Workbench 使用原创视觉语言，把 Employee、Project、Workflow、Run 与 Publication 组织为可查阅、可核对的本地记录。品牌名固定为「双叶幼儿园」，并提供两套可切换的视觉皮肤。视觉规范的完整基线见根目录 [`design.md`](../design.md)。

## 页面结构

- 员工档案：管理身份、提示词、员工级 Skill 绑定与启停、Provider、权限、版本和 Session。
- 项目接入：读取项目声明，把角色槽位绑定到员工与 Skill 子集，并核对版本更新策略。
- 技能台账：管理共享 Skill 的注册、查看、版本化修订、归档与恢复。
- 协作编排：从常用模式模板生成 Graph 草稿，并在可拖动画布编辑节点与依赖。
- 运行卷宗：查看输入、节点状态、标准输出、标准错误和规范化结果。
- 对外发布：把员工或编排发布为稳定的 A2A 入口。

桌面使用侧栏 + 记录列表 + 详情；中等宽度把列表堆叠在详情上方；移动端使用底部导航。参考图中的气泡和小象属于 Codex 覆盖层，不是产品 UI。

## 视觉规则

- 品牌名固定「双叶幼儿园」，两套皮肤都显示；正文主题词汇（小镇、四季、LOCAL GARDEN 等）不随皮肤切换。
- 提供两套可切换皮肤，通过根元素 `data-theme` 生效，切换入口在侧栏底部并用 localStorage 记忆：
  - `crayon`（蜡笔小新，默认）：幼儿园暖阳配色（暖阳黄/奶油白底、暖褐蜡笔墨、草绿/小象黄/小新红/天蓝强调），手绘晃动描边（SVG `#crayon-edge` filter）、蜡笔投影、双叶幼苗品牌 mark。
  - `pixel`（治愈像素）：原天空蓝主调，薄荷、杏黄、柔粉、浅紫对应四季识别，深海蓝墨，2px 硬边、针脚虚线、无模糊硬阴影、像素嫩芽 mark。
- 配色 CSS 变量名在两皮肤间保持一致，组件层不因主题改变；质感差异集中在 `styles.css` 末尾 `[data-theme="crayon"]` 覆盖块。
- 蜡笔手绘描边在 `prefers-reduced-motion` 或不支持 SVG filter 时回落为规整粗描边，不破坏功能与可读性。
- 中文标题使用本地圆润日系字体栈，ID/模型/命令使用等宽字体，不加载远程字体。
- EmployeeAvatar 使用淡彩圆形角色底；大厅场景、嫩芽、心形、星光与书册均由原创 CSS/SVG 绘制。
- 主按钮深墨底，次按钮浅纸底，危险按钮描边；按下时位移并收回硬阴影。
- 禁止复用参考站商标、角色、美术素材（含小新角色形象与双叶幼儿园官方 logo），禁止 Emoji 充当状态图标，禁止玻璃拟态和装饰性能力数值。

## Provider 信息

每个员工必须显示其 Provider 的运行身份：

- 列表卡显示模型和启动摘要。
- 详情显示 Provider 实例、模型、adapter、最大尝试次数和启动指令模板。
- Employee 不持有模型或命令副本；始终通过 `providerId` 从 Provider registry 解析。
- 未显式声明模型时显示“由 Provider 决定”；不得从品牌或别名猜测。
- 启动指令中的敏感值显示为 `***`。

## 状态与安全

- daemon 离线时读取保留，写入和运行禁用。
- 归档是可追溯状态，不等于物理删除。
- 当前 UI 显示的是 Provider 配置；历史 Run 的 prompt、raw output、normalized result 和状态迁移由 Run Store 证据承担。
- 焦点、错误、成功、loading 和 disabled 状态都必须有非颜色信号。
- 设计师绑定 `interaction-state-completeness` Skill；评审必须从静态页面扩展到控件状态矩阵，尤其检查选择器、菜单、Popover 和 Dialog 的展开态、遮挡、视口避让、键盘路径与焦点恢复。
- 当前选择器使用产品化 `combobox + listbox`：普通页面菜单渲染到页面顶层，避免项目角色卡的 `overflow` 裁切；弹窗内菜单渲染到当前 `dialog` 的同一 browser top layer，避免 `body` Portal 被 Modal 覆盖。不得回退为只美化闭合态的原生 `select`。

## 验收

- `npm run check` 全部通过。
- `#employees/#projects/#skills/#workflows/#runs/#publications` 在 320、768、1280、1440px 下无页面级横向溢出。
- 员工卡和 Provider 详情可读到模型与启动方式，长命令只在自己的 `<pre>` 内换行或滚动。
- 关闭动画后交互仍完整；键盘可以打开、操作并关闭弹窗和上下文抽屉。
- 选择器可用鼠标或 Enter/Space 打开，方向键与 Home/End 导航并保持 active option 在菜单内可见，Enter 选择，Escape 关闭；展开菜单与产品视觉一致并在视口边缘自动换向。
- 选择器验收使用至少 20 个 options，并覆盖空列表、全禁用、禁用项、长标签、错误文字关联、即时高对比焦点环和弹窗内两段式 Escape；粗指针下触发器与 option 均至少 44px。
- Graph 与 Supervisor DAG 画布节点都可以用方向键移动；Supervisor DAG 可从端口连线建立依赖，检查器中的原生复选框保留为完整键盘编辑路径。
