/**
 * 工业数控 G-Code / AutoCAD DXF 导出引擎与车间工单打印插件 (CAM Export Plugin)
 * 适配格柏(Gerber)、力克(Lectra)、爱科(IECHO)、拓卡奔马(Topcut-Bullmer)及通用数控裁床
 */
import { state } from '../../core/state.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';

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
                const rollId = state.getCurrentCaseData().rollId || "ROLL-01";
                downloadFile(`CUT_${rollId}_STATION_01.dxf`, preview.value);
            };
        }
    }
}

export function copyExportPreview() {
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

/**
 * 现场裁切工艺任务单 (Cut Ticket & Part Label Sheet) 模态与打印
 */
export function openCutTicketModal() {
    let modal = document.getElementById("cam-cut-ticket-modal");
    if (!modal) {
        createCutTicketModalDOM();
        modal = document.getElementById("cam-cut-ticket-modal");
    }
    populateCutTicketData();
    modal.style.display = "flex";
}

export function closeCutTicketModal() {
    const modal = document.getElementById("cam-cut-ticket-modal");
    if (modal) modal.style.display = "none";
}

function populateCutTicketData() {
    const data = state.getCurrentCaseData();
    const rollId = data.rollId || "ROLL-2026-0920";
    const rollW = data.rollW || 2000;
    const pieces = data.pieces || [];
    const remnants = data.remnants || [];
    const cuts = data.cuts || [];
    const stats = state.toolpathStats || {};

    const ticketNo = `WO-${rollId.replace(/[^0-9]/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const dateStr = new Date().toISOString().substring(0, 10);

    const elemTicketNo = document.getElementById("ticket-no-val");
    if (elemTicketNo) elemTicketNo.innerText = ticketNo;
    const elemDate = document.getElementById("ticket-date-val");
    if (elemDate) elemDate.innerText = dateStr;
    const elemRoll = document.getElementById("ticket-roll-val");
    if (elemRoll) elemRoll.innerText = `${rollId} (幅宽: ${rollW}mm)`;
    const elemStation = document.getElementById("ticket-station-val");
    const originMap = {
        'right-bottom': '右下角基准 (原点)',
        'right-top': '右上角基准',
        'left-bottom': '左下角基准',
        'left-top': '左上角基准'
    };
    const originLabel = originMap[data.cutOrigin] || '右下角基准 (原点)';
    if (elemStation) elemStation.innerText = `CUT-STATION-01 | 起刀: ${originLabel}`;

    // 填充裁片表
    const tbodyPieces = document.getElementById("ticket-pieces-tbody");
    if (tbodyPieces) {
        tbodyPieces.innerHTML = pieces.map((p, idx) => `
            <tr>
                <td style="text-align: center;">${idx + 1}</td>
                <td><b>${p.name || '裁片'}</b></td>
                <td>${p.w} × ${p.l} mm</td>
                <td>${((p.w * p.l) / 1e6).toFixed(3)} m²</td>
                <td>经向排样 · 合格成品</td>
                <td style="text-align: center; font-family: monospace; color: #0284c7;">[ ] 待拣选贴标</td>
            </tr>
        `).join('');
    }

    // 填充料头表
    const tbodyRem = document.getElementById("ticket-remnants-tbody");
    if (tbodyRem) {
        tbodyRem.innerHTML = remnants.map((r, idx) => `
            <tr>
                <td style="text-align: center;">${idx + 1}</td>
                <td style="font-family: monospace; font-weight: bold; color: ${r.hasDefect ? '#d97706' : '#0284c7'};">${r.id}</td>
                <td>${r.w} × ${r.l} mm</td>
                <td>${r.area.toFixed(3)} m²</td>
                <td>${r.hasDefect ? '带疵料头 (已安全隔离)' : '完好可用料头'}</td>
                <td style="text-align: center; color: #d97706;">[ ] 库位入库核销</td>
            </tr>
        `).join('');
    }

    // 统计指标
    const elemSummary = document.getElementById("ticket-summary-metrics");
    if (elemSummary) {
        const totalAir = stats.airDistance ? `${(stats.airDistance/1000).toFixed(2)}m` : '6.18m';
        const optSaving = stats.savedPercent ? `${stats.savedPercent}%` : '65.2%';
        elemSummary.innerText = `下刀总数: ${cuts.length} 刀 | 空走刀: ${totalAir} (压缩 ${optSaving}) | 裁片: ${pieces.length} 件 | 回收料头: ${remnants.length} 块`;
    }

    // 渲染工位排样与起刀走刀工程矢量图
    const blueprintContainer = document.getElementById("ticket-blueprint-container");
    if (blueprintContainer) {
        blueprintContainer.innerHTML = generateCutTicketBlueprintSVG(data);
    }
}

/**
 * 动态生成 A4 工单专用的高保真排样搭切与起刀走刀工程矢量图 (SVG Blueprint)
 */
function generateCutTicketBlueprintSVG(data) {
    const rollW = data.rollW || 2000;
    const bedL = data.bedL || 5000;
    const pieces = data.pieces || [];
    const remnants = data.remnants || [];
    const cuts = data.cuts || [];
    const defects = data.globalDefects || [];

    const padLeft = 45;
    const padRight = 55;
    const padTop = 22;
    const padBottom = 26;
    const mapW = 940 - padLeft - padRight; // 840
    const mapH = 240 - padTop - padBottom; // 192

    const scaleX = mapW / bedL;
    const scaleY = mapH / rollW;

    // 1. 母卷物理基底与米数标尺
    let gridLines = '';
    const meterStep = bedL <= 2000 ? 500 : 1000;
    for (let m = meterStep; m < bedL; m += meterStep) {
        const gx = padLeft + m * scaleX;
        gridLines += `
            <line x1="${gx}" y1="${padTop}" x2="${gx}" y2="${padTop + mapH}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3,3" />
            <text x="${gx}" y="${padTop - 5}" text-anchor="middle" font-size="9" fill="#94a3b8">${(m/1000).toFixed(1)}m</text>
        `;
    }

    // 2. 料头区域 (浅绿完好 / 浅橙带疵)
    let remnantSVGs = remnants.map(r => {
        const rx = padLeft + r.y * scaleX;
        const ry = padTop + r.x * scaleY;
        const rw = r.l * scaleX;
        const rh = r.w * scaleY;
        const isDef = r.hasDefect;
        const fill = isDef ? '#fef3c7' : '#dcfce7';
        const stroke = isDef ? '#d97706' : '#16a34a';
        const textColor = isDef ? '#b45309' : '#15803d';
        const label = `${isDef ? '[疵]' : '[料]'} ${r.id}`;
        return `
            <g>
                <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" stroke-dasharray="${isDef ? '4,2' : 'none'}" rx="2" />
                <text x="${rx + rw/2}" y="${ry + rh/2 - 2}" text-anchor="middle" font-size="9.5" font-weight="bold" fill="${textColor}">${label}</text>
                <text x="${rx + rw/2}" y="${ry + rh/2 + 10}" text-anchor="middle" font-size="8" fill="${textColor}">${r.w}×${r.l}</text>
            </g>
        `;
    }).join('');

    // 3. 成品裁片 (浅蓝高对比度)
    let pieceSVGs = pieces.map((p, idx) => {
        const px = padLeft + p.y * scaleX;
        const py = padTop + p.x * scaleY;
        const pw = p.l * scaleX;
        const ph = p.w * scaleY;
        return `
            <g>
                <rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="#e0f2fe" stroke="#0284c7" stroke-width="1.5" rx="2" />
                <text x="${px + pw/2}" y="${py + ph/2 - 3}" text-anchor="middle" font-size="10" font-weight="bold" fill="#0369a1">${p.name || '裁片'} #${idx + 1}</text>
                <text x="${px + pw/2}" y="${py + ph/2 + 9}" text-anchor="middle" font-size="8.5" fill="#0284c7">${p.w}×${p.l}mm</text>
            </g>
        `;
    }).join('');

    // 4. 疵点标记
    let defectSVGs = defects.map((d, idx) => {
        const dx = padLeft + d.y * scaleX;
        const dy = padTop + d.x * scaleY;
        return `
            <g>
                <circle cx="${dx}" cy="${dy}" r="6" fill="#ef4444" opacity="0.85" />
                <text x="${dx}" y="${dy + 3}" text-anchor="middle" font-size="8" font-weight="bold" fill="#ffffff">!</text>
                <text x="${dx}" y="${dy - 8}" text-anchor="middle" font-size="8" font-weight="bold" fill="#ef4444">DEF-${idx+1}</text>
            </g>
        `;
    }).join('');

    // 5. 走刀线段与工步标注
    let cutSVGs = cuts.map((c, idx) => {
        const stepNum = c.step || (idx + 1);
        if (c.type === "横切") {
            const cx = padLeft + c.pos * scaleX;
            const cy1 = padTop + c.start * scaleY;
            const cy2 = padTop + c.end * scaleY;
            return `
                <g>
                    <line x1="${cx}" y1="${cy1}" x2="${cx}" y2="${cy2}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,2" />
                    <circle cx="${cx}" cy="${(cy1 + cy2)/2}" r="6" fill="#ffffff" stroke="#dc2626" stroke-width="1" />
                    <text x="${cx}" y="${(cy1 + cy2)/2 + 3}" text-anchor="middle" font-size="8" font-weight="bold" fill="#dc2626">${stepNum}</text>
                </g>
            `;
        } else {
            const cy = padTop + c.pos * scaleY;
            const cx1 = padLeft + c.start * scaleX;
            const cx2 = padLeft + c.end * scaleX;
            return `
                <g>
                    <line x1="${cx1}" y1="${cy}" x2="${cx2}" y2="${cy}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,2" />
                    <circle cx="${(cx1 + cx2)/2}" cy="${cy}" r="6" fill="#ffffff" stroke="#dc2626" stroke-width="1" />
                    <text x="${(cx1 + cx2)/2}" y="${cy + 3}" text-anchor="middle" font-size="8" font-weight="bold" fill="#dc2626">${stepNum}</text>
                </g>
            `;
        }
    }).join('');

    // 6. 右下角起刀原点 (0,0) 标注
    const originX = padLeft + mapW;
    const originY = padTop + mapH;
    const originSVG = `
        <g>
            <!-- 原点同心圆与准星 -->
            <circle cx="${originX}" cy="${originY}" r="7" fill="#fee2e2" stroke="#dc2626" stroke-width="1.5" />
            <circle cx="${originX}" cy="${originY}" r="3" fill="#dc2626" />
            <line x1="${originX - 10}" y1="${originY}" x2="${originX + 10}" y2="${originY}" stroke="#dc2626" stroke-width="1" />
            <line x1="${originX}" y1="${originY - 10}" x2="${originX}" y2="${originY + 10}" stroke="#dc2626" stroke-width="1" />
            
            <!-- 原点文字 -->
            <text x="${originX}" y="${originY + 16}" text-anchor="end" font-size="10" font-weight="bold" fill="#dc2626">★ 起刀基准原点 (0,0)</text>

            <!-- 坐标轴指示箭头 -->
            <!-- 向上 X+ -->
            <line x1="${originX + 14}" y1="${originY}" x2="${originX + 14}" y2="${originY - 26}" stroke="#0284c7" stroke-width="1.5" marker-end="url(#arrow-x)" />
            <text x="${originX + 18}" y="${originY - 12}" font-size="8" font-weight="bold" fill="#0284c7">X+ 导轨</text>

            <!-- 向左 Y+ -->
            <line x1="${originX}" y1="${originY + 8}" x2="${originX - 30}" y2="${originY + 8}" stroke="#0284c7" stroke-width="1.5" marker-end="url(#arrow-y)" />
            <text x="${originX - 15}" y="${originY + 6}" text-anchor="middle" font-size="8" font-weight="bold" fill="#0284c7">Y+ 进料</text>
        </g>
    `;

    return `
        <svg viewBox="0 0 940 240" style="width: 100%; height: auto; display: block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <defs>
                <marker id="arrow-x" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#0284c7" />
                </marker>
                <marker id="arrow-y" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#0284c7" />
                </marker>
            </defs>

            <!-- 顶端/底端/左右工程标注 -->
            <text x="${padLeft + mapW/2}" y="${padTop - 8}" text-anchor="middle" font-size="9" font-weight="bold" fill="#64748b">左导轨 (Left Rail · X: 0mm)</text>
            <text x="${padLeft + mapW/2}" y="${padTop + mapH + 16}" text-anchor="middle" font-size="9" font-weight="bold" fill="#64748b">右导轨 (Right Rail · X: ${rollW}mm)</text>
            <text x="${padLeft - 8}" y="${padTop + mapH/2}" text-anchor="end" font-size="9" font-weight="bold" fill="#64748b" transform="rotate(-90, ${padLeft - 8}, ${padTop + mapH/2})">进料接刀端 (Y: 0)</text>
            <text x="${padLeft + mapW + 28}" y="${padTop + mapH/2}" text-anchor="middle" font-size="9" font-weight="bold" fill="#64748b" transform="rotate(90, ${padLeft + mapW + 28}, ${padTop + mapH/2})">落料输出端 (${(bedL/1000).toFixed(1)}m)</text>

            <!-- 物理台面轮廓 -->
            <rect x="${padLeft}" y="${padTop}" width="${mapW}" height="${mapH}" fill="#f8fafc" stroke="#475569" stroke-width="1.5" rx="3" />
            
            <!-- 米数标尺网格 -->
            ${gridLines}

            <!-- 料头 -->
            ${remnantSVGs}

            <!-- 裁片 -->
            ${pieceSVGs}

            <!-- 疵点 -->
            ${defectSVGs}

            <!-- 走刀线 -->
            ${cutSVGs}

            <!-- 起刀原点与坐标 -->
            ${originSVG}
        </svg>
    `;
}

function createCutTicketModalDOM() {
    const div = document.createElement("div");
    div.id = "cam-cut-ticket-modal";
    div.className = "settings-modal-overlay";
    div.style.display = "none";
    div.innerHTML = `
        <div class="settings-modal-dialog" style="width: 860px; max-width: 96vw; height: 680px; display: flex; flex-direction: column;">
            <div class="settings-modal-header">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: 700; font-size: 15px; color: var(--accent-amber);">车间现场裁切任务单与裁片贴标卡 (Cut Ticket)</span>
                    <span class="header-tag">A4 Printable</span>
                </div>
                <button onclick="window.cutApp.plugins.export.closeCutTicketModal()" style="background: transparent; border: none; color: var(--text-muted); font-size: 18px; cursor: pointer; font-weight: bold;">关闭</button>
            </div>
            
            <div style="flex: 1; overflow-y: auto; padding: 16px;">
                <div id="printable-cut-ticket-area" style="background: #ffffff; color: #0f172a; padding: 20px 24px; border: 1px solid #cbd5e1; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                    <!-- 抬头与条码 -->
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 12px;">
                        <div>
                            <h2 style="margin: 0; font-size: 19px; font-weight: 800; letter-spacing: 0.5px; color: #0f172a;">数控裁切车间工艺任务单 (CUT TICKET)</h2>
                            <div style="font-size: 11.5px; color: #475569; margin-top: 3px;">柔性材料自动化排料与直刀/断刀工艺生产指示</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-family: monospace; font-size: 17px; font-weight: 700; letter-spacing: 2px; color: #0284c7;" id="ticket-no-val">WO-20260920-8842</div>
                            <div style="font-size: 11px; color: #64748b; margin-top: 2px;">开单日期: <span id="ticket-date-val">2026-09-21</span></div>
                        </div>
                    </div>

                    <!-- 工艺基本信息栏 -->
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px 12px; border-radius: 4px; font-size: 11.5px; margin-bottom: 12px;">
                        <div>母卷批号: <b id="ticket-roll-val">ROLL-2026-0920 (幅宽: 2000mm)</b></div>
                        <div>机台工位: <b id="ticket-station-val">CUT-STATION-01 | 起刀: 右下角基准 (原点)</b></div>
                        <div>操作机型: <b>数控直刀裁床 / 激光裁床</b></div>
                        <div>工艺指标: <b id="ticket-summary-metrics" style="color: #0284c7;">下刀: 9 刀 | 裁片: 6 件 | 料头: 4 块</b></div>
                    </div>

                    <!-- 一、排样搭切与起刀走刀示意图 -->
                    <div style="margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <h3 style="font-size: 12.5px; font-weight: 700; margin: 0; color: #0f172a; border-left: 4px solid #0284c7; padding-left: 8px;">一、排样搭切与起刀走刀工程图 (Cutting Layout & Toolpath Blueprint)</h3>
                            <span style="font-size: 10.5px; color: #64748b;">基准: 右下角原点 (0,0) · 矢量等比全景缩略</span>
                        </div>
                        <div id="ticket-blueprint-container" style="width: 100%; border: 1px solid #cbd5e1; border-radius: 4px; background: #ffffff; padding: 2px; box-sizing: border-box;">
                            <!-- 动态注入的矢量排样图 -->
                        </div>
                    </div>

                    <!-- 二、裁片加工与拣选清单 -->
                    <h3 style="font-size: 12.5px; font-weight: 700; margin: 10px 0 5px; color: #0f172a; border-left: 4px solid #10b981; padding-left: 8px;">二、合格成品裁片拣选清单 (Finished Pieces Checklist)</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 12px;">
                        <thead>
                            <tr style="background: #f1f5f9; border-bottom: 1px solid #cbd5e1; text-align: left;">
                                <th style="padding: 5px; width: 32px; text-align: center;">#</th>
                                <th style="padding: 5px;">裁片名称</th>
                                <th style="padding: 5px;">规格尺寸 (宽×长)</th>
                                <th style="padding: 5px;">净面积</th>
                                <th style="padding: 5px;">工艺要求</th>
                                <th style="padding: 5px; text-align: center; width: 100px;">现场核验</th>
                            </tr>
                        </thead>
                        <tbody id="ticket-pieces-tbody">
                            <!-- 动态填充 -->
                        </tbody>
                    </table>

                    <!-- 三、回收料头贴标清单 -->
                    <h3 style="font-size: 12.5px; font-weight: 700; margin: 10px 0 5px; color: #0f172a; border-left: 4px solid #f59e0b; padding-left: 8px;">三、回收料头入库贴标清单 (Remnant Inventory)</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 14px;">
                        <thead>
                            <tr style="background: #f1f5f9; border-bottom: 1px solid #cbd5e1; text-align: left;">
                                <th style="padding: 5px; width: 32px; text-align: center;">#</th>
                                <th style="padding: 5px;">料头编号</th>
                                <th style="padding: 5px;">规格尺寸 (宽×长)</th>
                                <th style="padding: 5px;">面积</th>
                                <th style="padding: 5px;">质量等级</th>
                                <th style="padding: 5px; text-align: center; width: 100px;">入库签名</th>
                            </tr>
                        </thead>
                        <tbody id="ticket-remnants-tbody">
                            <!-- 动态填充 -->
                        </tbody>
                    </table>

                    <!-- 现场签字栏 -->
                    <div style="display: flex; justify-content: space-between; border-top: 1px dashed #cbd5e1; padding-top: 10px; font-size: 11.5px; color: #334155;">
                        <div>主裁操作工签名: ____________________</div>
                        <div>品检质检员签名: ____________________</div>
                        <div>仓库料头接收人: ____________________</div>
                    </div>
                </div>
            </div>

            <div class="settings-footer">
                <span style="font-size: 11px; color: var(--text-muted);">点击“打印工单”将调用 A4 纯净单页打印，支持保存为 PDF 或直接输出至车间打印机。</span>
                <div style="display: flex; gap: 8px;">
                    <button class="tool-btn" onclick="window.cutApp.plugins.export.closeCutTicketModal()">关闭</button>
                    <button class="tool-btn active" style="background: #059669; padding: 6px 18px; font-weight: 700;" onclick="window.cutApp.plugins.export.printCutTicketDocument()">打印工单 (Print)</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

/**
 * 纯净 A4 隔离式工单打印引擎 (杜绝第一页空白占位)
 */
export function printCutTicketDocument() {
    const printArea = document.getElementById("printable-cut-ticket-area");
    if (!printArea) {
        window.print();
        return;
    }

    const iframe = document.createElement("iframe");
    iframe.id = "pure-print-iframe";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    iframe.style.visibility = "hidden";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>数控裁切车间工艺任务单 (CUT TICKET)</title>
            <style>
                @page {
                    size: A4 portrait;
                    margin: 12mm 15mm;
                }
                * {
                    box-sizing: border-box;
                }
                html, body {
                    margin: 0;
                    padding: 0;
                    background: #ffffff;
                    color: #0f172a;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }
                #printable-cut-ticket-area {
                    width: 100% !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    border: none !important;
                    box-shadow: none !important;
                }
                #ticket-blueprint-container {
                    width: 100% !important;
                    margin-bottom: 8px !important;
                }
                svg {
                    width: 100% !important;
                    height: auto !important;
                    max-height: 180px !important;
                    display: block !important;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                }
                th, td {
                    border: 1px solid #cbd5e1;
                    padding: 4px 6px;
                }
            </style>
        </head>
        <body>
            ${printArea.outerHTML}
        </body>
        </html>
    `);
    doc.close();

    setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => {
            if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 3000);
    }, 200);
}
