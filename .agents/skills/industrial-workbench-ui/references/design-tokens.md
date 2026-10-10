# 工业现场工作台 Design Tokens 规范与 CSS 变量字典

本文件整理了工业工作台（Industrial Workbench）经过实战验证的 CSS 设计变量字典。

---

## 1. 核心变量字典 (:root)

```css
:root {
    /* ================= 控件尺度与几何 ================= */
    --control-radius: 4px;              /* 按钮、输入框、下拉框统一圆角 */
    --dialog-radius: 8px;               /* 模态弹窗、卡片大圆角 */
    --dialog-shade: rgba(24, 39, 51, 0.4); /* 弹窗遮罩半透明阴影，禁用虚化以降低工控机GPU压力 */

    /* ================= 工业等宽字体 ================= */
    --font-mono: "JetBrains Mono", Consolas, "Courier New", monospace;
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

    /* ================= 暗色主题基准 (Dark Default) ================= */
    --bg-dark: #0f172a;                 /* 视口/工作区底层色 Slate-900 */
    --panel-bg: #1e293b;                /* 左右控制面板底色 Slate-800 */
    --panel-header: #111e38;            /* 面板表头、只读输入框底色 */
    --panel-border: #334155;            /* 面板与卡片分割边框 Slate-700 */

    --text-main: #f8fafc;               /* 主文本高对比度白色 Slate-50 */
    --text-muted: #94a3b8;              /* 辅助说明/单位文本 Slate-400 */

    /* 工业控制语义强调色 */
    --accent-blue: #0284c7;             /* 主动作、选中聚焦、高亮 Sky-600 */
    --accent-green: #10b981;            /* 合格、就绪、达标 Emerald-500 */
    --accent-red: #ef4444;              /* 切刀、疵点、危险 Red-500 */
    --accent-amber: #f59e0b;            /* 余料料头、警告 Amber-500 */

    /* 状态文字色 */
    --status-ok: #8fd1ae;
    --status-warn: #ecc57d;
    --status-error: #ffa59d;

    /* 辅助卡片底色 */
    --card-box-bg: #172234;
    --card-tip-bg: #2d2314;
    --card-tip-color: #fbbf24;
    --card-tip-border: #92400e;
}
```

---

## 2. 浅色主题变量 ([data-theme="light"])

```css
[data-theme="light"] {
    --bg-dark: #f8fafc;                 /* 视口底色 Slate-50 */
    --panel-bg: #ffffff;                /* 控制面板纯白底色 */
    --panel-header: #f1f5f9;            /* 面板表头、只读底色 Slate-100 */
    --panel-border: #cbd5e1;            /* 分割线 Slate-300 */

    --text-main: #0f172a;               /* 主文本深黑 Slate-900 */
    --text-muted: #475569;              /* 辅助文本 Slate-600 */

    --accent-blue: #0284c7;
    --accent-green: #059669;
    --accent-red: #dc2626;
    --accent-amber: #d97706;

    --status-ok: #276749;
    --status-warn: #855e20;
    --status-error: #a23f36;

    --card-box-bg: #f8fafc;
    --card-tip-bg: #fef3c7;
    --card-tip-color: #92400e;
    --card-tip-border: #f59e0b;
}
```

---

## 3. 标准控件样式继承范式

```css
/* 全局重置与字体继承 */
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    background-color: var(--bg-dark);
    color: var(--text-main);
    font-family: var(--font-ui);
    overflow: hidden;
    height: 100vh;
}

/* 统一输入框规范 */
input, select, textarea {
    font-family: inherit;
    font-size: 13px;
    color: var(--text-main);
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: var(--control-radius);
    padding: 6px 8px;
}

input:read-only:not([type=checkbox]) {
    background: var(--panel-header);
    color: var(--text-muted);
}

/* 焦点指示系统 */
input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: 1px;
}
```
