/**
 * 工业数控 G-Code / AutoCAD DXF 导出引擎与车间工单打印插件 (CAM Export Plugin)
 * 适配格柏(Gerber)、力克(Lectra)、爱科(IECHO)、拓卡奔马(Topcut-Bullmer)及通用数控裁床
 */
import { state } from '../../core/state.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';
import { canUseCurrentPlan } from '../../business/cutting/solver-client.js';
import { showToast } from '../../core/toast.js';
import { gcodeText, dxfText } from './cam-format.js';

function requireValidatedPlan() {
    if (canUseCurrentPlan()) return true;
    showToast('请先生成方案或校验调整版，再打印或导出', 'warning');
    return false;
}

/**
 * 生成标准 Fanuc / ISO 格式工业数控 G-Code (.nc)。文本由纯函数 cam-format.gcodeText 生成，这里只补经典页面的全局输入。
 */
export function generateGCode(caseData = null, options = {}) {
    const data = caseData || state.getCurrentCaseData();
    return gcodeText(data, {...options, optimized: state.isToolpathOptimized, home: getHomeCoordinates(data)});
}

/**
 * 生成标准 AutoCAD R12/2000 ASCII DXF 图纸（6 个图层），文本由 cam-format.dxfText 生成。
 */
export function generateDXF(caseData = null) {
    const data = caseData || state.getCurrentCaseData();
    return dxfText(data, {home: getHomeCoordinates(data)});
}

/**
 * 触发物理文件下载
 */
export function downloadFile(filename, content, mimeType = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 模态窗口：导出数控机床代码 (CNC G-Code / AutoCAD DXF)
 */
export function openExportModal(defaultTab = 'gcode') {
    if (!requireValidatedPlan()) return;
    let modal = document.getElementById("cam-export-modal");
    if (!modal) {
        createExportModalDOM();
        modal = document.getElementById("cam-export-modal");
    }
    if (!modal.open) modal.showModal();
    switchExportTab(defaultTab);
}

export function closeExportModal() {
    const modal = document.getElementById("cam-export-modal");
    if (modal) modal.close();
}

export function switchExportTab(tabName) {
    if (!requireValidatedPlan()) return;
    const btnGcode = document.getElementById("tab-export-gcode");
    const btnDxf = document.getElementById("tab-export-dxf");
    const preview = document.getElementById("export-preview-content");
    const btnDownload = document.getElementById("btn-download-export-file");
    const lblStats = document.getElementById("export-file-stats");

    if (tabName === 'gcode') {
        if (btnGcode) btnGcode.classList.add("active");
        if (btnDxf) btnDxf.classList.remove("active");
        const gcodeText = generateGCode();
        if (preview) preview.value = gcodeText;
        if (lblStats) lblStats.innerText = `格式: Fanuc/ISO 风格代码 | 行数: ${gcodeText.split('\n').length} 行 | 大小: ${(gcodeText.length / 1024).toFixed(1)} KB`;
        if (btnDownload) {
            btnDownload.innerText = "下载 G-Code (.nc)";
            btnDownload.onclick = () => {
                if (!requireValidatedPlan()) return;
                const rollId = state.getCurrentCaseData().rollId || "ROLL-01";
                downloadFile(`CUT_${rollId}_STATION_01.nc`, preview.value);
            };
        }
    } else {
        if (btnDxf) btnDxf.classList.add("active");
        if (btnGcode) btnGcode.classList.remove("active");
        const dxfText = generateDXF();
        if (preview) preview.value = dxfText;
        if (lblStats) lblStats.innerText = `格式: AutoCAD R12/2000 ASCII DXF (分6层) | 行数: ${dxfText.split('\n').length} 行 | 大小: ${(dxfText.length / 1024).toFixed(1)} KB`;
        if (btnDownload) {
            btnDownload.innerText = "下载 AutoCAD DXF (.dxf)";
            btnDownload.onclick = () => {
                if (!requireValidatedPlan()) return;
                const rollId = state.getCurrentCaseData().rollId || "ROLL-01";
                downloadFile(`CUT_${rollId}_STATION_01.dxf`, preview.value);
            };
        }
    }
}

export function copyExportPreview() {
    if (!requireValidatedPlan()) return;
    const preview = document.getElementById("export-preview-content");
    if (!preview) return;
    preview.select();
    Promise.resolve().then(() => navigator.clipboard.writeText(preview.value)).then(() => {
        const btn = document.getElementById("btn-copy-export-code");
        if (btn) {
            const oldText = btn.innerText;
            btn.innerText = "已复制至剪贴板!";
            btn.style.color = "#10b981";
            setTimeout(() => {
                btn.innerText = oldText;
                btn.style.color = "";
            }, 1800);
        }
    }).catch(() => {
        document.getElementById('export-file-stats').textContent='无法访问剪贴板，代码已选中，可按 Ctrl+C 手动复制。';
    });
}

function createExportModalDOM() {
    const div = document.createElement("dialog");
    div.id = "cam-export-modal";
    div.className = "settings-native-dialog";
    div.setAttribute("aria-labelledby","export-title");
    div.innerHTML = `
        <div class="settings-modal-dialog" style="width: 820px; max-width: 95vw; height: 600px; display: flex; flex-direction: column;">
            <div class="settings-modal-header">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <h2 id="export-title">机床代码 / DXF 预览</h2>

                </div>
                <button class="tool-btn" onclick="window.cutApp.plugins.export.closeExportModal()">关闭</button>
            </div>
            <div class="settings-nav-tabs" style="padding: 0 16px; margin-top: 8px;">
                <button class="settings-tab-btn active" id="tab-export-gcode" onclick="window.cutApp.plugins.export.switchExportTab('gcode')">数控代码 (.nc)</button>
                <button class="settings-tab-btn" id="tab-export-dxf" onclick="window.cutApp.plugins.export.switchExportTab('dxf')">图纸 (.dxf)</button>
            </div>
            <div style="padding: 6px 16px; font-size: 11px; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center;">
                <span id="export-file-stats">正在准备数据...</span>
                <button id="btn-copy-export-code" class="tool-btn" style="padding: 2px 10px; font-size: 11px;" onclick="window.cutApp.plugins.export.copyExportPreview()">复制全部代码</button>
            </div>
            <div style="flex: 1; padding: 0 16px 10px; min-height: 0;">
                <textarea id="export-preview-content" readonly style="width: 100%; height: 100%; font-family: 'Consolas', 'Courier New', monospace; font-size: 11.5px; background: var(--bg-main); color: var(--text-main); border: 1px solid var(--panel-border); border-radius: 4px; padding: 10px; resize: none; outline: none; line-height: 1.45;"></textarea>
            </div>
            <div class="settings-footer">
                <span style="font-size: 11px; color: var(--text-muted);">示例导出格式。使用前需按实际机台检查坐标、进给和刀具参数。</span>
                <div style="display: flex; gap: 8px;">
                    <button class="tool-btn" onclick="window.cutApp.plugins.export.closeExportModal()">取消</button>
                    <button class="tool-btn active" id="btn-download-export-file">下载文件</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

export {openCutTicketModal,closeCutTicketModal,printCutTicketDocument} from "./cut-ticket.js";
