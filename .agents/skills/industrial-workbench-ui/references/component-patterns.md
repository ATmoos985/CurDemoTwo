# 工业现场工作台核心组件与布局模式

本文件提供工业工作台各核心 UI 模块的生产级 HTML / CSS 结构模式。

---

## 1. 三栏工作台骨架布局 (Tri-Column Layout)

```html
<div class="workbench-layout">
    <!-- 顶栏 -->
    <header class="app-header">
        <div class="header-left">
            <span class="app-mark">▥</span>
            <span class="app-title">车间下料工作台</span>
        </div>
        <div class="header-nav" data-product-nav>
            <a href="/workbench" aria-current="page">作业工作台</a>
            <a href="/lab">试验台</a>
            <a href="/inventory">库存档案</a>
        </div>
        <div class="header-actions">
            <button class="tool-btn" onclick="openPrintModal()">打印工单</button>
        </div>
    </header>

    <!-- 流程任务栏 -->
    <nav class="task-bar" aria-label="作业流程">
        <div class="task-toolbar">
            <button class="tool-btn">新建任务</button>
            <button class="tool-btn">打开任务</button>
            <span id="task-state">草稿 (本机已存)</span>
        </div>
        <ol class="workflow-stages">
            <li><button type="button" aria-current="step"><span class="stage-marker">1</span>需求</button></li>
            <li><button type="button"><span class="stage-marker">2</span>选料</button></li>
            <li><button type="button"><span class="stage-marker">3</span>排料</button></li>
            <li><button type="button"><span class="stage-marker">4</span>报工</button></li>
        </ol>
        <div class="task-records">
            <button class="tool-btn">方案历史</button>
        </div>
    </nav>

    <!-- 三栏主视窗 -->
    <main class="workbench-main">
        <!-- 左栏：材料与需求 -->
        <aside class="sidebar sidebar-left" style="width: 320px;">
            <!-- 吸顶材料摘要 (重要：滚动时不被淹没) -->
            <section class="material-context-sticky">
                <div>
                    <span>本次用料</span>
                    <button class="tool-btn" onclick="openMaterialPicker()">更换用料</button>
                </div>
                <strong>ROLL-2026-0920 (2000mm)</strong>
                <p>余量 45.2 m | 仓位 A-02</p>
            </section>

            <!-- 需求列表 (滚动区) -->
            <div class="sidebar-scroll-body">
                <div class="demands-container">
                    <!-- 需求条目 -->
                </div>
            </div>
        </aside>

        <!-- 左侧拖拽拉手 -->
        <div class="layout-resizer resizer-left"><div class="resizer-handle"></div></div>

        <!-- 中栏：CAD 画布视口 -->
        <section class="viewport-container">
            <div class="canvas-header">
                <h2>排料预览</h2>
                <div class="view-controls">
                    <button class="tool-btn" onclick="fitView()">适合材料</button>
                </div>
            </div>
            <!-- 母卷全局瑕疵雷达条 -->
            <div class="roll-radar-bar">
                <div class="radar-track">
                    <div class="radar-window" role="slider" aria-label="工位位置"></div>
                </div>
            </div>
            <!-- 画布容器 -->
            <div id="cad-canvas-host"></div>
        </section>

        <!-- 右侧拖拽拉手 -->
        <div class="layout-resizer resizer-right"><div class="resizer-handle"></div></div>

        <!-- 右栏：排料结果与报工台账 -->
        <aside class="sidebar sidebar-right" style="width: 300px;">
            <div class="sidebar-scroll-body">
                <div class="result-metrics">
                    <div><span>预计利用率</span><strong>86.4%</strong></div>
                    <div><span>预计耗料</span><strong>3250 mm</strong></div>
                </div>
                <!-- 面积守恒对账台账 -->
                <details class="detail-disclosure" open>
                    <summary>面积核算明细</summary>
                    <div class="prop-row"><span>成品净面积</span><b>5.21 m²</b></div>
                    <div class="prop-row"><span>派生余料面积</span><b>0.82 m²</b></div>
                    <div class="prop-row"><span>加工区占用率</span><b>92.0%</b></div>
                </details>
            </div>

            <!-- 吸底主操作区 (常驻第一屏，永不被滚动淹没) -->
            <div class="sidebar-pinned-footer">
                <strong class="workflow-current-title">当前：第 3 工位待报工</strong>
                <button class="workflow-primary-btn" onclick="submitCutReport()">确认报工并入库</button>
                <details class="detail-disclosure reset-actions">
                    <summary>次级操作与撤销</summary>
                    <button class="tool-btn" onclick="undoAdjustment()">撤销手调</button>
                    <button class="tool-btn" onclick="clearStationCuts()">清除本工位</button>
                </details>
            </div>
        </aside>
    </main>

    <!-- 底部状态栏 -->
    <footer class="app-footer">
        <span>当前母卷: ROLL-2026-0920</span>
        <span id="cursor-pos">X: 120.5 mm | Y: 300.0 mm</span>
        <span>缩放: 100%</span>
        <span>引擎: GUILLOTINE-ONLINE</span>
    </footer>
</div>
```

---

## 2. 吸底主操作区 CSS 范式

```css
.sidebar-right {
    display: flex;
    flex-direction: column;
    height: 100%;
}

.sidebar-scroll-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
}

.sidebar-pinned-footer {
    flex-shrink: 0;
    padding: 12px 14px;
    background: var(--panel-bg);
    border-top: 1px solid var(--panel-border);
}

.workflow-primary-btn {
    width: 100%;
    min-height: 42px;
    margin: 8px 0;
    font-size: 14px;
    font-weight: 600;
    background: var(--accent-blue);
    border: 1px solid var(--accent-blue);
    color: #ffffff;
    border-radius: var(--control-radius);
    cursor: pointer;
    transition: background 0.15s ease;
}

.workflow-primary-btn:hover {
    filter: brightness(1.1);
}
```

---

## 3. 生产工单打印样式规范 (Cut Ticket Print Pattern)

```css
/* 打印基础设置 */
@page {
    size: A4 portrait;
    margin: 12mm;
}

@media print {
    /* 1. 隐藏无关的屏幕交互界面与弹窗阴影 */
    body {
        background: #ffffff !important;
        color: #000000 !important;
        height: auto !important;
        overflow: visible !important;
    }
    
    .workbench-layout,
    .app-header,
    .task-bar,
    .sidebar,
    .app-footer,
    .dialog-actions,
    .dialog-heading {
        display: none !important;
    }

    /* 2. 工单宿主全宽显示 */
    #cut-ticket-dialog,
    #printable-cut-ticket-area {
        display: block !important;
        position: static !important;
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
    }

    /* 3. 防止打印分页撕裂 */
    .ticket-meta,
    .ticket-diagram,
    .ticket-sign-box,
    tr {
        break-inside: avoid;
    }

    h2, h3 {
        break-after: avoid;
    }

    thead {
        display: table-header-group; /* 表格跨页自动重复表头 */
    }

    /* 4. 工单数据表格紧凑高对比度 */
    .ticket-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 10pt;
    }

    .ticket-table th, 
    .ticket-table td {
        border: 1px solid #94a3b8;
        padding: 4px 6px;
        text-align: left;
    }

    .ticket-table th {
        background: #f1f5f9 !important;
        font-weight: 600;
    }
}
```
