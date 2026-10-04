/**
 * 工业数控 G-Code / AutoCAD DXF 导出引擎与车间工单打印插件 (CAM Export Plugin)
 * 适配格柏(Gerber)、力克(Lectra)、爱科(IECHO)、拓卡奔马(Topcut-Bullmer)及通用数控裁床
 */
import { state } from '../../core/state.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';
import { canUseCurrentPlan } from '../solver/solver-client.js';
import { showToast } from '../../core/toast.js';

function requireValidatedPlan() {
    if (canUseCurrentPlan()) return true;
    showToast('请先生成方案或校验调整版，再打印或导出', 'warning');
    return false;
}

/**
 * 生成标准 Fanuc / ISO 格式工业数控 G-Code (.nc)
 */
export function generateGCode(caseData = null, options = {}) {
    const data = caseData || state.getCurrentCaseData();
    const cuts = data.cuts || [];
    const rollId = data.rollId || "ROLL-2026-0920";
    const rollW = data.rollW || 2000;
    const bedL = data.bedL || 5000;
    const winStartY = data.windowStartY || 0;
    const originStr = (data.cutOrigin || "right-bottom").toLowerCase();
    const home = getHomeCoordinates(data);

    const cutFeed = options.cutFeed || 4000;      // 切削进给速度 4000 mm/min
    const rapidFeed = options.rapidFeed || 15000;  // 空刀快移速度 15000 mm/min
    const plungeDelay = options.plungeDelay || 200; // 落刀延时 200 ms
    const retractDelay = options.retractDelay || 100; // 提刀延时 100 ms

    const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

    let gcode = [];
    gcode.push("(------------------------------------------------------------------)");
    gcode.push("( CAD/CAM FABRIC CUTTING PROGRAM - CNC G-CODE                      )");
    gcode.push(`( DATE CREATED  : ${dateStr}                              )`);
    gcode.push(`( MOTHER ROLL   : ${rollId} (Width: ${rollW} mm)                 )`);
    gcode.push(`( BED STATION   : 0 ~ ${bedL} mm (Global Y: ${winStartY} ~ ${winStartY + bedL} mm) )`);
    gcode.push(`( ORIGIN DATUM  : ${data.cutOrigin || 'right-bottom'}                                  )`);
    gcode.push(`( TOTAL CUTS    : ${cuts.length} STEPS                                   )`);
    gcode.push(`( OPTIMIZED     : ${state.isToolpathOptimized ? 'YES (Segment-TSP 2-Opt)' : 'NO (Sequential)'}            )`);
    gcode.push("( CONTROL TYPE  : 2D-Guillotine Oscillating Knife / Laser Cutting  )");
    gcode.push("(------------------------------------------------------------------)");
    gcode.push("");
    gcode.push("G21          (Metric Units: Millimeters)");
    gcode.push("G90          (Absolute Coordinate System)");
    gcode.push("G17          (XY Plane Selection)");
    gcode.push("G94          (Feed Rate: mm per minute)");
    gcode.push("M08          (Auxiliary: Bed Vacuum Absorption ON)");
    gcode.push("G04 P500     (Dwell 500ms for Vacuum Bed Stabilization)");
    gcode.push("");
    gcode.push(`(--- INITIAL RAPID TO HOME POSITION ---)`);
    gcode.push(`G00 X${home.x.toFixed(3)} Y${home.y.toFixed(3)} Z50.000 F${rapidFeed}`);
    gcode.push("");

    let lastX = home.x;
    let lastY = home.y;
    let totalCutDist = 0;
    let totalAirDist = 0;

    cuts.forEach((c) => {
        const isHoriz = (c.type === "横切");
        let startX, startY, endX, endY;

        if (c.startX !== undefined && c.endX !== undefined) {
            startX = c.startX; startY = c.startY;
            endX = c.endX; endY = c.endY;
        } else {
            startX = isHoriz ? c.start : c.pos;
            startY = isHoriz ? c.pos : c.start;
            endX = isHoriz ? c.end : c.pos;
            endY = isHoriz ? c.pos : c.end;
        }

        const airDist = Math.hypot(startX - lastX, startY - lastY);
        const cutDist = Math.hypot(endX - startX, endY - startY);
        totalAirDist += airDist;
        totalCutDist += cutDist;

        gcode.push(`(--- STEP ${c.step}: ${c.type} L=${Math.round(cutDist)}mm | ${c.info || ''} ---)`);
        // 1. 空走快移到下刀点
        gcode.push(`G00 X${startX.toFixed(3)} Y${startY.toFixed(3)} Z10.000 (Rapid Air Move)`);
        // 2. 落刀 / 开启刀具 / 延时稳定
        gcode.push(`M03 S1        (Tool Down / Laser ON)`);
        gcode.push(`G04 P${plungeDelay}     (Plunge Dwell)`);
        // 3. 工艺进给直线裁切
        gcode.push(`G01 X${endX.toFixed(3)} Y${endY.toFixed(3)} Z0.000 F${cutFeed} (Cutting Feed)`);
        // 4. 提刀 / 关闭刀具 / 延时稳定
        gcode.push(`M05          (Tool Up / Laser OFF)`);
        gcode.push(`G04 P${retractDelay}     (Retract Dwell)`);
        gcode.push("");

        lastX = endX;
        lastY = endY;
    });

    // 返回停靠原点并停机
    gcode.push("(--- RETURN TO HOME AND FINISH ---)");
    gcode.push(`G00 X${home.x.toFixed(3)} Y${home.y.toFixed(3)} Z50.000 F${rapidFeed}`);
    gcode.push("M09          (Vacuum Bed OFF)");
    gcode.push("M30          (End of Program / Rewind)");
    gcode.push(`(TOTAL CUT DISTANCE: ${Math.round(totalCutDist)} mm | TOTAL AIR DISTANCE: ${Math.round(totalAirDist)} mm)`);

    return gcode.join("\n");
}

/**
 * 生成标准 AutoCAD R12/2000 ASCII DXF 图纸
 * 包含 6 个专业图层：0_BORDER, 1_PIECES, 2_REMNANTS, 3_DEFECTS, 4_CUT_LINES, 5_RAPID_TRAVERSE
 */
export function generateDXF(caseData = null) {
    const data = caseData || state.getCurrentCaseData();
    const rollW = data.rollW || 2000;
    const bedL = data.bedL || 5000;
    const pieces = data.pieces || [];
    const remnants = data.remnants || [];
    const defects = data.globalDefects || data.defects || [];
    const cuts = data.cuts || [];
    const home = getHomeCoordinates(data);

    let dxf = [];

    // DXF HEADER
    dxf.push("0\nSECTION\n2\nHEADER");
    dxf.push("9\n$ACADVER\n1\nAC1009"); // AutoCAD R12 ASCII Standard
    dxf.push("9\n$INSUNITS\n70\n4");   // 4 = Millimeters
    dxf.push("0\nENDSEC");

    // DXF TABLES (LAYERS)
    dxf.push("0\nSECTION\n2\nTABLES");
    dxf.push("0\nTABLE\n2\nLAYER\n70\n6");
    
    // 图层定义: 0_BORDER (7: 白/黑), 1_PIECES (3: 绿), 2_REMNANTS (4: 青蓝), 3_DEFECTS (1: 红), 4_CUT_LINES (6: 洋红), 5_RAPID_TRAVERSE (5: 蓝)
    const layers = [
        { name: "0_FABRIC_BORDER", color: 7 },
        { name: "1_PIECES", color: 3 },
        { name: "2_REMNANTS", color: 4 },
        { name: "3_DEFECTS", color: 1 },
        { name: "4_CUT_LINES", color: 6 },
        { name: "5_RAPID_TRAVERSE", color: 5 }
    ];
    layers.forEach(l => {
        dxf.push(`0\nLAYER\n2\n${l.name}\n70\n0\n62\n${l.color}\n6\nCONTINUOUS`);
    });
    dxf.push("0\nENDTAB");
    dxf.push("0\nENDSEC");

    // DXF ENTITIES
    dxf.push("0\nSECTION\n2\nENTITIES");

    // 辅助函数：绘制矩形框
    function addRect(layer, x1, y1, x2, y2) {
        addLine(layer, x1, y1, x2, y1);
        addLine(layer, x2, y1, x2, y2);
        addLine(layer, x2, y2, x1, y2);
        addLine(layer, x1, y2, x1, y1);
    }

    // 辅助函数：绘制线段
    function addLine(layer, x1, y1, x2, y2) {
        dxf.push(`0\nLINE\n8\n${layer}\n10\n${x1.toFixed(3)}\n20\n${y1.toFixed(3)}\n30\n0.0\n11\n${x2.toFixed(3)}\n21\n${y2.toFixed(3)}\n31\n0.0`);
    }

    // 辅助函数：绘制文本
    function addText(layer, x, y, height, text) {
        dxf.push(`0\nTEXT\n8\n${layer}\n10\n${x.toFixed(3)}\n20\n${y.toFixed(3)}\n30\n0.0\n40\n${height.toFixed(1)}\n1\n${text}`);
    }

    // 1. 布料边界 (Layer: 0_FABRIC_BORDER)
    addRect("0_FABRIC_BORDER", 0, 0, rollW, bedL);
    addText("0_FABRIC_BORDER", 20, 20, 40, `BED STATION: ${rollW}x${bedL}mm`);

    // 2. 成品裁片 (Layer: 1_PIECES)
    pieces.forEach(p => {
        addRect("1_PIECES", p.x, p.y, p.x + p.w, p.y + p.l);
        addText("1_PIECES", p.x + 15, p.y + p.l / 2 - 10, 30, `${p.name || 'Piece'}`);
        addText("1_PIECES", p.x + 15, p.y + p.l / 2 + 30, 24, `${p.w}x${p.l}mm`);
    });

    // 3. 回收料头 (Layer: 2_REMNANTS)
    remnants.forEach(r => {
        addRect("2_REMNANTS", r.x, r.y, r.x + r.w, r.y + r.l);
        addText("2_REMNANTS", r.x + 15, r.y + 35, 26, `REMNANT: ${r.id}`);
        addText("2_REMNANTS", r.x + 15, r.y + 70, 20, `${r.w}x${r.l}mm`);
    });

    // 4. 瑕疵区与安全避让区 (Layer: 3_DEFECTS)
    defects.forEach(d => {
        addRect("3_DEFECTS", d.x, d.y, d.x + d.w, d.y + d.h);
        const m = d.margin !== undefined ? d.margin : 20;
        addRect("3_DEFECTS", d.x - m, d.y - m, d.x + d.w + m, d.y + d.h + m);
        addText("3_DEFECTS", d.x, Math.max(10, d.y - 10), 20, `DEFECT #${d.id} (${d.desc || 'Flaw'})`);
    });

    // 5. 下刀切线与空走虚线 (Layer: 4_CUT_LINES & 5_RAPID_TRAVERSE)
    let lastX = home.x;
    let lastY = home.y;
    cuts.forEach(c => {
        const isHoriz = (c.type === "横切");
        let startX = c.startX !== undefined ? c.startX : (isHoriz ? c.start : c.pos);
        let startY = c.startY !== undefined ? c.startY : (isHoriz ? c.pos : c.start);
        let endX = c.endX !== undefined ? c.endX : (isHoriz ? c.end : c.pos);
        let endY = c.endY !== undefined ? c.endY : (isHoriz ? c.pos : c.end);

        // 空刀移动
        addLine("5_RAPID_TRAVERSE", lastX, lastY, startX, startY);
        // 切割下刀
        addLine("4_CUT_LINES", startX, startY, endX, endY);
        addText("4_CUT_LINES", startX + 5, startY + 5, 20, `CUT #${c.step}`);

        lastX = endX;
        lastY = endY;
    });

    dxf.push("0\nENDSEC");
    dxf.push("0\nEOF");

    return dxf.join("\n");
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
    modal.style.display = "flex";
    switchExportTab(defaultTab);
}

export function closeExportModal() {
    const modal = document.getElementById("cam-export-modal");
    if (modal) modal.style.display = "none";
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
        if (lblStats) lblStats.innerText = `格式: Fanuc/ISO 工业标准 G-Code | 行数: ${gcodeText.split('\n').length} 行 | 大小: ${(gcodeText.length / 1024).toFixed(1)} KB`;
        if (btnDownload) {
            btnDownload.innerText = "下载标准 G-Code (.nc)";
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
    navigator.clipboard.writeText(preview.value).then(() => {
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
        document.execCommand('copy');
        alert("已复制到剪贴板！");
    });
}

function createExportModalDOM() {
    const div = document.createElement("div");
    div.id = "cam-export-modal";
    div.className = "settings-modal-overlay";
    div.style.display = "none";
    div.innerHTML = `
        <div class="settings-modal-dialog" style="width: 820px; max-width: 95vw; height: 600px; display: flex; flex-direction: column;">
            <div class="settings-modal-header">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: 700; font-size: 15px; color: var(--accent-blue);">数控机床代码与工业 CAD 图纸导出中心</span>
                    <span class="header-tag" style="color: #10b981;">ISO CNC / AutoCAD DXF</span>
                </div>
                <button onclick="window.cutApp.plugins.export.closeExportModal()" style="background: transparent; border: none; color: var(--text-muted); font-size: 18px; cursor: pointer; font-weight: bold;">关闭</button>
            </div>
            <div class="settings-nav-tabs" style="padding: 0 16px; margin-top: 8px;">
                <button class="settings-tab-btn active" id="tab-export-gcode" onclick="window.cutApp.plugins.export.switchExportTab('gcode')">标准数控 G-Code (.nc)</button>
                <button class="settings-tab-btn" id="tab-export-dxf" onclick="window.cutApp.plugins.export.switchExportTab('dxf')">AutoCAD 工业 DXF (.dxf)</button>
            </div>
            <div style="padding: 6px 16px; font-size: 11px; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center;">
                <span id="export-file-stats">正在准备数据...</span>
                <button id="btn-copy-export-code" class="tool-btn" style="padding: 2px 10px; font-size: 11px;" onclick="window.cutApp.plugins.export.copyExportPreview()">复制全部代码</button>
            </div>
            <div style="flex: 1; padding: 0 16px 10px; min-height: 0;">
                <textarea id="export-preview-content" readonly style="width: 100%; height: 100%; font-family: 'Consolas', 'Courier New', monospace; font-size: 11.5px; background: var(--bg-main); color: var(--text-main); border: 1px solid var(--panel-border); border-radius: 4px; padding: 10px; resize: none; outline: none; line-height: 1.45;"></textarea>
            </div>
            <div class="settings-footer">
                <span style="font-size: 11px; color: var(--text-muted);">工业适配：格柏(Gerber)、力克(Lectra)、爱科(IECHO)、拓卡奔马(Bullmer)等各品牌裁床与激光机。</span>
                <div style="display: flex; gap: 8px;">
                    <button class="tool-btn" onclick="window.cutApp.plugins.export.closeExportModal()">取消</button>
                    <button class="tool-btn active" id="btn-download-export-file" style="background: #0284c7; padding: 6px 16px; font-weight: 700;">下载物理文件</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

export {openCutTicketModal,closeCutTicketModal,printCutTicketDocument} from "./cut-ticket.js";
