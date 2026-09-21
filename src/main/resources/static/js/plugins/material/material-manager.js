/**
 * 母卷与料头物料档案全生命周期管理插件 (Material & Remnant Manager Plugin)
 * 涵盖：母卷物理工艺属性、纺织4分制标准疵点空间模型、料头代际血统追溯与报废管理
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { onMotherRollChange, refreshShelfRemnantsList } from '../remnant/remnant-shelf.js';
import { renderScene } from '../cad/cad-renderer.js';
import { renderRadar } from '../radar/radar-scrubber.js';

let cachedRolls = [];
let activeRollId = "ROLL-2026-0920";

/**
 * 打开母卷与料头物料档案中心
 */
export async function openMaterialModal(tab = 'rolls') {
    let modal = document.getElementById("material-manager-modal");
    if (!modal) {
        createMaterialModalDOM();
        modal = document.getElementById("material-manager-modal");
    }
    modal.style.display = "flex";
    await refreshRollsList();
    switchMaterialTab(tab);
}

export function closeMaterialModal() {
    const modal = document.getElementById("material-manager-modal");
    if (modal) modal.style.display = "none";
}

export function switchMaterialTab(tabName) {
    const btnRolls = document.getElementById("tab-mat-rolls");
    const btnRemnants = document.getElementById("tab-mat-remnants");
    const btnDictionary = document.getElementById("tab-mat-dict");

    const paneRolls = document.getElementById("pane-mat-rolls");
    const paneRemnants = document.getElementById("pane-mat-remnants");
    const paneDict = document.getElementById("pane-mat-dict");

    if (btnRolls) btnRolls.classList.toggle("active", tabName === 'rolls');
    if (btnRemnants) btnRemnants.classList.toggle("active", tabName === 'remnants');
    if (btnDictionary) btnDictionary.classList.toggle("active", tabName === 'dict');

    if (paneRolls) paneRolls.style.display = (tabName === 'rolls') ? "flex" : "none";
    if (paneRemnants) paneRemnants.style.display = (tabName === 'remnants') ? "flex" : "none";
    if (paneDict) paneDict.style.display = (tabName === 'dict') ? "flex" : "none";

    if (tabName === 'rolls') {
        renderRollsList();
    } else if (tabName === 'remnants') {
        renderRemnantsLineage();
    }
}

/**
 * 从后端刷新母卷列表
 */
export async function refreshRollsList() {
    try {
        const res = await fetch("/api/rolls");
        if (res.ok) {
            cachedRolls = await res.json();
        }
    } catch (e) {
        console.warn("读取母卷失败，使用本地状态", e);
    }
}

/**
 * 渲染 Tab 1: 母卷档案与全景疵点
 */
function renderRollsList() {
    const container = document.getElementById("material-rolls-container");
    if (!container) return;

    if (!cachedRolls || cachedRolls.length === 0) {
        container.innerHTML = `<div style="padding: 20px; color: var(--text-muted); text-align: center;">暂无母卷档案</div>`;
        return;
    }

    container.innerHTML = cachedRolls.map(r => {
        const remLen = r.currentRemainingLength || r.totalLength;
        const usedLen = r.usedLength || (r.totalLength - remLen);
        const percent = Math.round((remLen / r.totalLength) * 100);
        const isCurrent = (r.rollId === (state.getCurrentCaseData().rollId || activeRollId));

        return `
            <div class="roll-archive-card ${isCurrent ? 'active-roll' : ''}" onclick="window.cutApp.plugins.material.selectRollForDetail('${r.rollId}')" style="background: var(--panel-bg); border: 1px solid ${isCurrent ? '#0284c7' : 'var(--panel-border)'}; border-radius: 6px; padding: 12px; margin-bottom: 10px; cursor: pointer; transition: all 0.2s;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-family: monospace; font-size: 13.5px; font-weight: 700; color: ${isCurrent ? '#0284c7' : 'var(--text-main)'};">${r.rollId}</span>
                        <span class="header-tag" style="font-size: 10px; color: ${r.inspectionStatus === 'PASSED' ? '#10b981' : '#f59e0b'}; border-color: currentColor;">
                            ${r.inspectionStatus === 'PASSED' ? '验布合格' : (r.inspectionStatus === 'QUARANTINED' ? '隔离' : '待验')}
                        </span>
                        ${isCurrent ? '<span style="font-size: 10px; padding: 1px 6px; background: #0284c7; color: #fff; border-radius: 3px; font-weight: bold;">当前生产卷</span>' : ''}
                    </div>
                    <div style="font-size: 11.5px; color: var(--text-muted);">
                        批次: <b>${r.batchNo || 'BAT-2026'}</b> | 库位: <span>${r.storageLocation || '立库 A-01'}</span>
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; font-size: 11px; margin-top: 8px; color: var(--text-muted);">
                    <div>材质品名: <b style="color: var(--text-main);">${r.materialName || r.rollModel}</b></div>
                    <div>幅宽净门幅: <b style="color: var(--text-main);">${r.width} mm</b> (毛边${r.rawWidth || (r.width+50)}mm)</div>
                    <div>面料克重: <span>${r.grammage || 240} g/m²</span></div>
                    <div>经向缩水率: <span>${r.shrinkageRate || 1.5}%</span></div>
                </div>

                <!-- 剩余米数动态进度条 -->
                <div style="margin-top: 10px;">
                    <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px;">
                        <span>剩余有效长度: <b style="color: #10b981;">${(remLen/1000).toFixed(1)}m</b> / ${(r.totalLength/1000).toFixed(1)}m (已开卷切下 ${(usedLen/1000).toFixed(1)}m)</span>
                        <span style="font-weight: bold; color: ${percent > 30 ? '#10b981' : '#f59e0b'};">${percent}% 结存</span>
                    </div>
                    <div style="height: 6px; width: 100%; background: var(--panel-border); border-radius: 3px; overflow: hidden;">
                        <div style="height: 100%; width: ${percent}%; background: ${percent > 30 ? '#10b981' : '#f59e0b'}; transition: width 0.3s;"></div>
                    </div>
                </div>

                <!-- 疵点与料头统计胶囊 -->
                <div style="display: flex; gap: 12px; margin-top: 8px; font-size: 11px; border-top: 1px dashed var(--panel-border); padding-top: 6px;">
                    <span>所含标准疵点: <b style="color: #ef4444;">${r.defectsCount || (r.defects ? r.defects.length : 0)} 处</b> (已标定避让)</span>
                    <span>切下在库料头: <b style="color: #0284c7;">${r.remnantCount || 0} 块</b> (${(r.remnantTotalArea || 0).toFixed(2)} m²)</span>
                    <span style="margin-left: auto; color: #0284c7; font-weight: bold;">点击查看详情 & 疵点图谱 &gt;&gt;</span>
                </div>
            </div>
        `;
    }).join('');

    // 默认展示首个母卷详情
    if (cachedRolls.length > 0) {
        selectRollForDetail(activeRollId || cachedRolls[0].rollId);
    }
}

/**
 * 选中某母卷，在右侧/底部面板展示其详细档案、疵点清单与录入表单
 */
export async function selectRollForDetail(rollId) {
    activeRollId = rollId;
    const detailBox = document.getElementById("material-roll-detail-panel");
    if (!detailBox) return;

    let roll = cachedRolls.find(r => r.rollId === rollId);
    try {
        const res = await fetch("/api/rolls/" + rollId);
        if (res.ok) {
            roll = await res.json();
        }
    } catch (e) {
        console.warn("获取母卷详情异常", e);
    }

    if (!roll) return;

    const defects = roll.defects || [];

    detailBox.innerHTML = `
        <div style="background: var(--card-blue-bg); border: 1px solid var(--accent-blue); border-radius: 6px; padding: 12px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h3 style="margin: 0; font-size: 15px; font-weight: 700; color: var(--accent-blue);">母卷档案: ${roll.rollId} (${roll.materialName || roll.rollModel})</h3>
                    <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
                        面料成分: ${roll.composition || '65%涤/35%棉'} | 供应商: ${roll.supplier || '华联纺织'} | 验布员: ${roll.inspector || 'AI视觉验布机'}
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="tool-btn active" style="background: #10b981; font-weight: bold; padding: 4px 12px;" onclick="window.cutApp.plugins.material.mountRollToStation('${roll.rollId}')">
                        装载本卷至 CAM 台面排产
                    </button>
                </div>
            </div>
        </div>

        <!-- 疵点清单与空间标定表 -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="font-weight: 700; font-size: 12.5px; color: var(--text-main);">
                本卷标定疵点清单 (共 ${defects.length} 处，纺织 4 分制标准)
            </div>
            <button class="tool-btn" style="font-size: 10.5px; padding: 2px 8px; background: rgba(239, 68, 68, 0.1); color: #dc2626; border-color: rgba(239, 68, 68, 0.3);" onclick="window.cutApp.plugins.material.toggleAddDefectForm()">
                + 标定新疵点
            </button>
        </div>

        <!-- 新增疵点表单 (默认收起) -->
        <div id="add-defect-form-box" style="display: none; background: var(--bg-main); border: 1px solid var(--panel-border); border-radius: 6px; padding: 10px; margin-bottom: 10px;">
            <div style="font-size: 11.5px; font-weight: bold; margin-bottom: 6px; color: var(--accent-blue);">录入/标定新疵点参数 (毫米世界坐标)</div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; font-size: 11px;">
                <div>
                    <span>经向纵深 Y (mm):</span>
                    <input type="number" id="inp-new-defect-y" class="prop-input" value="4500" step="100" style="width: 100%;">
                </div>
                <div>
                    <span>横向 X (mm):</span>
                    <input type="number" id="inp-new-defect-x" class="prop-input" value="600" step="50" style="width: 100%;">
                </div>
                <div>
                    <span>缺陷宽 W (mm):</span>
                    <input type="number" id="inp-new-defect-w" class="prop-input" value="200" step="20" style="width: 100%;">
                </div>
                <div>
                    <span>缺陷长 H (mm):</span>
                    <input type="number" id="inp-new-defect-h" class="prop-input" value="150" step="20" style="width: 100%;">
                </div>
                <div>
                    <span>工业分类类型:</span>
                    <select id="sel-new-defect-type" class="prop-input" style="width: 100%;">
                        <option value="HOLE">破洞 (HOLE - 扣4分)</option>
                        <option value="WEFT_DEFECT">抽纱/跳纱 (WEFT - 扣3分)</option>
                        <option value="STAIN" selected>油污/黄斑 (STAIN - 扣2分)</option>
                        <option value="SLUB">粗节/结头 (SLUB - 扣1分)</option>
                    </select>
                </div>
                <div>
                    <span>安全避让间距 (Margin):</span>
                    <input type="number" id="inp-new-defect-m" class="prop-input" value="20" step="5" style="width: 100%;">
                </div>
                <div>
                    <span>检出来源方式:</span>
                    <select id="sel-new-defect-src" class="prop-input" style="width: 100%;">
                        <option value="AI_VISION_SCANNER">AI 视觉验布机扫描</option>
                        <option value="MANUAL_INSPECT">现场人工打码标定</option>
                    </select>
                </div>
                <div style="display: flex; align-items: flex-end;">
                    <button class="tool-btn active" style="width: 100%; height: 26px; background: #0284c7; font-size: 11px;" onclick="window.cutApp.plugins.material.submitNewDefect('${roll.rollId}')">
                        保存并写入母卷
                    </button>
                </div>
            </div>
        </div>

        <div style="max-height: 260px; overflow-y: auto; border: 1px solid var(--panel-border); border-radius: 4px;">
            <table class="cam-table">
                <thead>
                    <tr>
                        <th width="40">序号</th>
                        <th width="80">工业类型</th>
                        <th>空间定位 (X, Y 毫米)</th>
                        <th>缺陷尺寸 (宽×长)</th>
                        <th>4分制扣分</th>
                        <th>安全避让区</th>
                        <th>检出来源与处理策略</th>
                    </tr>
                </thead>
                <tbody>
                    ${defects.map(d => `
                        <tr>
                            <td style="text-align: center; font-family: monospace;">#${d.id}</td>
                            <td>
                                <span style="font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: bold; background: ${getDefectColor(d.defectType)}; color: #fff;">
                                    ${d.typeName || d.defectType}
                                </span>
                            </td>
                            <td style="font-family: monospace;">X: ${d.x}mm | Y: ${d.y}mm (${(d.y/1000).toFixed(2)}m)</td>
                            <td style="font-family: monospace;">${d.w} × ${d.h} mm</td>
                            <td style="text-align: center; font-weight: bold; color: ${d.points >= 3 ? '#dc2626' : '#d97706'};">扣 ${d.points || 2} 分</td>
                            <td>外扩 +${d.margin || 20}mm (${(d.w + (d.margin||20)*2)}×${(d.h + (d.margin||20)*2)}mm)</td>
                            <td style="font-size: 10.5px; color: var(--text-muted);">
                                ${d.detectionSource === 'AI_VISION_SCANNER' ? '视觉验布' : '人工标定'} · 
                                <b style="color: ${d.avoidanceStrategy === 'MUST_AVOID' ? '#dc2626' : '#0284c7'};">
                                    ${d.avoidanceStrategy === 'MUST_AVOID' ? '强制切出料头隔离' : '允许落入余料'}
                                </b>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function getDefectColor(type) {
    switch (type) {
        case 'HOLE': return '#dc2626';
        case 'WEFT_DEFECT': return '#d97706';
        case 'STAIN': return '#7c3aed';
        case 'SLUB': return '#059669';
        default: return '#ef4444';
    }
}

export function toggleAddDefectForm() {
    const box = document.getElementById("add-defect-form-box");
    if (box) {
        box.style.display = (box.style.display === "none") ? "block" : "none";
    }
}

/**
 * 提交新增疵点并更新母卷
 */
export async function submitNewDefect(rollId) {
    const y = parseFloat(document.getElementById("inp-new-defect-y").value) || 0;
    const x = parseFloat(document.getElementById("inp-new-defect-x").value) || 0;
    const w = parseFloat(document.getElementById("inp-new-defect-w").value) || 100;
    const h = parseFloat(document.getElementById("inp-new-defect-h").value) || 100;
    const margin = parseFloat(document.getElementById("inp-new-defect-m").value) || 20;
    const type = document.getElementById("sel-new-defect-type").value;
    const src = document.getElementById("sel-new-defect-src").value;

    const typeNames = {
        HOLE: "经向破洞",
        WEFT_DEFECT: "断纬跳纱",
        STAIN: "油污渍斑",
        SLUB: "粗节结头"
    };

    const newDef = {
        id: 0,
        x: x, y: y, w: w, h: h, margin: margin,
        defectType: type,
        typeName: typeNames[type] || type,
        severity: type === 'HOLE' ? 4 : (type === 'WEFT_DEFECT' ? 3 : 2),
        points: type === 'HOLE' ? 4 : (type === 'WEFT_DEFECT' ? 3 : 2),
        detectionSource: src,
        avoidanceStrategy: "MUST_AVOID",
        description: "现场追加标定疵点"
    };

    try {
        const res = await fetch(`/api/rolls/${rollId}/defects`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newDef)
        });
        if (res.ok) {
            await refreshRollsList();
            selectRollForDetail(rollId);
            // 如果正是当前主 CAM 台面生产的母卷，同步至主画布
            const curData = state.getCurrentCaseData();
            if (curData.rollId === rollId) {
                curData.globalDefects = curData.globalDefects || [];
                curData.globalDefects.push(newDef);
                renderScene();
                renderRadar();
            }
            alert("疵点标定成功并已持久化至母卷档案！");
        }
    } catch (e) {
        alert("提交疵点失败，请检查服务状态");
    }
}

/**
 * 将指定母卷装载至主 CAM 切割台面
 */
export async function mountRollToStation(rollId) {
    const sel = document.getElementById("sel-mother-roll-id");
    if (sel) {
        sel.value = rollId;
        await onMotherRollChange();
        closeMaterialModal();
        alert(`已成功装载母卷 [${rollId}] 至主 CAM 裁切工位！`);
    }
}

/**
 * 渲染 Tab 2: 料头货架与代际血统追溯
 */
async function renderRemnantsLineage() {
    const container = document.getElementById("material-remnants-container");
    if (!container) return;

    let remnants = [];
    try {
        const res = await fetch("/api/remnants");
        if (res.ok) remnants = await res.json();
    } catch (e) {
        console.warn("加载料头失败", e);
    }

    if (!remnants || remnants.length === 0) {
        container.innerHTML = `<div style="padding: 20px; color: var(--text-muted); text-align: center;">暂无在库料头</div>`;
        return;
    }

    container.innerHTML = `
        <table class="cam-table">
            <thead>
                <tr>
                    <th width="120">料头编号/条码</th>
                    <th width="80">血统代数</th>
                    <th width="120">来源母卷</th>
                    <th>规格尺寸 (宽×长)</th>
                    <th>有效面积</th>
                    <th>质量评级</th>
                    <th>存放库位</th>
                    <th>疵点隔离情况</th>
                    <th width="80">处置操作</th>
                </tr>
            </thead>
            <tbody>
                ${remnants.map(r => `
                    <tr>
                        <td style="font-family: monospace; font-weight: bold; color: ${r.hasDefect ? '#d97706' : '#0284c7'};">
                            ${r.id}
                        </td>
                        <td>
                            <span style="font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: bold; background: ${r.generation === 1 ? '#0284c7' : '#7c3aed'}; color: #fff;">
                                ${r.generation === 1 ? '一代母卷直切' : '二代套裁派生'}
                            </span>
                        </td>
                        <td style="font-family: monospace;">${r.sourceRollId || '-'}</td>
                        <td style="font-family: monospace; font-weight: bold;">${r.width} × ${r.length} mm</td>
                        <td style="font-family: monospace;">${r.area.toFixed(2)} m²</td>
                        <td>
                            <span style="font-size: 10px; padding: 1px 5px; border-radius: 2px; font-weight: bold; ${r.qualityGrade === 'GRADE_A' ? 'background: rgba(16, 185, 129, 0.15); color: #059669;' : 'background: rgba(245, 158, 11, 0.15); color: #d97706;'}">
                                ${r.qualityGrade === 'GRADE_A' ? '优质完好' : (r.qualityGrade === 'GRADE_DEFECT' ? '局部带疵' : '边角料')}
                            </span>
                        </td>
                        <td style="color: var(--accent-amber); font-weight: 500;">${r.location || '临时堆放区'}</td>
                        <td style="font-size: 11px; color: ${r.hasDefect ? '#dc2626' : '#10b981'};">
                            ${r.hasDefect ? `含 ${r.defects ? r.defects.length : 1} 处疵点 (已安全避让)` : '无疵点完好短料'}
                        </td>
                        <td>
                            <button class="tool-btn" style="font-size: 10px; padding: 2px 6px; background: rgba(239, 68, 68, 0.1); color: #dc2626; border-color: rgba(239, 68, 68, 0.3);" onclick="window.cutApp.plugins.material.scrapRemnantById('${r.id}')">
                                报废核销
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

export async function scrapRemnantById(id) {
    if (!confirm(`确定对料头 [${id}] 执行报废处置吗？报废后将移出可用货架库。`)) return;
    try {
        const res = await fetch(`/api/remnants/${id}/scrap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "车间质检判定破损报废" })
        });
        if (res.ok) {
            renderRemnantsLineage();
            refreshShelfRemnantsList();
            alert(`料头 [${id}] 已成功核销报废！`);
        }
    } catch (e) {
        alert("操作失败");
    }
}

function createMaterialModalDOM() {
    const div = document.createElement("div");
    div.id = "material-manager-modal";
    div.className = "settings-modal-overlay";
    div.style.display = "none";
    div.innerHTML = `
        <div class="settings-modal-dialog" style="width: 960px; max-width: 96vw; height: 720px; display: flex; flex-direction: column;">
            <div class="settings-modal-header">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: 700; font-size: 15px; color: var(--accent-blue);">母卷物料档案、疵点精准空间库与料头管理中心</span>
                    <span class="header-tag" style="color: #10b981;">纺织 4 分制 / MES 物料血统</span>
                </div>
                <button onclick="window.cutApp.plugins.material.closeMaterialModal()" style="background: transparent; border: none; color: var(--text-muted); font-size: 18px; cursor: pointer; font-weight: bold;">关闭</button>
            </div>

            <!-- 顶部选项卡 -->
            <div class="settings-nav-tabs" style="padding: 0 16px; margin-top: 6px;">
                <button class="settings-tab-btn active" id="tab-mat-rolls" onclick="window.cutApp.plugins.material.switchMaterialTab('rolls')">母卷档案与全景疵点库 (Master Rolls)</button>
                <button class="settings-tab-btn" id="tab-mat-remnants" onclick="window.cutApp.plugins.material.switchMaterialTab('remnants')">料头货架与代际血统追溯 (Remnant Lineage)</button>
                <button class="settings-tab-btn" id="tab-mat-dict" onclick="window.cutApp.plugins.material.switchMaterialTab('dict')">工业疵点标准与避让策略字典</button>
            </div>

            <!-- 主内容区 -->
            <div style="flex: 1; overflow-y: auto; padding: 16px;">
                <!-- Tab 1: 母卷档案 -->
                <div id="pane-mat-rolls" style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: grid; grid-template-columns: 360px 1fr; gap: 14px;">
                        <!-- 左侧母卷卡片列表 -->
                        <div style="display: flex; flex-direction: column;">
                            <div style="font-size: 12px; font-weight: bold; margin-bottom: 6px; color: var(--text-muted);">在库母卷台账 (点击查看详情)</div>
                            <div id="material-rolls-container" style="max-height: 520px; overflow-y: auto;">
                                <!-- 动态填充 -->
                            </div>
                        </div>
                        <!-- 右侧母卷详情与疵点表 -->
                        <div id="material-roll-detail-panel" style="display: flex; flex-direction: column;">
                            <!-- 动态填充 -->
                        </div>
                    </div>
                </div>

                <!-- Tab 2: 料头血统与货架 -->
                <div id="pane-mat-remnants" style="display: none; flex-direction: column; gap: 12px;">
                    <div style="font-size: 12px; color: var(--text-muted);">
                        说明：记录母卷切下的所有在库可用料头及再次套裁派生的二代子料头，支持追踪其直系父级、质量评级与存放库位。
                    </div>
                    <div id="material-remnants-container" style="max-height: 520px; overflow-y: auto;">
                        <!-- 动态填充 -->
                    </div>
                </div>

                <!-- Tab 3: 疵点字典 -->
                <div id="pane-mat-dict" style="display: none; flex-direction: column; gap: 12px;">
                    <div style="font-size: 12px; font-weight: bold; color: var(--accent-blue);">纺织 4 分制 (Four-Point System) 工业疵点评级与数控裁床避让策略标准</div>
                    <table class="cam-table">
                        <thead>
                            <tr>
                                <th width="100">疵点类型代码</th>
                                <th width="120">中文名称与定义</th>
                                <th width="100">扣分标准 (4分制)</th>
                                <th width="110">严重等级</th>
                                <th width="100">推荐避让间距</th>
                                <th>CAM 数控切刀避让与工艺处置策略</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td><b>HOLE</b></td>
                                <td style="color: #dc2626; font-weight: bold;">经纬向断裂破洞</td>
                                <td style="text-align: center; color: #dc2626; font-weight: bold;">扣 4 分 (致命)</td>
                                <td>4级 (致命)</td>
                                <td><b>+25 mm</b></td>
                                <td><b>绝对避让 (MUST_AVOID)</b>：裁片绝对禁止穿过，算法必须规划横刀或纵刀切出带疵废料头将其物理隔离。</td>
                            </tr>
                            <tr>
                                <td><b>WEFT_DEFECT</b></td>
                                <td style="color: #d97706; font-weight: bold;">断纬 / 抽纱 / 稀密档</td>
                                <td style="text-align: center; color: #d97706; font-weight: bold;">扣 3 分 (重度)</td>
                                <td>3级 (严重)</td>
                                <td><b>+20 mm</b></td>
                                <td><b>强制避让 (MUST_AVOID)</b>：影响成品拉伸强力与抗撕裂，切片边缘与抽纱线保持安全裕量。</td>
                            </tr>
                            <tr>
                                <td><b>STAIN</b></td>
                                <td style="color: #7c3aed; font-weight: bold;">印染滴油 / 色渍黄斑</td>
                                <td style="text-align: center; color: #7c3aed; font-weight: bold;">扣 2 分 (中度)</td>
                                <td>2级 (一般)</td>
                                <td><b>+20 mm</b></td>
                                <td><b>外观避让 (MUST_AVOID)</b>：绝不允许落入A类/正面合格裁片；若落入内部衬料或料头则可免切除。</td>
                            </tr>
                            <tr>
                                <td><b>SLUB</b></td>
                                <td style="color: #059669; font-weight: bold;">纱支粗节 / 死棉结头</td>
                                <td style="text-align: center; color: #059669; font-weight: bold;">扣 1 分 (轻微)</td>
                                <td>1级 (轻微)</td>
                                <td><b>+15 mm</b></td>
                                <td><b>允许贯通 (PENETRABLE)</b>：轻微粗节允许落入次级裁片或留存料头中，不强制切除，最大化利用率。</td>
                            </tr>
                            <tr>
                                <td><b>SHADING</b></td>
                                <td style="color: #0284c7; font-weight: bold;">边中色差 / 经向色花</td>
                                <td style="text-align: center; color: #0284c7; font-weight: bold;">扣 2~4 分</td>
                                <td>2~3级 (中度)</td>
                                <td><b>整幅对色</b></td>
                                <td><b>保向对色排料</b>：严格保持裁片经向与布料纤维经向平行，禁止混色混批裁切。</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="settings-footer">
                <span style="font-size: 11px; color: var(--text-muted);">物料闭环：母卷开卷排切 ➔ 实切扣减母卷有效长度 ➔ 自动派生在库料头 ➔ 新订单优先在库料头免母卷消耗。</span>
                <button class="tool-btn" onclick="window.cutApp.plugins.material.closeMaterialModal()">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}
