# Local Agent Workbench · 双叶幼儿园设计契约

状态：实现基线

品牌名：双叶幼儿园（固定，两套皮肤都显示）

视觉方向：两套可切换皮肤 —— `crayon`（蜡笔小新幼儿园，默认）与 `pixel`（治愈日式像素游戏档案）。以下 §1–§4 的天空蓝/四季描述为 `pixel` 皮肤基线；`crayon` 皮肤的差异见 §3.1。

实现边界：原创 CSS/SVG 图形、本地字体、本地素材；不复制参考站商标、角色或美术资源（含蜡笔小新角色形象与双叶幼儿园官方 logo）

## 1. 产品隐喻

Workbench 是一间在天空与四季之间工作的本地数字员工档案室。Employee 是小镇居民档案，Project 是项目需求与员工任用关系，Skill 是可复用能力图鉴，Workflow 是协作地图，Run 是运行卷宗，Publication 是可交付的调用包。游戏感只服务于信息识别和操作反馈，不能虚构等级、在线状态、模型能力或运行证据。

视觉关键词：天空蓝主调、薄荷春色、杏黄夏色、柔粉秋色、浅紫冬色、淡彩圆形角色底、2px 硬边、针脚虚线、克制硬阴影、像素图标、按压反馈。界面可爱而不幼稚，信息密度仍满足本地工程工作台。

## 2. 核心色彩

| 角色 | Token | 用途 |
| --- | --- | --- |
| 小镇天空 | `--sky / --sky-pale` | Shell、页面背景和空间氛围 |
| 云朵奶油纸 | `--cloud / --paper-raised` | 档案、弹窗、选中卡和输入面 |
| 薄荷春色 | `--season-spring(-soft)` | 在册、员工大厅、成长状态 |
| 杏黄夏色 | `--season-summer(-soft)` | Skills、提醒和温暖辅助面 |
| 柔粉秋色 | `--season-rose / --season-autumn` | 员工档案、危险前的温和强调 |
| 浅紫冬色 | `--season-winter(-soft)` | Workflow、结构化编辑和弹窗标题 |
| 深海蓝墨 | `--ink / --line-strong` | 正文、2px 外框和主要结构 |

所有浅色面上的正文使用深海蓝墨。状态不仅依赖颜色，还必须带图标和文字。危险、阻塞、完成和运行中继续使用既有语义 token，禁止把季节颜色当作新的业务状态。

## 3. 字体、像素与密度

- 标题：`Hiragino Maru Gothic ProN / Yu Gothic / PingFang SC`，呈现圆润日系气质。
- 正文：`Hiragino Sans / Yu Gothic UI / PingFang SC`。
- ID、模型、命令、时间：`SFMono-Regular / Menlo / Cascadia Mono`。
- 不请求远程字体。缺少首选字体时必须由本地 CJK 字体自然回退。
- 主要可交互轮廓为 2px；信息分区使用 2px 针脚虚线；圆角只用于卡片和圆形角色底，不做玻璃拟态。
- 硬阴影使用 2–5px 无模糊偏移。按下时元素向右下移动 2px，并收回阴影。

## 3.1 皮肤切换机制

- 皮肤通过根元素 `data-theme` 生效：`crayon`（默认）与 `pixel`。切换入口在侧栏底部，选择用 localStorage（键 `workbench-theme`）持久化；App 挂载时立即应用，避免首帧闪烁。
- 配色变量名在两皮肤间完全一致（`--sky`、`--ink`、`--season-*`、语义别名等），只是取值不同：`tokens.css` 的 `:root` 即 `crayon` 值，`[data-theme="pixel"]` 作为覆盖。因此组件层 CSS 不因主题而改动。
- `crayon` 皮肤差异：暖阳黄/奶油白底、暖褐蜡笔墨；四季槽位重映射为草绿、小象黄、小新红、天蓝；手绘晃动描边由内联 SVG filter `#crayon-edge`（`feTurbulence` + `feDisplacementMap`）实现；蜡笔投影；品牌 mark 为原创双叶幼苗。质感差异集中在 `styles.css` 末尾 `[data-theme="crayon"]` 覆盖块。
- 降级：`prefers-reduced-motion` 或不支持 SVG filter 时，`crayon` 描边回落为规整粗描边，功能与可读性不受影响。

## 4. 应用骨架与季节路由

- 顶部 daemon 状态条固定，左侧天空蓝小镇导航固定。
- 七个入口使用稳定的季节识别色：大厅薄荷、员工柔粉、项目薄荷、Skills 杏黄、Workflow 浅紫、Run 天空蓝、调用包珊瑚色。
- `>1180px`：完整小镇导航 + 332px 记录列表 + 详情。
- `901–1180px`：62px 图标导航 + 记录列表 + 详情。
- `641–900px`：记录列表堆叠于详情上方。
- `≤640px`：七项底部导航；档案、项目任用、表单、图谱说明和浮层转为单列。
- 页面从 320px 起不得产生页面级横向滚动；拓扑与代码证据只在自己的容器中滚动。

## 5. 视觉组件

### Shell 与导航

- 品牌为 CSS 像素嫩芽，不使用 Emoji 或外部图片。
- 当前入口使用季节底色、2px 深色框和 3px 硬阴影；按下后阴影收回。
- daemon 状态仍来自真实连接状态，不得把装饰灯当作新状态源。

### 角色卡与档案

- EmployeeAvatar 使用淡彩圆形底和双层硬边；真实头像保持原图，不强制像素化。
- 员工大厅使用原创天空、草地、云朵和花芽 CSS 图形；实时状态、实例数和 Provider 信息保持真实。
- Dossier 使用奶油纸、2px 外框、内侧针脚线与季节封面；Employee、Project、Workflow、Run、Publication 各有稳定识别色。
- 完成使用像素心、在册使用嫩芽、运行使用星光、Skill 使用像素书册。图标必须始终配合文字标签。

### 表单、图谱与证据

- 输入框是奶油纸游戏面板：2px 边、轻内阴影、清晰焦点环。
- 选择器不得只设计闭合态。产品化选择器统一使用同一套触发器与 listbox：展开菜单保留 2px 硬边、选中标记、键盘高亮和硬阴影，并通过顶层浮层避免被卡片 `overflow` 裁切。
- 选择器展开时必须贴合触发器；下方空间不足时向上展开，菜单最大高度后内部滚动，长标签省略但不能撑出页面。若明确使用原生 `select`，交付物必须标注系统菜单不跟随品牌皮肤的取舍。
- `dialog.showModal()` 会进入浏览器 top layer；弹窗内选择器的菜单必须挂在同一个 `dialog` 内。把菜单 Portal 到 `body` 后再提高 `z-index` 仍会被弹窗覆盖，不能作为可接受实现。
- Workflow Canvas 保留真实 Graph 编辑逻辑，视觉上使用 24px 像素地图网格、硬边节点卡和方形端口。
- Prompt、raw output、normalized result、路径等证据保持等宽字体与独立滚动，不为装饰截断内容。

### 弹窗、抽屉、空状态与反馈

- Modal、Drawer、Toast 都使用 2px 硬边、针脚线和无模糊硬阴影。
- 空状态显示原创 CSS 嫩芽；Toast 成功显示原创 CSS 像素心。
- 动画只允许 110–280ms 的像素弹入、轻微位移和角色待机；支持 `prefers-reduced-motion`。

## 6. Provider 与架构边界

Employee 只保存 `providerId`。模型和启动指令属于 Provider registry，前端在展示时解析，禁止复制进 Employee schema。Skill、Role、Architecture、Workflow、Run Store、MCP 与 A2A 的分层不因视觉隐喻发生变化。

- 每张员工卡显示模型和启动摘要。
- command adapter 显示 `command + args`；shell 包装器显示真实内层命令摘要。
- Provider 未声明模型时显示“由 Provider 决定”，禁止猜测。
- 敏感参数继续显示为 `***`。
- 游戏式文案不能替换真实 ID、版本、状态、错误和证据路径。

## 7. 交互与无障碍

- 可操作元素使用语义化 `button/input/dialog` 或符合 ARIA 模式的 `combobox/listbox/option`；键盘焦点始终可见。
- 设计交付前先为每类控件列出状态矩阵。基础状态至少包含 idle、hover、focus-visible、active、disabled、loading、success、warning、error、empty；浮层控件追加 closed/open、selected/unselected、长内容和大量选项。
- 自定义选择器支持 Enter/Space 打开与选择、方向键移动、Home/End 跳转、Escape 关闭、Tab 离开，关闭后焦点返回触发器；展开态不得造成焦点陷阱。
- 方向键或 Home/End 改变 active option 后，高亮项必须以 `block: nearest` 滚入菜单内部可视区；长列表验收至少使用 20 个 options，不能用 3 项短列表代替。
- `focus-visible` 使用 `--focus` 即时显示，焦点环不得参与 transition；它与云朵纸、档案纸和天空浅色背景的对比度均须不低于 3:1。
- 空列表和全禁用列表必须把触发器本身设为 disabled 并显示文字原因；错误态必须同时提供错误文字、`aria-invalid` 和 `aria-describedby`，不能只改边框颜色。
- 弹窗内第一次 Escape 只关闭 listbox 并把焦点交还触发器，第二次 Escape 才关闭 dialog。粗指针下触发器与 option 点击区均不小于 44px。
- `loading / success / warning` 若由包含选择器的异步表单或保存动作统一承担，选择器状态矩阵中标记为 inherited；确实不适用时标记 N/A，不能因设计稿未画而默认遗漏。
- 粗指针设备的主要控件至少 44px。
- 弹窗和抽屉支持 Escape、遮罩关闭与焦点返回。
- daemon 离线时保持档案可查阅，写入与运行入口禁用并明确说明。
- `prefers-reduced-motion` 下停用角色浮动、弹入和状态脉冲，不损失信息。

## 8. 验收

- `npm run check` 全部通过。
- `#office/#employees/#projects/#skills/#workflows/#runs/#publications` 在 320、768、1280、1440px 下无页面级横向溢出。
- Modal、Drawer、空状态、Toast、表单、角色卡、Canvas 与记录列表使用同一套像素设计 token。
- 每个新建或改造的浮层控件都必须提供真实浏览器的闭合态、展开态、底部翻转、20+ options、长内容、空/禁用/错误、普通页面与 dialog Portal、键盘焦点流证据；只检查静态闭合态或 3 项短列表不算验收完成。
- 本地 mock provider 示例可继续运行；视觉重构不改 Provider、Skill、Role、Workflow 或 Run Store 数据契约。
