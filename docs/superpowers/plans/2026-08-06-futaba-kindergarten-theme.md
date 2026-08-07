# 双叶幼儿园 · 可切换 Theme 模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Workbench 品牌名全局改为「双叶幼儿园」，并新增一套可切换的「蜡笔小新」视觉主题（默认），保留现有「治愈像素」为可切回主题，切换入口在侧栏并被 localStorage 记住。

**Architecture:** 主题走根元素 `data-theme` 属性（`crayon` 默认 / `pixel`）。配色变量在 `tokens.css` 中拆成两个作用域块，变量名不变，因此组件层 CSS 零改动；描边/阴影/mark 等无法用变量表达的质感差异，集中在 `styles.css` 末尾一个 `[data-theme="crayon"]` 覆盖块。一个轻量 `theme.ts` 负责读写 localStorage 与设置属性，App 挂载时应用并渲染侧栏切换控件与内联 SVG 手绘 filter。

**Tech Stack:** React 18 + TypeScript + Vite；纯 CSS 变量 + 内联 SVG filter（`feTurbulence`/`feDisplacementMap`）；Vitest + Testing Library；localStorage。

## Global Constraints

- 只改视觉皮肤层：不改布局、组件结构、路由、ID、数据流、业务逻辑。
- 品牌名全局固定「双叶幼儿园」，两主题都显示；正文主题词汇（小镇/四季/LOCAL GARDEN/Town Workbench/HP）**不随主题变**，本次唯一改的文字是左上角品牌名与副标。
- "领队/supervisor" 是产品角色概念，全程不改。
- IP 边界：不引入任何真实小新角色形象、双叶幼儿园官方 logo 或参考美术素材；美术全部原创 CSS/SVG。禁止 Emoji 充当状态图标。
- 默认主题 `crayon`；`:root` 即 crayon 值，`[data-theme="pixel"]` 作为覆盖。
- 所有配色 CSS 变量名保持不变。
- 描边强度：明显蜡笔手绘（粗、边缘不规则、抖动+颗粒）；`prefers-reduced-motion` 或不支持 filter 时回落规整粗描边。
- 无远程字体、无图片素材。
- 交付前 `npm run check`（typecheck + test + build）全绿；两主题在 320/768/1280/1440px 无横向溢出；非颜色状态信号在两主题保留。
- 频繁提交，每个 Task 结束是一个独立可测交付物。

---

### Task 1: theme.ts — 主题读写与应用模块

**Files:**
- Create: `client/src/theme.ts`
- Test: `client/src/theme.test.ts`

**Interfaces:**
- Produces:
  - `type ThemeName = "crayon" | "pixel"`
  - `const DEFAULT_THEME: ThemeName = "crayon"`
  - `const THEME_STORAGE_KEY = "workbench-theme"`
  - `function readTheme(): ThemeName` — 从 localStorage 读，非法/缺失/异常回落 `DEFAULT_THEME`
  - `function applyTheme(theme: ThemeName): void` — `document.documentElement.setAttribute("data-theme", theme)` 且写 localStorage（写失败静默忽略）

- [ ] **Step 1: Write the failing test**

```typescript
// client/src/theme.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEME_STORAGE_KEY, applyTheme, readTheme } from "./theme";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
  it("defaults to crayon when nothing stored", () => {
    expect(readTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("crayon");
  });

  it("returns the stored theme when valid", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "pixel");
    expect(readTheme()).toBe("pixel");
  });

  it("falls back to default on an unknown stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "banana");
    expect(readTheme()).toBe("crayon");
  });

  it("applyTheme sets the data-theme attribute and persists", () => {
    applyTheme("pixel");
    expect(document.documentElement.getAttribute("data-theme")).toBe("pixel");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("pixel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/theme.test.ts`
Expected: FAIL — cannot resolve `./theme`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// client/src/theme.ts
export type ThemeName = "crayon" | "pixel";

export const DEFAULT_THEME: ThemeName = "crayon";
export const THEME_STORAGE_KEY = "workbench-theme";

const THEMES: readonly ThemeName[] = ["crayon", "pixel"];

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function readTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; ignore storage failures (private mode, quota).
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/theme.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/theme.ts client/src/theme.test.ts
git commit -m "feat: add theme read/apply module with crayon default"
```

---

### Task 2: tokens.css — 配色拆成 crayon 默认 + pixel 覆盖

**Files:**
- Modify: `client/src/tokens.css:5-152` (the `:root` block)

**Interfaces:**
- Consumes: 无（纯 CSS）。
- Produces: `:root` 与 `[data-theme="crayon"]` 提供暖阳蜡笔配色；`[data-theme="pixel"]` 提供现有天空蓝/四季配色。所有变量名不变。

**Approach:** 现有 `:root` 里配色相关变量（`--sky*`、`--cloud`、`--paper*`、`--ink*`、`--line*`、`--season-*`、`--surface-*`、语义别名 `--stamp-*`/`--seal-*`/`--danger-bg`/`--accent-ink`/`--focus`/`--selection`/`--scrim*`/`--paper-shadow`/`--ink-shadow`/`--pixel-shadow`/`--employee-accent-data`、canonical aliases `--color-*`）改为 crayon 暖阳值。把现有天空蓝的整组配色值复制到新增的 `[data-theme="pixel"] { … }` 块。**非配色变量**（字体栈、字号、间距、圆角、动画、几何、z-index、`--ink-secondary` 等别名）留在 `:root`，不复制、不分主题。

- [ ] **Step 1: 在 `:root` 顶部注释更新体系说明**

把文件头注释（`client/src/tokens.css:1-4`）改为描述双主题：crayon 为默认暖阳蜡笔皮肤，pixel 为治愈像素皮肤，全部本地 CSS/SVG。

- [ ] **Step 2: 把 `:root` 中的配色变量值改为 crayon 暖阳值**

在 `:root`（`client/src/tokens.css:5`）中，替换以下配色变量为暖阳蜡笔值（保留变量名与所有非配色变量原样）：

```css
  /* Crayon Shin-chan kindergarten skin (default). Warm classroom walls, crayon ink. */
  --sky: #f6d97a;
  --sky-deep: #e7b84e;
  --sky-pale: #fff3cf;
  --cloud: #fffaf0;
  --paper: #fff6e4;
  --paper-raised: #fffaf0;
  --paper-sunken: #f4e3c2;
  --paper-hover: #ffe9bd;
  --ink: #4a3320;
  --ink-hover: #34230f;
  --ink-2: #6b4d31;
  --ink-3: #8a6c4c;
  --ink-ghost: #b79b78;
  --line: #e0c48f;
  --line-strong: #8a5a2b;

  /* Four accent slots kept; semantics remapped to kindergarten crayons. */
  --season-spring: #7fc06a;
  --season-spring-soft: #e2f2cf;
  --season-summer: #f4c542;
  --season-summer-soft: #fff0bd;
  --season-autumn: #e5533d;
  --season-autumn-soft: #ffd8ce;
  --season-winter: #5cb3e6;
  --season-winter-soft: #d5ecfb;
  --season-rose: #e5533d;
  --season-rose-soft: #ffd8ce;
  --season-run: #5cb3e6;
  --season-run-soft: #d5ecfb;

  --surface-roster: #fdeecb;
  --surface-canvas: #fdf0d3;
  --surface-terminal: #fbeecb;
  --surface-code: #faedca;
  --surface-muted: #f5ead0;

  --stamp-red: var(--season-autumn);
  --stamp-red-ink: #b23a26;
  --seal-green: #4f8f3a;
  --seal-green-bg: var(--season-spring-soft);
  --seal-amber: #9a6a1b;
  --seal-amber-bg: var(--season-summer-soft);
  --seal-blue: #2f7fb0;
  --seal-blue-bg: var(--season-winter-soft);
  --seal-gray: #7c6446;
  --danger-bg: #ffdcd3;
  --accent-ink: #fffaf0;
  --focus: #b23a26;
  --selection: #ffe08a;
  --scrim: rgb(74 51 32 / 48%);
  --scrim-soft: rgb(74 51 32 / 28%);
  --paper-shadow: #d9b27a;
  --ink-shadow: rgb(74 51 32 / 26%);
  --pixel-shadow: #cf9f5e;
  --employee-accent-data: #e5533d;
```

> 注：canonical `--color-*` 别名（`client/src/tokens.css:69-83`）本就指向上述变量，无需改动，会自动跟随。

- [ ] **Step 3: 新增 `[data-theme="pixel"]` 块，放回现有天空蓝配色**

在 `:root { … }` 结束大括号之后（`client/src/tokens.css:152` 之后）追加：

```css
[data-theme="pixel"] {
  color-scheme: light;

  /* Healing pixel town skin. Soft sky, seasonal pastels. */
  --sky: #9bcfe0;
  --sky-deep: #70aec5;
  --sky-pale: #e3f4f4;
  --cloud: #fffdf1;
  --paper: #edf8f2;
  --paper-raised: #fffdf1;
  --paper-sunken: #d9edef;
  --paper-hover: #f8f4d7;
  --ink: #294b5a;
  --ink-hover: #1f3d4a;
  --ink-2: #476773;
  --ink-3: #56707b;
  --ink-ghost: #88a2aa;
  --line: #b6d2d3;
  --line-strong: #5d8492;

  --season-spring: #9ed6ae;
  --season-spring-soft: #def2d8;
  --season-summer: #f2cf78;
  --season-summer-soft: #fff0bd;
  --season-autumn: #efa48c;
  --season-autumn-soft: #ffe0d5;
  --season-winter: #c4b7e4;
  --season-winter-soft: #ece5fa;
  --season-rose: #e49aae;
  --season-rose-soft: #f9dce5;
  --season-run: #8bc9dc;
  --season-run-soft: #dceff5;

  --surface-roster: #dff1ef;
  --surface-canvas: #e2f1ef;
  --surface-terminal: #e5f0ed;
  --surface-code: #e6f1ef;
  --surface-muted: #edf1ef;

  --stamp-red: var(--season-rose);
  --stamp-red-ink: #954d63;
  --seal-green: #397961;
  --seal-green-bg: var(--season-spring-soft);
  --seal-amber: #806425;
  --seal-amber-bg: var(--season-summer-soft);
  --seal-blue: #326f8a;
  --seal-blue-bg: var(--season-run-soft);
  --seal-gray: #617780;
  --danger-bg: #ffe3df;
  --accent-ink: #fffdf1;
  --focus: #215f7b;
  --selection: #f6df91;
  --scrim: rgb(41 75 90 / 48%);
  --scrim-soft: rgb(41 75 90 / 28%);
  --paper-shadow: #78a7b1;
  --ink-shadow: rgb(38 70 82 / 28%);
  --pixel-shadow: #6f9da7;
  --employee-accent-data: #e49aae;

  background: var(--sky);
}
```

- [ ] **Step 4: 验证构建与类型**

Run: `npm run build:client`
Expected: 构建成功，无 CSS 解析错误。

- [ ] **Step 5: Commit**

```bash
git add client/src/tokens.css
git commit -m "feat: split color tokens into crayon default and pixel theme"
```

---

### Task 3: App.tsx — 品牌改名 + 挂载主题 + 内联 SVG filter

**Files:**
- Modify: `client/src/App.tsx:1-12` (imports), `client/src/App.tsx:60-67` (state), `client/src/App.tsx:172-183` (shell + nav)
- Test: `client/src/App.navigation.test.tsx` (add cases)

**Interfaces:**
- Consumes: `theme.ts` 的 `ThemeName`, `DEFAULT_THEME`, `readTheme`, `applyTheme`.
- Produces: App 渲染 `data-theme` 生效；左上角品牌 `<strong>双叶幼儿园</strong><small>CRAYON KINDERGARTEN DOSSIER</small>`；侧栏底部主题切换按钮（Task 4 加样式）；内联 `<svg>` 定义 filter `#crayon-edge`（Task 5 引用）。

- [ ] **Step 1: Write the failing test**

在 `client/src/App.navigation.test.tsx` 末尾（现有 describe 内或新增）追加：

```typescript
it("shows the Futaba Kindergarten brand name", async () => {
  renderApp(); // 复用文件内既有的渲染 helper；若名称不同，用文件现有方式渲染 <App />
  expect(await screen.findByText("双叶幼儿园")).toBeInTheDocument();
});

it("defaults to the crayon theme on the document element", async () => {
  renderApp();
  await screen.findByText("双叶幼儿园");
  expect(document.documentElement.getAttribute("data-theme")).toBe("crayon");
});

it("toggles to the pixel theme via the sidebar control", async () => {
  const user = userEvent.setup();
  renderApp();
  await screen.findByText("双叶幼儿园");
  await user.click(screen.getByRole("button", { name: /切换到治愈像素主题/ }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("pixel");
});
```

> 实现前先读该测试文件顶部，复用其既有的渲染 helper、`screen`、`userEvent` 导入方式与 API mock，保持与现有用例一致；不要新造渲染方式。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/App.navigation.test.tsx`
Expected: FAIL — 找不到「双叶幼儿园」/找不到切换按钮/`data-theme` 为 null。

- [ ] **Step 3: 加 imports 与主题 state**

在 `client/src/App.tsx:12` 之后加：

```typescript
import { applyTheme, DEFAULT_THEME, readTheme, type ThemeName } from "./theme";
```

在 `client/src/App.tsx:67`（`syncing` state 之后）加：

```typescript
  const [theme, setTheme] = useState<ThemeName>(() => (typeof window === "undefined" ? DEFAULT_THEME : readTheme()));
  useEffect(() => { applyTheme(theme); }, [theme]);
```

- [ ] **Step 4: 改品牌文字**

把 `client/src/App.tsx:179` 的 brand-mark 内文字改为：

```tsx
      <div className="brand-mark"><span className="brand-sprite" aria-hidden="true"><i /></span><div><strong>双叶幼儿园</strong><small>CRAYON KINDERGARTEN DOSSIER</small></div></div>
```

- [ ] **Step 5: 加侧栏主题切换按钮**

把 `client/src/App.tsx:182` 的 `nav-foot` 那行替换为（在其前面插入切换按钮，保留原 nav-foot）：

```tsx
      <button type="button" className="theme-toggle" onClick={() => setTheme(theme === "crayon" ? "pixel" : "crayon")} title={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"} aria-label={theme === "crayon" ? "切换到治愈像素主题" : "切换到蜡笔小新主题"}><span className="theme-toggle-dot" aria-hidden="true" /><span>{theme === "crayon" ? "蜡笔小新" : "治愈像素"}</span><small>{theme === "crayon" ? "CRAYON" : "PIXEL"}</small></button>
      <div className="nav-foot"><span>KG</span><div><strong>Kindergarten Workbench</strong><small>班级在册 · A2A 1.0</small></div></div>
```

> 说明：`nav-foot` 内 `HP → KG`、`Town Workbench → Kindergarten Workbench`、`四季在册 → 班级在册` 属于左上角品牌区文字范畴，随品牌改名一并更新（与正文散落词汇不同，这是品牌标识）。

- [ ] **Step 6: 挂载内联 SVG filter**

在 `client/src/App.tsx:172` 的 `<div className="app-shell …">` 内最前面（`skip-link` 之前）插入内联 SVG（宽高 0、隐藏，仅提供 filter 定义）：

```tsx
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <filter id="crayon-edge" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.015" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run client/src/App.navigation.test.tsx`
Expected: PASS（含新增 3 个用例）。若既有用例断言了旧品牌文字/nav-foot 文案，同步更新那些断言到新文案。

- [ ] **Step 8: Commit**

```bash
git add client/src/App.tsx client/src/App.navigation.test.tsx
git commit -m "feat: rename brand to Futaba Kindergarten and wire theme toggle"
```

---

### Task 4: styles.css — 主题切换控件样式

**Files:**
- Modify: `client/src/styles.css` (在 nav 相关区域附近新增 `.theme-toggle` 规则)

**Interfaces:**
- Consumes: Task 3 的 `.theme-toggle` / `.theme-toggle-dot` DOM。
- Produces: 键盘可达、有非颜色选中信号的切换控件样式（两主题共用，用现有变量）。

- [ ] **Step 1: 新增 .theme-toggle 样式**

在 `client/src/styles.css` 靠近 `.command-hint` 定义处（`nav-items`/`command-hint` 规则附近）新增：

```css
.theme-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  margin: 0 var(--space-3) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: var(--rule) solid var(--line-strong);
  border-radius: var(--radius-2);
  background: var(--paper-raised);
  color: var(--ink);
  font-weight: 700;
  cursor: pointer;
}
.theme-toggle:hover { background: var(--paper-hover); }
.theme-toggle:focus-visible { outline: var(--rule) solid var(--focus); outline-offset: 2px; }
.theme-toggle .theme-toggle-dot {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: var(--rule) solid var(--line-strong); border-radius: 50%;
  background: var(--stamp-red);
}
.theme-toggle small { margin-left: auto; color: var(--ink-3); font-family: var(--font-machine); font-size: var(--text-xs); letter-spacing: .06em; }
```

- [ ] **Step 2: 移动端隐藏文字随现有规则**

确认压缩侧栏断点（`client/src/styles.css:1760-1762` 与 `:3155-3157` 附近的 `.brand-mark div, .nav-items span … { display: none; }`）追加 `.theme-toggle small, .theme-toggle > span:not(.theme-toggle-dot)` 一并隐藏，只留圆点，避免溢出。在两处断点规则的选择器列表里加入这两个选择器。

- [ ] **Step 3: 验证构建**

Run: `npm run build:client`
Expected: 构建成功。

- [ ] **Step 4: 手测两主题切换**

Run: `npm run dev:client`（后台起），浏览器打开 `#office`；点击侧栏切换按钮，确认配色即时切换、刷新后记住；320px 宽度下无横向溢出。

- [ ] **Step 5: Commit**

```bash
git add client/src/styles.css
git commit -m "feat: style sidebar theme toggle for both themes"
```

---

### Task 5: styles.css — 蜡笔主题覆盖块（描边 + mark）

**Files:**
- Modify: `client/src/styles.css` (文件末尾新增 `[data-theme="crayon"]` 覆盖块)

**Interfaces:**
- Consumes: Task 3 的 `#crayon-edge` filter；现有类名 `.brand-sprite`, dossier/卡片/按钮类。
- Produces: crayon 主题下的手绘描边、蜡笔投影、重绘品牌 mark。

- [ ] **Step 1: 新增蜡笔描边与投影覆盖**

在 `client/src/styles.css` 末尾追加：

```css
/* ============ Crayon Shin-chan theme overrides ============ */
[data-theme="crayon"] .run-card,
[data-theme="crayon"] .record-list,
[data-theme="crayon"] .dossier-section,
[data-theme="crayon"] .nav-items button,
[data-theme="crayon"] .command-hint,
[data-theme="crayon"] .theme-toggle,
[data-theme="crayon"] .brand-mark > .brand-sprite {
  filter: url(#crayon-edge);
}

[data-theme="crayon"] {
  --shadow-paper: 4px 5px 1px var(--paper-shadow);
  --shadow-paper-small: 2px 2px 1px var(--paper-shadow);
  --shadow-lift: 3px 4px 1px var(--paper-shadow);
  --shadow-modal: 6px 7px 2px var(--pixel-shadow);
}

@media (prefers-reduced-motion: reduce) {
  [data-theme="crayon"] .run-card,
  [data-theme="crayon"] .record-list,
  [data-theme="crayon"] .dossier-section,
  [data-theme="crayon"] .nav-items button,
  [data-theme="crayon"] .command-hint,
  [data-theme="crayon"] .theme-toggle,
  [data-theme="crayon"] .brand-mark > .brand-sprite {
    filter: none;
  }
}
```

> 描边加粗：蜡笔主题下大量卡片已用 `border: 2px …` + `var(--line-strong)`；`--line-strong` 在 crayon 已是暖褐深色，配合 filter 抖动即得手绘感。若某类边框偏细，可在此块内针对性加 `border-width: 3px`，但不改像素主题。

- [ ] **Step 2: 重绘品牌 mark（crayon）**

在同一覆盖块内追加，覆盖现有 `.brand-sprite i` 的像素嫩芽为蜡笔双叶：

```css
[data-theme="crayon"] .brand-mark > .brand-sprite {
  background: var(--season-summer-soft);
  border-radius: 46% 54% 50% 50% / 55% 50% 50% 45%;
}
[data-theme="crayon"] .brand-sprite i {
  width: 10px;
  height: 14px;
  background: none;
  box-shadow: none;
  border-radius: 0;
}
[data-theme="crayon"] .brand-sprite i::before,
[data-theme="crayon"] .brand-sprite i::after {
  content: "";
  position: absolute;
  width: 11px; height: 14px;
  background: var(--seal-green);
  border: 2px solid var(--line-strong);
  border-radius: 0 90% 0 90%;
}
[data-theme="crayon"] .brand-sprite i::before { transform: translate(-8px, -2px) rotate(-18deg); }
[data-theme="crayon"] .brand-sprite i::after  { transform: translate(2px, -2px) rotate(18deg); background: var(--season-spring); }
```

> 前置检查：确认 `.brand-sprite i` 的定位上下文允许 `position: absolute`（`.brand-sprite` 已是 `position: relative`，见 `client/src/styles.css:2086`）。crayon 下把像素 box-shadow 清零并用两片伪元素叶子表达"双叶"。像素主题的 `.brand-sprite i`（`:2098-2111`）不受影响。

- [ ] **Step 3: 验证构建与两主题外观**

Run: `npm run build:client` → 成功。
Run: `npm run dev:client`，切到蜡笔主题看品牌 mark 是双叶、卡片边缘有手绘抖动；切到像素主题确认恢复原精灵与规整边、无 filter 残留。

- [ ] **Step 4: Commit**

```bash
git add client/src/styles.css
git commit -m "feat: crayon theme hand-drawn edges, shadows, and twin-leaf brand mark"
```

---

### Task 6: 文档同步 + 全量验收

**Files:**
- Modify: `docs/workbench-ui.md:1` (标题与视觉规则段), `design.md` (主题体系说明)

**Interfaces:**
- Consumes: 全部前序 Task。
- Produces: 文档反映双主题；`npm run check` 全绿。

- [ ] **Step 1: 更新 docs/workbench-ui.md**

- 标题 `# Workbench UI：迪士尼乐园` → `# Workbench UI：双叶幼儿园`。
- 在「视觉规则」段说明：默认蜡笔小新皮肤（暖阳配色、手绘描边、双叶 mark），可切治愈像素皮肤；切换入口在侧栏并 localStorage 记忆；品牌名固定双叶幼儿园，正文主题词汇不随主题变；美术全原创、无版权素材、无 Emoji 状态图标；蜡笔 filter 有规整降级。

- [ ] **Step 2: 更新 design.md**

在视觉基线中补充双主题体系：`data-theme` 机制、变量分层（crayon 默认 / pixel 覆盖）、质感差异集中在 crayon 覆盖块、`#crayon-edge` filter 与降级策略。保留原「治愈像素」描述作为 pixel 主题。

- [ ] **Step 3: 全仓库残留品牌名检查**

Run: `grep -rn "迪士尼" client src docs design.md README.md`
Expected: 无输出（README 若出现品牌名一并改为双叶幼儿园）。

- [ ] **Step 4: 全量验收**

Run: `npm run check`
Expected: typecheck + test + build 全部 PASS。若快照测试因文案变化失败，确认差异符合预期后更新快照并复跑。

- [ ] **Step 5: 断点与降级人工验收**

`npm run dev:client`，在 320/768/1280/1440px 下逐一确认两主题无页面级横向溢出；开系统「减弱动态效果」后确认蜡笔 filter 关闭、描边回落规整且功能完整；键盘 Tab 到主题切换按钮可 Enter/Space 激活、焦点环可见。

- [ ] **Step 6: Commit**

```bash
git add docs/workbench-ui.md design.md README.md
git commit -m "docs: document switchable Futaba Kindergarten theme system"
```

---

## Self-Review

**Spec coverage:**
- 全局改名双叶幼儿园 → Task 3 Step 4/5、Task 6 Step 1/2/3 ✓
- 可切换 Theme（crayon 默认/pixel） → Task 1、Task 2、Task 3 ✓
- 侧栏切换 + localStorage 记忆 → Task 1（persist）、Task 3 Step 5、Task 4 ✓
- 只切视觉、正文词汇不变 → 全局约束 + Task 2/5 仅动配色与质感 ✓
- 配色变量名不变、组件零改动 → Task 2 ✓
- 明显蜡笔手绘描边 + 降级 → Task 3 Step 6（filter）、Task 5 Step 1（引用+reduced-motion 降级）✓
- 品牌 mark 重绘 → Task 5 Step 2 ✓
- IP 边界/无 Emoji/无远程字体图片 → 全局约束，方案全 CSS/SVG ✓
- 验收（npm run check / 多断点 / 非颜色状态 / 键盘） → Task 6 Step 4/5 ✓

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含具体代码。Task 3 测试步骤要求复用文件内既有渲染 helper（因该 helper 命名依赖现有测试文件，实现者需先读文件顶部）——已明确指示，非占位。

**Type consistency:** `ThemeName`/`DEFAULT_THEME`/`readTheme`/`applyTheme`/`THEME_STORAGE_KEY` 在 Task 1 定义、Task 3 消费，签名一致；`#crayon-edge` filter id 在 Task 3 定义、Task 5 引用，一致；`.theme-toggle`/`.theme-toggle-dot` 类名在 Task 3 产出、Task 4/5 消费，一致。
