# 双叶幼儿园 · 可切换 Theme 模式设计

## 背景与目标

Workbench 当前使用原创「治愈像素小镇档案」视觉语言，品牌名为「迪士尼乐园」，副标 `HEALING PIXEL DOSSIER`。本次迭代做两件事：

1. **全局改名**：品牌名从「迪士尼乐园」改为「双叶幼儿园」，两个主题下都显示它。
2. **新增可切换 Theme 模式**：在现有视觉之外新增一套「蜡笔小新」风格皮肤，用户可在侧栏随时切换、并被记住。默认展示蜡笔主题。

本次**只做视觉皮肤层**：不改布局、信息架构、组件结构、路由、ID、数据流或业务逻辑。

## 已锁定决策

| 项 | 决定 |
|---|---|
| 品牌名 | 全局固定「双叶幼儿园」，两主题都显示（含副标） |
| 架构 | 可切换 Theme 模式，能来回切 |
| 默认主题 | 蜡笔小新（`crayon`） |
| 切换入口 | 侧栏底部 + localStorage 记忆 |
| 切换覆盖面 | 只切视觉（配色 / 描边质感 / 品牌 mark），正文词汇不随主题变 |
| IP 边界 | 只借风格气质，美术全原创（沿用项目"禁止复用版权角色/美术/商标"护栏） |
| 描边强度 | 明显蜡笔手绘（粗、边缘不规则、抖动 + 颗粒感） |

### IP 边界说明

蜡笔小新 / 双叶幼儿园是版权作品。本设计**不引入**任何真实小新角色形象、双叶幼儿园官方 logo 或参考美术素材，只通过原创 CSS/SVG 捕捉其**美学气质**：蜡笔涂抹质感、粗而抖动的手绘描边、幼儿园暖色调、稚拙童趣感。这与项目既有护栏（`docs/workbench-ui.md`：禁止复用参考站商标、角色、美术素材）一致。「双叶幼儿园」仅作为品牌**文字**使用。

### 术语澄清

- "领队 / supervisor" 是产品**角色概念**（团队 lead），**不属于**主题词汇，全程不改。
- 正文散落词汇（小镇 / 四季 / LOCAL GARDEN / Town Workbench / HP 等）**不随主题切换**，保持现状。本次唯一改动的文字是左上角品牌名/副标。

## 架构：两套皮肤如何共存

### 主题标识

- 在根元素上设置 `data-theme` 属性：`crayon`（蜡笔，默认）/ `pixel`（治愈像素）。
- 通过 `document.documentElement.setAttribute("data-theme", theme)` 应用。

### 配色分层

- `tokens.css` 中原 `:root` 的配色变量拆成两组：
  - `:root, [data-theme="crayon"] { …蜡笔暖阳值… }` —— 默认即蜡笔。
  - `[data-theme="pixel"] { …现有天空蓝/四季值… }` —— 像素主题作为覆盖。
- **变量名全部不变**（`--sky`、`--ink`、`--season-*`、`--stamp-red` 等），因此组件层 CSS 零改动。
- 非配色 token（间距、字号、圆角、动画曲线、几何尺寸、z-index）保持共享，不分主题。

### 质感差异（描边 / 阴影 / mark）

配色变量无法表达描边抖动与 mark 形状，需少量作用域覆盖规则：

- 集中放在 `styles.css` 末尾一个「蜡笔主题覆盖块」，全部以 `[data-theme="crayon"] …` 选择器限定，与像素基线隔离，便于维护与切回。
- 覆盖内容：卡片 / 按钮 / dossier / 弹窗 / 抽屉的手绘描边 filter、蜡笔投影、品牌 mark 重绘。

### 切换逻辑

- 新增轻量模块 `client/src/theme.ts`：
  - `THEMES` 常量（`crayon` / `pixel`）与默认值 `crayon`。
  - `readTheme()`：从 localStorage 读取，非法值或缺失回落默认。
  - `applyTheme(theme)`：写 localStorage + 设置根元素 `data-theme`。
  - 一个 React hook（如 `useTheme()`）返回当前主题与 setter，驱动侧栏按钮状态。
- App 启动时立即应用（避免首帧闪烁）；对无 localStorage 环境安全降级为默认主题。

## 配色（蜡笔主题，`crayon`）

变量名不变，值改为幼儿园暖阳：

- 底色 `--sky` / `--sky-*`：天空蓝 → 暖阳黄 / 奶油白（教室墙面感）。
- 主墨 `--ink` / `--ink-*`：深海蓝 → 暖褐 / 蜡笔黑（不死板）。
- 四季四槽（语义保留，值改）：
  - `--season-spring` 薄荷 → 草绿
  - `--season-summer` 杏黄 → 小象黄
  - `--season-autumn` 柔粉 → 小新红（主强调）
  - `--season-winter` 浅紫 → 天蓝
- 语义别名（`--stamp-red` / `--seal-green` / `--seal-amber` / `--seal-blue` 等）指向关系不变，底色随暖色系一并调整，保证对比度达标。

## 描边与质感（蜡笔味核心）

- **描边**：明显蜡笔手绘——比现有 2px 更粗、边缘不规则、带抖动与颗粒。技术上用 SVG `feTurbulence` + `feDisplacementMap` filter 作用于卡片 / 按钮 / dossier 边框，制造手绘晃动；配合略粗 border。filter 定义为内联 SVG（随 App 挂载一次），CSS 通过 `filter: url(#crayon-edge)` 引用。
- **阴影**：保留"硬童趣"，略柔化为蜡笔投影（微偏移 + 极浅模糊）。
- **字体**：现有圆润日系字体栈契合童趣，保留；标题处可加大字重 / 更圆。
- **降级**：`prefers-reduced-motion` 或不支持 SVG filter 时，回落到规整粗描边，不破坏功能与可读性。
- 全部纯 CSS/SVG，不加载远程字体、不引入图片素材。

## 品牌 mark（蜡笔主题）

- 现「像素嫩芽」精灵（`.brand-sprite i` 的 box-shadow 像素画）在蜡笔主题下重绘为原创**双叶幼苗 / 蜡笔涂鸦**图形（呼应"双叶"），CSS/SVG 手绘，圆形暖底。
- 像素主题（`pixel`）保留原精灵不变。

## 切换入口

- 侧栏底部 `nav-foot` 区新增主题切换控件（两态：蜡笔 / 像素）。
- 键盘可达；选中态有非颜色信号（文字 / 图标 / 边框，不仅靠颜色）。
- 选择即时生效并写入 localStorage。

## 改动范围

**会改**：

- `client/src/tokens.css`：配色变量拆为 `crayon` / `pixel` 两组。
- `client/src/styles.css`：末尾新增蜡笔主题覆盖块（描边 filter、阴影、mark）。
- `client/src/theme.ts`（新增）：主题读写与应用。
- `client/src/App.tsx`：品牌名改「双叶幼儿园」+ 副标；挂载 SVG filter；接入 `data-theme`；侧栏切换控件。
- `docs/workbench-ui.md`、`design.md`：同步主题体系说明。
- 相关快照 / 文案测试（如 `App.navigation.test.tsx` 中断言品牌文字或主题的用例）。

**不改**：布局、组件结构、路由、ID、数据流、业务逻辑、正文主题词汇（小镇 / 四季 / LOCAL GARDEN 等）。

## 验收标准

- `npm run check`（typecheck + test + build）全部通过。
- 品牌名在两主题下均显示「双叶幼儿园」。
- 首次进入默认蜡笔主题；侧栏可切换；刷新后记住上次选择。
- 两主题在 320 / 768 / 1280 / 1440px 下均无页面级横向溢出。
- 焦点、错误、成功、loading、disabled 状态在两主题下都有非颜色信号。
- 关闭动画（`prefers-reduced-motion`）后交互仍完整；键盘可打开、操作并关闭弹窗与抽屉；主题切换键盘可达。
- 无版权角色 / 美术素材 / 商标；无 Emoji 充当状态图标。
- 蜡笔 filter 不支持时有可读的规整降级。
