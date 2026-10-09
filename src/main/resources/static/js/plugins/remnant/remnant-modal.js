/** 当前方案预计产出与当前母卷库存使用独立页签。 */
import { state } from '../../core/state.js';
import { requestJSON } from '../../core/api-request.js';
import { showToast } from '../../core/toast.js';
import { requestFromUI, materialContext } from '../material/material-selection.js';
import { recommendationMarkup } from '../material/remnant-recommendation.js';
import { motherRollRemnants } from './remnant-dialog-model.js';
import { queuedReports } from '../solver/report-queue.js';
import { escapeText } from '../solver/task-workspace.js';

const el = id => document.getElementById(id);
const rollId = () => state.currentCutMode === 'remnant' ? state.loadedRemnant?.sourceRollId : state.getCurrentCaseData().rollId;
const usable = stock => (stock.status || 'AVAILABLE') === 'AVAILABLE' && !queuedReports().some(row => row.pending.sourceRemnantId === stock.id);
let generation = 0, stocks = [], recommending = false;

function switchTab(tab, focus = false) {
    for (const name of ['expected','stock']) {
        const selected = name === tab, button = el('remnant-tab-' + name);
        button.setAttribute('aria-selected',String(selected));button.tabIndex = selected ? 0 : -1;
        el('remnant-panel-' + name).hidden = !selected;
        if (selected && focus) button.focus();
    }
}

export async function openRemnantModal(tab = 'expected') {
    const dialog = el('remnant-modal');
    if (!dialog.open) {
        const token = ++generation;
        dialog.onclose = () => { if (generation === token) generation++; };
        dialog.onkeydown = event => {
            event.stopPropagation();
            if (event.target.getAttribute('role') !== 'tab') return;
            if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
                event.preventDefault();
                switchTab(event.key === 'Home' ? 'expected' : event.key === 'End' ? 'stock' : event.target.id.endsWith('expected') ? 'stock' : 'expected',true);
            }
        };
        for (const name of ['expected','stock']) el('remnant-tab-' + name).onclick = () => switchTab(name);
        el('remnant-roll-scope').textContent = rollId() ? '所属母卷 · ' + rollId() : '尚未装载母卷，请先选择用料';
        el('inp-scan-barcode').value = '';
        el('remnant-recommend-results').replaceChildren();
        el('remnant-availability').textContent = '按当前剩余需求试排可用料头';
        el('btn-remnant-recommend').onclick = recommend;
        el('remnant-refresh').onclick = refreshRemnantsList;
        el('inp-scan-barcode').oninput = renderStocks;
        switchTab(tab === 'stock' ? 'stock' : 'expected');
        dialog.showModal();
        await refreshRemnantsList();
        return;
    }
    if (dialog.open) switchTab(tab === 'stock' ? 'stock' : 'expected');
}

export function closeRemnantModal() { el('remnant-modal')?.close(); }

function renderStocks() {
    const words = el('inp-scan-barcode').value.trim().toLowerCase();
    const visible = stocks.filter(r => (r.id + ' ' + (r.location || '')).toLowerCase().includes(words));
    el('header-remnant-count').textContent = stocks.length;
    el('remnant-stock-status').textContent = rollId() ? '本母卷共 ' + stocks.length + ' 块 · 可用 ' + stocks.filter(usable).length + ' 块' : '选择母卷后查看其料头';
    const container = el('remnant-cards-container');
    container.innerHTML = visible.length ? visible.map(r => {
        const status = usable(r) ? r.hasDefect ? '可用 · 带疵需避让' : '可用 · 无疵' : queuedReports().some(row=>row.pending.sourceRemnantId===r.id) ? '本机待报工占用' : ({CONSUMED:'已用完',SCRAPPED:'已报废',RESERVED:'已占用',IN_USE:'在制',PENDING:'待整理'}[r.status] || r.status || '不可用');
        return '<article class="remnant-stock-row"><div><strong>' + escapeText(r.id) + '</strong><span class="remnant-stock-status">' + escapeText(status) + '</span><p class="remnant-dimensions">' + r.width + ' × ' + r.length + ' mm <span>· ' + (r.width*r.length/1000000).toFixed(3) + ' m²</span></p><small>' + escapeText(r.location || '库位未登记') + ' · ' + escapeText(r.materialBatch || '型号未登记') + '</small></div><button class="tool-btn" data-stock-id="' + escapeText(r.id) + '" ' + (usable(r) ? '' : 'disabled') + '>选择并核对</button></article>';
    }).join('') : '<p class="inventory-empty">' + (words ? '没有匹配的料头，请调整编号或库位。' : '当前母卷尚无料头库存。确认回收报工后在此查看。') + '</p>';
    container.querySelectorAll('[data-stock-id]').forEach(button => button.onclick = () => selectAndLoadRemnant(button.dataset.stockId));
}

export async function refreshRemnantsList() {
    const dialog = el('remnant-modal');if (!dialog?.open) return;
    const token = ++generation, source = rollId();
    dialog.onclose = () => { if(generation === token) generation++; };
    el('remnant-cards-container').textContent = '正在读取本母卷料头库存…';
    el('remnant-recommend-results').replaceChildren();
    el('remnant-availability').textContent = '按当前剩余需求试排可用料头';
    el('btn-remnant-recommend').disabled = true;
    try {
        const list = await requestJSON('/api/remnants');
        if (!dialog.open || generation !== token || source !== rollId()) return;
        stocks = motherRollRemnants(list,source);renderStocks();
    } catch(error) {
        if(dialog.open && generation===token) {stocks=[];el('header-remnant-count').textContent='—';el('remnant-cards-container').textContent='读取失败：' + error.message;el('remnant-stock-status').textContent='库存读取未完成，可点击刷新重试。';}
    } finally {
        if(dialog.open && generation===token) el('btn-remnant-recommend').disabled = recommending || !source;
    }
}

async function recommend() {
    if(recommending || !rollId())return;
    const dialog = el('remnant-modal'), token = generation, snapshot = materialContext(), source = rollId();
    const input = requestFromUI(), completedBaseline = structuredClone(state.taskCompleted || {});
    const valid = () => dialog.open && token===generation;
    recommending=true;el('btn-remnant-recommend').disabled=true;el('remnant-refresh').disabled=true;
    el('remnant-recommend-results').replaceChildren();el('remnant-availability').textContent='正在试排本母卷的可用料头…';
    try {
        if(!input.rollModel || !input.demands.length)throw new Error('请先填写材料型号与剩余需求，再计算推荐。');
        const result = await requestJSON('/api/cutting/remnant-recommendations',{input,completedBaseline,sourceRollId:source});
        if(!valid())return;
        if(snapshot!==materialContext())throw new Error('需求、工艺或用料已变化，请重新计算推荐。');
        result.recommendations = result.recommendations.filter(r=>usable(r.stock));
        el('remnant-availability').textContent='按本母卷料头独立试排，每块的产出不能相加。';
        const panel=el('remnant-recommend-results');panel.innerHTML=recommendationMarkup(result);
        panel.querySelectorAll('[data-recommend-stock]').forEach(button=>button.onclick=()=>{
            if(snapshot!==materialContext()) {el('remnant-availability').textContent='需求或工艺已变化，请重新计算推荐。';panel.replaceChildren();return;}
            selectAndLoadRemnant(button.dataset.recommendStock);
        });
    } catch(error) {if(valid())el('remnant-availability').textContent='推荐未完成：' + error.message;}
    finally {
        recommending=false;el('btn-remnant-recommend').disabled=!rollId();el('remnant-refresh').disabled=false;
    }
}

export async function selectAndLoadRemnant(id) {
    const source = rollId();closeRemnantModal();
    return window.camApp.matchTaskMaterials({type:'remnant',id,sourceRollId:source,skipRecommend:true});
}
export async function executeBarcodeScan() {
    const code=el('inp-scan-barcode').value.trim();
    if(!code)return showToast('请输入或扫描料头条码','warning');
    const stock=stocks.find(r=>r.id===code);
    if(!stock || !usable(stock))return showToast('该料头不属于当前母卷或不可用','warning');
    return selectAndLoadRemnant(code);
}
export function quickScan(id) {el('inp-scan-barcode').value=id;return executeBarcodeScan();}
