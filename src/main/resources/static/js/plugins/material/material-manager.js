/** 物料库存：清单选料，详情核对；写入沿用现有库存接口。 */
import { state } from '../../core/state.js';
import { switchCutMode, onMotherRollChange, refreshShelfRemnantsList } from '../remnant/remnant-shelf.js';
import { renderScene } from '../cad/cad-renderer.js';
import { renderRadar } from '../radar/radar-scrubber.js';
import { renderDefectsUI } from '../solver/quota-manager.js';

let cachedRolls = [], cachedRemnants = [];
let activeRollId = null, activeRemnantId = null, activeTab = 'rolls';
let rollError = '', remnantError = '', detailRequest = 0;
const inspectionNames = { PASSED: '已验合格', PENDING: '待验', QUARANTINED: '隔离' };
const qualityNames = { GRADE_A: '完好', GRADE_DEFECT: '带疵', GRADE_B: '边角料' };
const escapeHtml = value => String(value ?? '未登记').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const meters = value => Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';
const area = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const remaining = roll => roll.currentRemainingLength ?? roll.totalLength;
const field = (label, value) => `<div><dt>${label}</dt><dd>${escapeHtml(value === '' ? null : value)}</dd></div>`;

export function filterInventory(items, query, status, kind) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => {
        const fields = kind === 'rolls'
            ? [item.rollId, item.materialName, item.rollModel, item.batchNo, item.storageLocation]
            : [item.id, item.sourceRollId, item.parentRemnantId, item.materialBatch, item.location];
        const text = fields.filter(Boolean).join(' ').toLocaleLowerCase();
        const matchesStatus = !status || (kind === 'rolls' ? item.inspectionStatus === status
            : status === 'defect' ? item.hasDefect : !item.hasDefect);
        return matchesStatus && words.every(word => text.includes(word));
    });
}

export async function openMaterialModal(tab = 'rolls') {
    if (!document.getElementById('material-manager-modal')) createMaterialModalDOM();
    const modal = document.getElementById('material-manager-modal');
    activeRollId = state.getCurrentCaseData().rollId || activeRollId;
    if (!modal.open) modal.showModal();
    await switchMaterialTab(tab);
}

export function closeMaterialModal() {
    detailRequest++;
    document.getElementById('material-manager-modal')?.close();
}

export async function switchMaterialTab(tabName) {
    activeTab = tabName;
    for (const name of ['rolls', 'remnants', 'dict']) {
        const button = document.getElementById(`tab-mat-${name}`);
        button.classList.toggle('active', name === tabName);
        button.setAttribute('aria-pressed', String(name === tabName));
        document.getElementById(`pane-mat-${name}`).hidden = name !== tabName;
    }
    if (tabName === 'dict') return;
    document.getElementById(`material-${tabName}-container`).innerHTML = '<p class="inventory-empty" role="status">正在读取库存…</p>';
    if (tabName === 'rolls') {
        await refreshRollsList();
        renderRollsList();
    } else await renderRemnantsLineage();
}

export async function refreshRollsList() {
    rollError = '';
    try {
        const response = await fetch('/api/rolls', { cache: 'no-store' });
        if (!response.ok) throw new Error('读取失败');
        cachedRolls = await response.json();
        for (const roll of cachedRolls) {
            const selector = document.getElementById('sel-mother-roll-id');
            if (selector && ![...selector.options].some(option => option.value === roll.rollId)) {
                selector.add(new Option(`${roll.rollId} (${roll.rollModel})`, roll.rollId));
            }
            const filter = document.getElementById('sel-remnant-filter-roll');
            if (filter && ![...filter.options].some(option => option.value === roll.rollId)) filter.add(new Option(roll.rollId, roll.rollId));
        }
    } catch { rollError = '母卷库存读取失败，请刷新重试。'; }
}

function filtered(kind, items) {
    return filterInventory(items, document.getElementById(`inventory-${kind}-search`).value,
        document.getElementById(`inventory-${kind}-filter`).value, kind);
}

function renderRollsList() {
    const container = document.getElementById('material-rolls-container');
    const detail = document.getElementById('material-roll-detail-panel');
    const rows = filtered('rolls', cachedRolls);
    document.getElementById('inventory-rolls-summary').textContent = rollError || `${cachedRolls.length} 卷母卷 · 账面剩余 ${meters(cachedRolls.reduce((sum, r) => sum + (remaining(r) || 0), 0))} m · 待验 ${cachedRolls.filter(r => r.inspectionStatus === 'PENDING').length} 卷`;
    document.getElementById('inventory-rolls-count').textContent = `显示 ${rollError ? 0 : rows.length} / ${cachedRolls.length} 卷`;
    if (rollError || !rows.length) {
        detailRequest++;
        container.innerHTML = `<p class="inventory-empty">${rollError || (cachedRolls.length ? '没有匹配的母卷，试试其他编号、面料或库位。' : '暂无母卷，可通过「录入母卷」添加。')}</p>`;
        detail.innerHTML = '<p class="inventory-empty">选择母卷后查看详情。</p>';
        return;
    }
    if (!rows.some(r => r.rollId === activeRollId)) activeRollId = rows[0].rollId;
    const mounted = state.getCurrentCaseData().rollId;
    container.innerHTML = `<table class="inventory-table"><thead><tr><th>母卷 / 面料</th><th>余量</th><th>库位 / 状态</th></tr></thead><tbody>${rows.map(r => `
        <tr data-roll-row="${escapeHtml(r.rollId)}" class="${r.rollId === activeRollId ? 'selected' : ''}">
            <td><button class="inventory-item-link" data-roll="${escapeHtml(r.rollId)}" aria-pressed="${r.rollId === activeRollId}">${escapeHtml(r.rollId)}</button>
                <span class="inventory-secondary">${escapeHtml(r.materialName || r.rollModel)}</span>${r.rollId === mounted ? '<span class="inventory-current">当前台面</span>' : ''}</td>
            <td><strong class="inventory-number">${meters(remaining(r))} m</strong><span class="inventory-secondary">幅宽 ${escapeHtml(r.width)} mm</span></td>
            <td>${escapeHtml(r.storageLocation || '未登记库位')}<span class="inventory-secondary">${escapeHtml(inspectionNames[r.inspectionStatus] || r.inspectionStatus || '未登记')}</span></td>
        </tr>`).join('')}</tbody></table>`;
    selectRollForDetail(activeRollId);
}

export async function selectRollForDetail(rollId) {
    activeRollId = rollId;
    const request = ++detailRequest;
    const detail = document.getElementById('material-roll-detail-panel');
    if (!detail) return;
    document.querySelectorAll('[data-roll-row]').forEach(row => row.classList.toggle('selected', row.dataset.rollRow === rollId));
    document.querySelectorAll('[data-roll]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.roll === rollId)));
    detail.innerHTML = '<p class="inventory-empty" role="status">正在读取母卷详情…</p>';
    try {
        const response = await fetch(`/api/rolls/${encodeURIComponent(rollId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('读取失败');
        const roll = await response.json();
        if (request !== detailRequest) return;
        const rem = remaining(roll), used = roll.usedLength ?? (roll.totalLength - rem);
        const pct = roll.totalLength > 0 ? Math.min(100, Math.max(0, rem / roll.totalLength * 100)) : 0;
        detail.innerHTML = `
            <div class="inventory-detail-heading"><h3>${escapeHtml(roll.rollId)}</h3><p>${escapeHtml(roll.materialName || roll.rollModel)}</p></div>
            <button class="tool-btn inventory-primary" data-mount="${escapeHtml(roll.rollId)}">装载到裁切台面</button>
            <div class="inventory-length"><div><span>账面剩余</span><strong>${meters(rem)} <small>m</small></strong></div><span>${escapeHtml(inspectionNames[roll.inspectionStatus] || roll.inspectionStatus || '未登记')}</span></div>
            <div class="inventory-length-track" role="img" aria-label="剩余长度占原卷 ${Math.round(pct)}%"><span style="width:${pct}%"></span></div>
            <p class="inventory-secondary">原卷 ${meters(roll.totalLength)} m · 已用 ${meters(used)} m</p>
            <dl class="inventory-fields">${field('净幅宽', `${roll.width} mm`)}${field('库位', roll.storageLocation)}${field('批次', roll.batchNo)}</dl>
            <details class="inventory-disclosure"><summary>面料与验布资料</summary><dl class="inventory-fields">
                ${field('型号', roll.rollModel)}${field('毛幅宽 (mm)', roll.rawWidth)}${field('克重 (g/m²)', roll.grammage)}${field('缩水率 (%)', roll.shrinkageRate)}${field('成分', roll.composition)}${field('供应商', roll.supplier)}${field('验布员', roll.inspector)}${field('在库料头', `${roll.remnantCount ?? 0} 块 / ${area(roll.remnantTotalArea ?? 0)} m²`)}
            </dl></details>
            <details class="inventory-disclosure"><summary>疵点记录 <span>${(roll.defects || []).length} 处</span></summary>
                ${defectRecords(roll.defects || [])}
                <details id="add-defect-form-box" class="inventory-form-disclosure"><summary>＋ 标定新疵点</summary>${defectForm(rollId)}</details>
            </details>`;
    } catch {
        if (request === detailRequest) detail.innerHTML = '<p class="inventory-empty" role="status">详情读取失败，请重新选择母卷或刷新库存。</p>';
    }
}

function defectRecords(defects) {
    if (!defects.length) return '<p class="inventory-secondary">暂无疵点记录。</p>';
    return `<div class="inventory-defects">${defects.map(d => `<details><summary>
        <span>${escapeHtml(d.typeName || d.defectType || `疵点 ${d.id}`)}</span><span>Y ${escapeHtml(d.y)} mm</span></summary>
        <dl class="inventory-fields">${field('坐标 X / Y', `${d.x} / ${d.y} mm`)}${field('宽 × 长', `${d.w} × ${d.h} mm`)}${field('避让间距 (mm)', d.margin)}${field('扣分', d.points)}
            ${field('来源', d.detectionSource === 'AI_VISION_SCANNER' ? '视觉验布' : d.detectionSource === 'MANUAL_INSPECT' ? '人工标定' : d.detectionSource)}
            ${field('处理策略', d.avoidanceStrategy === 'MUST_AVOID' ? '必须避让' : d.avoidanceStrategy === 'PENETRABLE' ? '允许贯通' : d.avoidanceStrategy)}
        </dl></details>`).join('')}</div>`;
}

function defectForm(rollId) {
    return `<form class="inventory-form" data-defect-form="${escapeHtml(rollId)}">
        <label>纵向 Y (mm)<input id="inp-new-defect-y" type="number" min="0" value="4500" step="any" required></label>
        <label>横向 X (mm)<input id="inp-new-defect-x" type="number" min="0" value="600" step="any" required></label>
        <label>宽 (mm)<input id="inp-new-defect-w" type="number" min="0.001" value="200" step="any" required></label>
        <label>长 (mm)<input id="inp-new-defect-h" type="number" min="0.001" value="150" step="any" required></label>
        <label>疵点类型<select id="sel-new-defect-type"><option value="HOLE">破洞</option><option value="WEFT_DEFECT">抽纱 / 跳纱</option><option value="STAIN" selected>油污 / 黄斑</option><option value="SLUB">粗节 / 结头</option></select></label>
        <label>避让间距 (mm)<input id="inp-new-defect-m" type="number" min="0" value="20" step="any" required></label>
        <label class="inventory-form-wide">检出来源<select id="sel-new-defect-src"><option value="AI_VISION_SCANNER">视觉验布机</option><option value="MANUAL_INSPECT">现场人工标定</option></select></label>
        <button class="tool-btn inventory-primary inventory-form-wide" type="submit">保存疵点</button>
    </form>`;
}

export function toggleAddDefectForm() {
    const form = document.getElementById('add-defect-form-box');
    if (form) { form.parentElement.open = true; form.open = !form.open; }
}

async function renderRemnantsLineage() {
    remnantError = '';
    try {
        const response = await fetch('/api/remnants', { cache: 'no-store' });
        if (!response.ok) throw new Error('读取失败');
        cachedRemnants = await response.json();
    } catch { remnantError = '料头库存读取失败，请刷新重试。'; }
    renderRemnantsList();
}

function renderRemnantsList() {
    const rows = filtered('remnants', cachedRemnants);
    const container = document.getElementById('material-remnants-container');
    const detail = document.getElementById('material-remnant-detail-panel');
    document.getElementById('inventory-remnants-summary').textContent = remnantError || `${cachedRemnants.length} 块可用料头 · 总面积 ${area(cachedRemnants.reduce((sum, r) => sum + (r.area || 0), 0))} m² · 带疵 ${cachedRemnants.filter(r => r.hasDefect).length} 块`;
    document.getElementById('inventory-remnants-count').textContent = `显示 ${remnantError ? 0 : rows.length} / ${cachedRemnants.length} 块`;
    if (remnantError || !rows.length) {
        container.innerHTML = `<p class="inventory-empty">${remnantError || (cachedRemnants.length ? '没有匹配的料头，试试其他编号、来源母卷或库位。' : '暂无可用料头，实切确认后可登记入库。')}</p>`;
        detail.innerHTML = '<p class="inventory-empty">选择料头后查看详情。</p>';
        return;
    }
    if (!rows.some(r => r.id === activeRemnantId)) activeRemnantId = rows[0].id;
    container.innerHTML = `<table class="inventory-table"><thead><tr><th>料头 / 批次</th><th>规格</th><th>库位 / 质量</th></tr></thead><tbody>${rows.map(r => `
        <tr data-remnant-row="${escapeHtml(r.id)}" class="${r.id === activeRemnantId ? 'selected' : ''}">
            <td><button class="inventory-item-link" data-remnant="${escapeHtml(r.id)}" aria-pressed="${r.id === activeRemnantId}">${escapeHtml(r.id)}</button><span class="inventory-secondary">${escapeHtml(r.materialBatch)}</span></td>
            <td><strong class="inventory-number">${escapeHtml(r.width)} × ${escapeHtml(r.length)}</strong><span class="inventory-secondary">mm · ${area(r.area)} m²</span></td>
            <td>${escapeHtml(r.location || '未登记库位')}<span class="inventory-secondary">${escapeHtml(qualityNames[r.qualityGrade] || r.qualityGrade || '未评级')}${r.hasDefect ? ' · 有疵点' : ''}</span></td>
        </tr>`).join('')}</tbody></table>`;
    selectStockRemnant(activeRemnantId);
}

function selectStockRemnant(id) {
    activeRemnantId = id;
    const remnant = cachedRemnants.find(r => r.id === id);
    if (!remnant) return;
    document.querySelectorAll('[data-remnant-row]').forEach(row => row.classList.toggle('selected', row.dataset.remnantRow === id));
    document.querySelectorAll('[data-remnant]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.remnant === id)));
    document.getElementById('material-remnant-detail-panel').innerHTML = `
        <div class="inventory-detail-heading"><h3>${escapeHtml(id)}</h3><p>${escapeHtml(remnant.materialBatch)}</p></div>
        <div class="inventory-length"><div><span>料头面积</span><strong>${area(remnant.area)} <small>m²</small></strong></div><span>${remnant.hasDefect ? '局部带疵' : '无疵点记录'}</span></div>
        <dl class="inventory-fields">${field('宽 × 长', `${remnant.width} × ${remnant.length} mm`)}${field('库位', remnant.location)}${field('质量等级', qualityNames[remnant.qualityGrade] || remnant.qualityGrade)}</dl>
        <details class="inventory-disclosure"><summary>来源与流转</summary><dl class="inventory-fields">
            ${field('来源母卷', remnant.sourceRollId)}${field('父级料头', remnant.parentRemnantId || (remnant.generation === 1 ? '无（母卷直切）' : null))}${field('代数', remnant.generation)}${field('入库时间', remnant.createdAt)}${field('备注', remnant.defectDesc)}
        </dl></details>
        <details class="inventory-disclosure"><summary>疵点记录 <span>${(remnant.defects || []).length} 处</span></summary>${defectRecords(remnant.defects || [])}</details>
        <details class="inventory-disclosure"><summary>库存处置</summary><p class="inventory-secondary">报废后将移出可用库存。</p><button class="tool-btn inventory-danger" data-scrap="${escapeHtml(id)}">报废此料头</button></details>`;
}

function inventoryPane(kind, label, placeholder, options, detailId) {
    return `<section id="pane-mat-${kind}" class="inventory-pane" ${kind === 'remnants' ? 'hidden' : ''} aria-label="${label}">
        <p class="inventory-summary" id="inventory-${kind}-summary" role="status">正在读取库存…</p>
        <div class="inventory-toolbar"><input type="search" id="inventory-${kind}-search" aria-label="搜索${label}" placeholder="${placeholder}">
            <select id="inventory-${kind}-filter" aria-label="筛选${label}"><option value="">全部${kind === 'rolls' ? '验布状态' : '料头'}</option>${options}</select>
            <button class="tool-btn" data-refresh>刷新</button></div>
        ${kind === 'rolls' ? `<details class="inventory-new-roll"><summary>＋ 录入母卷</summary>
            <form id="inventory-new-roll-form" class="inventory-form">
                <label>母卷编号<input id="new-roll-id" required></label><label>面料名称 / 型号<input id="new-roll-model" required></label>
                <label>净幅宽 (mm)<input id="new-roll-width" type="number" min="0.001" step="any" required></label>
                <label>总长度 (mm)<input id="new-roll-length" type="number" min="0.001" step="any" required></label>
                <label>库位<input id="new-roll-location"></label><button class="tool-btn inventory-primary" type="submit">保存并装载</button>
                <p id="new-roll-error" class="inventory-form-wide inventory-error" role="alert"></p>
            </form></details>` : ''}
        <div class="inventory-browser"><div class="inventory-list"><p id="inventory-${kind}-count" class="inventory-list-caption"></p><div id="material-${kind}-container" class="inventory-table-scroll"></div></div>
            <aside id="${detailId}" class="inventory-detail" aria-label="${kind === 'rolls' ? '母卷' : '料头'}详情"></aside></div>
    </section>`;
}

function createMaterialModalDOM() {
    const modal = document.createElement('dialog');
    modal.id = 'material-manager-modal';
    modal.className = 'inventory-dialog';
    modal.setAttribute('aria-labelledby', 'inventory-title');
    modal.innerHTML = `
        <div class="inventory-header"><h2 id="inventory-title">物料与库存</h2><button class="tool-btn" data-close autofocus>返回工作台</button></div>
        <nav class="inventory-tabs" aria-label="库存分类"><button id="tab-mat-rolls" data-tab="rolls" aria-pressed="true" aria-controls="pane-mat-rolls">母卷库存</button><button id="tab-mat-remnants" data-tab="remnants" aria-pressed="false" aria-controls="pane-mat-remnants">料头库存</button><button id="tab-mat-dict" data-tab="dict" aria-pressed="false" aria-controls="pane-mat-dict">疵点参考</button></nav>
        <div class="inventory-body">
            ${inventoryPane('rolls', '母卷', '搜索编号、面料或库位', '<option value="PASSED">已验合格</option><option value="PENDING">待验</option><option value="QUARANTINED">隔离</option>', 'material-roll-detail-panel')}
            ${inventoryPane('remnants', '料头', '搜索编号、来源母卷或库位', '<option value="clean">无疵点</option><option value="defect">有疵点</option>', 'material-remnant-detail-panel')}
            <section id="pane-mat-dict" class="inventory-reference" hidden>
                <h3>疵点类型说明</h3><p>以下为演示中的分类参考。具体坐标、避让间距与处理策略，请查看物料的疵点记录。</p>
                ${[['HOLE', '破洞', '经纬向断裂形成孔洞。'], ['WEFT_DEFECT', '断纬 / 抽纱', '纱线缺失或排列异常。'], ['STAIN', '油污 / 色渍', '布面油污、黄斑或印染污染。'], ['SLUB', '粗节 / 结头', '纱线局部增粗或形成结头。'], ['SHADING', '色差', '布面不同区域颜色不一致。']].map(([code, name, description]) => `<details class="inventory-disclosure"><summary>${name}<span>${code}</span></summary><p>${description}</p></details>`).join('')}
            </section>
        </div>
        <div class="inventory-footer">查看和装载不扣库存；现场裁切后，在工作台确认实切。</div>`;
    modal.addEventListener('keydown', event => event.stopPropagation());
    modal.addEventListener('close', () => { detailRequest++; });
    modal.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button) return;
        const d = button.dataset;
        if ('close' in d) closeMaterialModal();
        else if (d.tab) switchMaterialTab(d.tab);
        else if ('refresh' in d) switchMaterialTab(activeTab);
        else if (d.roll || d.remnant) {
            if (d.roll) await selectRollForDetail(d.roll);
            else selectStockRemnant(d.remnant);
            if (window.matchMedia('(max-width: 960px)').matches) {
                document.getElementById(d.roll ? 'material-roll-detail-panel' : 'material-remnant-detail-panel').scrollIntoView({ block: 'start' });
            }
        }
        else if (d.mount) mountRollToStation(d.mount);
        else if (d.scrap) scrapRemnantById(d.scrap);
    });
    modal.addEventListener('input', event => {
        if (event.target.id === `inventory-${activeTab}-search`) activeTab === 'rolls' ? renderRollsList() : renderRemnantsList();
    });
    modal.addEventListener('change', event => {
        if (event.target.id === `inventory-${activeTab}-filter`) activeTab === 'rolls' ? renderRollsList() : renderRemnantsList();
    });
    modal.addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.submitter;
        if (button) button.disabled = true;
        try {
            if (event.target.id === 'inventory-new-roll-form') await submitNewRoll();
            else if (event.target.dataset.defectForm) await submitNewDefect(event.target.dataset.defectForm);
        } finally { if (button) button.disabled = false; }
    });
    document.body.appendChild(modal);
}

export async function submitNewRoll() {
    const read = id => document.getElementById(id).value.trim();
    const roll = {
        rollId: read("new-roll-id"), rollModel: read("new-roll-model"),
        materialName: read("new-roll-model"), width: Number(read("new-roll-width")),
        totalLength: Number(read("new-roll-length")), storageLocation: read("new-roll-location"),
        inspectionStatus: "PENDING", defects: []
    };
    const error = document.getElementById("new-roll-error");
    if (!roll.rollId || !roll.rollModel || roll.width <= 0 || roll.totalLength <= 0) {
        error.textContent = "请填写母卷编号、面料、幅宽与长度";
        return;
    }
    if (cachedRolls.some(item => item.rollId === roll.rollId)) {
        error.textContent = "母卷编号已存在，请使用新编号";
        return;
    }
    try {
        const response = await fetch("/api/rolls", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(roll) });
        if (!response.ok) throw new Error("母卷录入失败");
        await refreshRollsList();
        renderRollsList();
        await mountRollToStation(roll.rollId);
        error.textContent = "";
    } catch (e) { error.textContent = e.message; }
}


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
            const savedDefect = await res.json();
            await refreshRollsList();
            selectRollForDetail(rollId);
            // 如果正是当前主 CAM 台面生产的母卷，同步至主画布
            const curData = state.getCurrentCaseData();
            if (curData.rollId === rollId) {
                curData.globalDefects = curData.globalDefects || [];
                curData.globalDefects.push(savedDefect);
                renderDefectsUI(curData.globalDefects);
                renderScene();
                renderRadar();
            }
            alert("疵点标定成功并已持久化至母卷档案！");
        } else {
            alert("疵点标定失败：坐标需落在母卷范围内");
        }
    } catch (e) {
        alert("提交疵点失败，请检查服务状态");
    }
}


export async function mountRollToStation(rollId) {
    const sel = document.getElementById("sel-mother-roll-id");
    if (sel) {
        sel.value = rollId;
        await switchCutMode("roll");
        closeMaterialModal();
        alert(`已成功装载母卷 [${rollId}] 至主 CAM 裁切工位！`);
    }
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
