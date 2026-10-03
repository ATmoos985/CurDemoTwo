/**
 * 系统设置与深浅主题插件 (Settings & Theme Plugin)
 */
import { bus } from '../../core/event-bus.js';
import { state } from '../../core/state.js';
import { showToast } from '../../core/toast.js';

export function solverSettings() {
    return {minRemnantWidth:Number(localStorage.getItem('cam_min_rem_w') ?? 200),
        minRemnantLength:Number(localStorage.getItem('cam_min_rem_l') ?? 300),
        timeLimitSeconds:Number(localStorage.getItem('cam_timeout') ?? 3)};
}

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
    if (modal && !modal.open) modal.showModal();
}

export function closeSettingsModal() {
    const modal = document.getElementById("settings-modal");
    if (modal) modal.close();
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
    const theme = localStorage.getItem("cam_theme") || "light";
    let origin = localStorage.getItem("cam_origin");
    if (!origin || origin === "right-top") {
        origin = "right-bottom";
        localStorage.setItem("cam_origin", "right-bottom");
    }
    const margin = localStorage.getItem("cam_margin") || "20";
    const trim = localStorage.getItem("cam_trim") || "0";
    const rot = localStorage.getItem("cam_rot") || "0";
    const longi = localStorage.getItem("cam_longi") || "1";
    const minRemW = localStorage.getItem("cam_min_rem_w") || "200";
    const minRemL = localStorage.getItem("cam_min_rem_l") || "300";
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
    if (document.getElementById("cfg-timeout")) document.getElementById("cfg-timeout").value = timeout;
    if (document.getElementById("cfg-first-stage")) document.getElementById("cfg-first-stage").value = firstStage;
}

export function saveSettings() {
    for (const input of document.querySelectorAll('#settings-modal input[type="number"]')) {
        if (!input.value.trim() || !input.reportValidity()) return showToast('请填写有效的参数范围', 'warning');
    }
    const theme = document.getElementById("cfg-theme-select").value;
    const origin = document.getElementById("cfg-cut-origin").value;
    const margin = document.getElementById("cfg-defect-margin").value;
    const trim = document.getElementById("cfg-trim-start").value;
    const rot = document.getElementById("cfg-allow-rot").value;
    const longi = document.getElementById("cfg-allow-longi").value;
    const minRemW = document.getElementById("cfg-min-rem-w").value;
    const minRemL = document.getElementById("cfg-min-rem-l").value;
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
    localStorage.setItem("cam_timeout", timeout);
    localStorage.setItem("cam_first_stage", firstStage);

    setTheme(theme);
    if (document.getElementById("sel-cut-origin")) document.getElementById("sel-cut-origin").value = origin;
    if (document.getElementById("inp-trim-start")) document.getElementById("inp-trim-start").value = trim;
    if (document.getElementById("sel-allow-rotation")) document.getElementById("sel-allow-rotation").value = rot;
    if (document.getElementById("sel-allow-longitudinal")) document.getElementById("sel-allow-longitudinal").value = longi;
    if (document.getElementById("sel-first-stage")) document.getElementById("sel-first-stage").value = firstStage;
    state.pendingPlan = null;

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
    showToast('本机设置已保存，下一次排料使用新参数；已有方案保留原参数', 'success');
}

export function restoreDefaultSettings() {
    const defaults = {'cfg-theme-select':'light','cfg-cut-origin':'right-bottom','cfg-defect-margin':20,
        'cfg-trim-start':0,'cfg-allow-rot':0,'cfg-allow-longi':1,'cfg-min-rem-w':200,'cfg-min-rem-l':300,
        'cfg-timeout':3,'cfg-first-stage':'horizontal'};
    Object.entries(defaults).forEach(([id,value]) => document.getElementById(id).value = value);
    showToast('已填入默认值，点击保存后应用', 'info');
}
