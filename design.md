# Local Agent Workbench · 档案室设计契约

状态：实现基线
视觉来源：用户确认的暖灰纸质“人事档案”版本
Hallmark：`redesign` · Workbench · custom Dossier Office

## 1. 产品隐喻

Workbench 是一间本地数字员工档案室。Employee 是人事档案，Workflow 是协作编排，Run 是运行卷宗，Publication 是对外发布记录。界面需要让身份、权限、Provider 和证据一眼可核对，不制造游戏属性、在线能力或模型信息。

视觉关键词：暖灰纸张、宋体标题、朱红索引、细线表格、绿色状态章、蓝色链接、克制的纸张硬影。禁止恢复霓虹、扫描线、棋盘纹、像素切角、发光字、玻璃拟态和装饰 HUD。

## 2. 核心色彩

| 角色 | Token | 用途 |
| --- | --- | --- |
| 应用纸底 | `--paper` | 全局背景 |
| 抬起纸张 | `--paper-raised` | dossier、弹窗、选中卡 |
| 下沉纸张 | `--paper-sunken` | 导航、列表、输入辅助面 |
| 主墨 | `--ink` | 正文、主按钮 |
| 弱墨 | `--ink-2/3` | 说明、机器信息 |
| 档案朱红 | `--stamp-red(-ink)` | 编号、选中索引、危险描边 |
| 状态绿 | `--seal-green` | 在册、完成 |
| 信息蓝 | `--seal-blue` | 焦点、链接、通讯 |
| 强线 | `--line-strong` | 表单、档案外框、结构分隔 |

正文纸底、抬起纸张和输入面均保持高对比；`--line-strong` 在纸底上至少达到约 3:1。

## 3. 字体与密度

- 标题：`Noto Serif SC / Songti SC / STSong / SimSun / serif`。
- 正文：`PingFang SC / Hiragino Sans GB / Microsoft YaHei / system-ui`。
- ID、模型、命令、时间：`SF Mono / JetBrains Mono / ui-monospace`。
- 不加载远程字体；离线系统字体必须成立。
- 间距沿用 2、4、8、12、16、24、36、60、96px；圆角仅 2–6px。

## 4. 应用骨架

- 顶部 daemon 状态条固定，左侧是浅色索引抽屉导航。
- `>1180px`：完整导航 + 324px 记录列表 + 详情。
- `901–1180px`：58px 图标导航 + 292px 列表 + 详情。
- `641–900px`：记录列表堆叠在详情上方，复现参考图的纵向档案视图。
- `≤640px`：底部四项导航；表单、身份网格、档案分栏改为单列。
- 所有视口从 320px 起不得横向溢出；拓扑图只允许自己的滚动容器横向滚动。

## 5. 视觉组件

### 索引导航与列表

- 品牌章显示“档”，标题为“档案室 / DOSSIER OFFICE”。
- 当前导航与选中记录使用纸面、细线和左侧 3px 朱红索引条。
- 员工头像是纸底方章；状态只使用语义描边章，不使用发光或 Emoji。

### Dossier

- 外框为 `3px double var(--line-strong)`，右下使用单层纸张硬影。
- 封面与主要区块由双线或 1px 暖灰线分隔。
- 标题使用中文衬线；机器编号使用 mono 和朱红色。
- 主按钮为黑底纸白字；次按钮纸底黑字；归档按钮朱红描边。

### 弹窗、抽屉与反馈

- 弹窗沿用双线纸张外框；抽屉仅有左侧结构线和克制阴影。
- 动画只允许 120–280ms 的淡入、轻微位移和缩放；支持 `prefers-reduced-motion`。
- Toast 和状态变化使用 `role=status/alert`，不得只靠颜色表达。

## 6. Provider 运行身份

Employee 只保存 `providerId`。模型和启动指令属于 Provider registry，前端在展示时解析，禁止复制进 Employee schema。

- 每张员工卡在摘要后显示 `模型` 与 `启动` 单行信息。
- command adapter 显示 `command + args`；shell 包装器的摘要显示为 `zsh → inner-command`。
- Provider 明确提供 `model` 时显示该值；其次尝试解析 `--model`；仍未知时显示“由 Provider 决定”，禁止猜测。
- 详情页展示完整启动 argv，并将 token、key、password、secret 等参数值脱敏为 `***`。
- built-in adapter 显示 `built-in://adapter`。这里展示的是当前 Provider 配置，不冒充历史 Run 的实际命令。

## 7. 交互与无障碍

- 可操作元素使用语义化 `button/input/select/dialog`；键盘焦点始终可见。
- 粗指针设备的主要控件至少 44px；文本和状态章保持可读对比。
- 弹窗和上下文抽屉限制焦点，Escape 关闭，关闭后焦点返回来源。
- 离线时保持可查阅，所有写入与运行入口禁用并明确说明原因。

## 8. 不可破坏的边界

视觉修改不得改变 Provider、Skill、Role、Architecture、Workflow、Run Store、MCP 与 A2A 的分层；不得虚构运行状态、模型、权限、历史记录或 Provider 能力。所有路由和现有写入流程必须继续使用本地 mock Provider 完成测试。
