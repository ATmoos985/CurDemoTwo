/**
 * 系统设置与深浅主题插件 (Settings & Theme Plugin)
 */
import { bus } from '../../core/event-bus.js';
import { state } from '../../core/state.js';

export function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "light" ? "dark" : "light";
    setTheme(next);
}

export function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cam_theme", theme);
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) {
        btn.innerText = theme === "light" ? "深色模式" : "浅色模式";
    }
    const modalSel = document.getElementById("cfg-theme-select");
    if (modalSel) modalSel.value = theme;

    bus.emit('theme:changed', theme);
}

export function openSettingsModal() {
    loadSavedSettings();
    const modal = document.getElementById("settings-modal");
    if (modal) modal.style.display = "flex";
}

export function closeSettingsModal() {
    const modal = document.getElementById("settings-modal");
    if (modal) modal.style.display = "none";
}

export function switchSettingsTab(tabName) {
    document.querySelectorAll(".settings-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".settings-tab-pane").forEach(p => p.classList.remove("active"));
    const btn = document.getElementById(`tab-btn-${tabName}`);
    const pane = document.getElementById(`pane-${tabName}`);
    if (btn) btn.classList.add("active");
    if (pane) pane.classList.add("active");
}

export function loadSavedSettings() {
    const theme = localStorage.getItem("cam_theme") || "dark";
    const origin = localStorage.getItem("cam_origin") || "right-top";
    const margin = localStorage.getItem("cam_margin") || "20";
    const trim = localStorage.getItem("cam_trim") || "0";
    const rot = localStorage.getItem("cam_rot") || "0";
    const longi = localStorage.getItem("cam_longi") || "1";
    const minRemW = localStorage.getItem("cam_min_rem_w") || "200";
    const minRemL = localStorage.getItem("cam_min_rem_l") || "300";
    const remHint = localStorage.getItem("cam_rem_hint") || "1";
    const timeout = localStorage.getItem("cam_timeout") || "3";
    const firstStage = localStorage.getItem("cam_first_stage") || "horizontal";

    if (document.getElementById("cfg-theme-select")) document.getElementById("cfg-theme-select").value = theme;
    if (document.getElementById("cfg-cut-origin")) document.getElementById("cfg-cut-origin").value = origin;
    if (document.getElementById("cfg-defect-margin")) document.getElementById("cfg-defect-margin").value = margin;
    if (document.getElementById("cfg-trim-start")) document.getElementById("cfg-trim-start").value = trim;
    if (document.getElementById("cfg-allow-rot")) document.getElementById("cfg-allow-rot").value = rot;
    if (document.getElementById("cfg-allow-longi")) document.getElementById("cfg-allow-longi").value = longi;
    if (document.getElementById("cfg-min-rem-w")) document.getElementById("cfg-min-rem-w").value = minRemW;
    if (document.getElementById("cfg-min-rem-l")) document.getElementById("cfg-min-rem-l").value = minRemL;
    if (document.getElementById("cfg-rem-hint")) document.getElementById("cfg-rem-hint").value = remHint;
    if (document.getElementById("cfg-timeout")) document.getElementById("cfg-timeout").value = timeout;
    if (document.getElementById("cfg-first-stage")) document.getElementById("cfg-first-stage").value = firstStage;
}

export function saveSettings() {
    const theme = document.getElementById("cfg-theme-select").value;
    const origin = document.getElementById("cfg-cut-origin").value;
    const margin = document.getElementById("cfg-defect-margin").value;
    const trim = document.getElementById("cfg-trim-start").value;
    const rot = document.getElementById("cfg-allow-rot").value;
    const longi = document.getElementById("cfg-allow-longi").value;
    const minRemW = document.getElementById("cfg-min-rem-w").value;
    const minRemL = document.getElementById("cfg-min-rem-l").value;
    const remHint = document.getElementById("cfg-rem-hint").value;
    const timeout = document.getElementById("cfg-timeout").value;
    const firstStage = document.getElementById("cfg-first-stage").value;

    localStorage.setItem("cam_theme", theme);
    localStorage.setItem("cam_origin", origin);
    localStorage.setItem("cam_margin", margin);
    localStorage.setItem("cam_trim", trim);
    localStorage.setItem("cam_rot", rot);
    localStorage.setItem("cam_longi", longi);
    localStorage.setItem("cam_min_rem_w", minRemW);
    localStorage.setItem("cam_min_rem_l", minRemL);
    localStorage.setItem("cam_rem_hint", remHint);
    localStorage.setItem("cam_timeout", timeout);
    localStorage.setItem("cam_first_stage", firstStage);

    setTheme(theme);
    if (document.getElementById("sel-cut-origin")) document.getElementById("sel-cut-origin").value = origin;
    if (document.getElementById("inp-trim-start")) document.getElementById("inp-trim-start").value = trim;
    if (document.getElementById("sel-allow-rotation")) document.getElementById("sel-allow-rotation").value = rot;
    if (document.getElementById("sel-allow-longitudinal")) document.getElementById("sel-allow-longitudinal").value = longi;

    const curCase = state.getCurrentCaseData();
    if (curCase) {
        curCase.cutOrigin = origin;
        curCase.trimStart = parseFloat(trim) || 0;
        curCase.allowRotation = (rot === "1");
        curCase.allowLongitudinal = (longi === "1");
        curCase.firstStageOrientation = firstStage;
    }

    closeSettingsModal();
    bus.emit('settings:updated', { curCase });
    alert("全局工艺参数与显示配置已成功保存并生效！");
}

export function restoreDefaultSettings() {
    if (!confirm("确定要恢复出厂默认参数配置吗？")) return;
    localStorage.removeItem("cam_theme");
    localStorage.removeItem("cam_origin");
    localStorage.removeItem("cam_margin");
    localStorage.removeItem("cam_trim");
    localStorage.removeItem("cam_rot");
    localStorage.removeItem("cam_longi");
    localStorage.removeItem("cam_min_rem_w");
    localStorage.removeItem("cam_min_rem_l");
    localStorage.removeItem("cam_rem_hint");
    localStorage.removeItem("cam_timeout");
    localStorage.removeItem("cam_first_stage");
    loadSavedSettings();
    setTheme("dark");
    alert("已恢复默认设置。");
}
