/**
 * 布局动态拖拽调节与卡片折叠插件 (Splitter & Layout Plugin)
 */
import { bus } from '../../core/event-bus.js';

export function toggleSectionCollapse(headerEl) {
    const section = headerEl.closest(".panel-section");
    if (!section) return;
    section.classList.toggle("collapsed");
}

export function toggleSidebar(side) {
    if (side === "left") {
        const bar = document.getElementById("sidebar-left");
        const resizer = document.getElementById("resizer-left");
        const edgeBtn = document.getElementById("edge-toggle-left");
        const topBtn = document.getElementById("btn-toggle-left-bar");
        if (!bar) return;
        const isCollapsed = bar.classList.toggle("collapsed");
        if (resizer) resizer.style.display = isCollapsed ? "none" : "flex";
        if (edgeBtn) edgeBtn.style.display = isCollapsed ? "flex" : "none";
        if (topBtn) topBtn.innerText = isCollapsed ? "展开左栏" : "收起左栏";
        if (!isCollapsed) {
            const savedW = localStorage.getItem("cutdemo_left_sidebar_w") || "380";
            bar.style.width = `${savedW}px`;
        }
    } else if (side === "right") {
        const bar = document.getElementById("sidebar-right");
        const resizer = document.getElementById("resizer-right");
        const edgeBtn = document.getElementById("edge-toggle-right");
        const topBtn = document.getElementById("btn-toggle-right-bar");
        if (!bar) return;
        const isCollapsed = bar.classList.toggle("collapsed");
        if (resizer) resizer.style.display = isCollapsed ? "none" : "flex";
        if (edgeBtn) edgeBtn.style.display = isCollapsed ? "flex" : "none";
        if (topBtn) topBtn.innerText = isCollapsed ? "展开右栏" : "收起右栏";
        if (!isCollapsed) {
            const savedW = localStorage.getItem("cutdemo_right_sidebar_w") || "360";
            bar.style.width = `${savedW}px`;
        }
    }
    setTimeout(() => {
        bus.emit('viewport:resized');
    }, 60);
}

export function initLayoutResizers() {
    const leftResizer = document.getElementById("resizer-left");
    const rightResizer = document.getElementById("resizer-right");
    const leftSidebar = document.getElementById("sidebar-left");
    const rightSidebar = document.getElementById("sidebar-right");

    const savedLeftW = localStorage.getItem("cutdemo_left_sidebar_w");
    const savedRightW = localStorage.getItem("cutdemo_right_sidebar_w");
    if (savedLeftW && leftSidebar) leftSidebar.style.width = `${Math.max(260, Math.min(650, parseInt(savedLeftW)))}px`;
    if (savedRightW && rightSidebar) rightSidebar.style.width = `${Math.max(280, Math.min(700, parseInt(savedRightW)))}px`;

    function onCanvasResize() {
        bus.emit('viewport:resized');
    }

    if (leftResizer && leftSidebar) {
        let isDragging = false;
        let startX = 0;
        let startW = 0;

        leftResizer.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startW = leftSidebar.getBoundingClientRect().width;
            leftResizer.classList.add("resizing");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            try { leftResizer.setPointerCapture(e.pointerId); } catch(err){}
        });

        leftResizer.addEventListener("pointermove", (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - startX;
            const newW = Math.max(260, Math.min(650, Math.round(startW + deltaX)));
            leftSidebar.style.width = `${newW}px`;
            onCanvasResize();
        });

        const stopLeftDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            leftResizer.classList.remove("resizing");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            try { leftResizer.releasePointerCapture(e.pointerId); } catch(err){}
            localStorage.setItem("cutdemo_left_sidebar_w", leftSidebar.getBoundingClientRect().width);
            onCanvasResize();
        };
        leftResizer.addEventListener("pointerup", stopLeftDrag);
        leftResizer.addEventListener("pointercancel", stopLeftDrag);

        leftResizer.addEventListener("dblclick", () => {
            leftSidebar.style.width = "380px";
            localStorage.setItem("cutdemo_left_sidebar_w", "380");
            onCanvasResize();
        });
    }

    if (rightResizer && rightSidebar) {
        let isDragging = false;
        let startX = 0;
        let startW = 0;

        rightResizer.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startW = rightSidebar.getBoundingClientRect().width;
            rightResizer.classList.add("resizing");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            try { rightResizer.setPointerCapture(e.pointerId); } catch(err){}
        });

        rightResizer.addEventListener("pointermove", (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - startX;
            const newW = Math.max(280, Math.min(700, Math.round(startW - deltaX)));
            rightSidebar.style.width = `${newW}px`;
            onCanvasResize();
        });

        const stopRightDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            rightResizer.classList.remove("resizing");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            try { rightResizer.releasePointerCapture(e.pointerId); } catch(err){}
            localStorage.setItem("cutdemo_right_sidebar_w", rightSidebar.getBoundingClientRect().width);
            onCanvasResize();
        };
        rightResizer.addEventListener("pointerup", stopRightDrag);
        rightResizer.addEventListener("pointercancel", stopRightDrag);

        rightResizer.addEventListener("dblclick", () => {
            rightSidebar.style.width = "360px";
            localStorage.setItem("cutdemo_right_sidebar_w", "360");
            onCanvasResize();
        });
    }
}

export function switchRightPanelTab(tabName) {
    const btnCut = document.getElementById("tab-right-cut");
    const btnBal = document.getElementById("tab-right-balance");
    const paneCut = document.getElementById("tab-pane-cut");
    const paneBal = document.getElementById("tab-pane-balance");

    if (btnCut) btnCut.classList.toggle("active", tabName === "cut");
    if (btnBal) btnBal.classList.toggle("active", tabName === "balance");
    if (paneCut) paneCut.style.display = (tabName === "cut") ? "flex" : "none";
    if (paneBal) paneBal.style.display = (tabName === "balance") ? "flex" : "none";
}
