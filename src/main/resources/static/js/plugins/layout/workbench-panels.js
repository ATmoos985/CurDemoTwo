import {state} from '../../core/state.js';
import {queuedReports} from '../solver/report-queue.js';

const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function panel(id, title, subtitle, actions = '') {
    const dialog = document.createElement('dialog');
    dialog.id = id; dialog.className = 'action-dialog workbench-dialog';
    dialog.setAttribute('aria-labelledby', id + '-title');
    dialog.innerHTML = `<div class="workbench-dialog-heading"><div><h2 id="${id}-title">${title}</h2><p>${subtitle}</p></div><button class="tool-btn" data-close>关闭</button></div><div class="workbench-dialog-body"></div><div class="workbench-dialog-footer">${actions}<button class="tool-btn" data-close>返回工作台</button></div>`;
    dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
    dialog.addEventListener('keydown', event => event.stopPropagation());
    document.body.append(dialog);
    return dialog;
}

export function initWorkbenchPanels() {
    const demand = panel('demand-manager', '新建裁切任务', '填写任务信息，添加需求后选择材料。',
        '<span class="muted" id="demand-editor-hint" role="status"></span><button class="tool-btn active" id="demand-editor-save" aria-describedby="demand-editor-hint" disabled>保存并选择材料</button>');
    const footer = demand.querySelector('.workbench-dialog-footer');
    footer.insertBefore(footer.querySelector('[data-close]'), el('demand-editor-save'));
    el('demand-editor-save').onclick = async () => {
        const creating = !state.activeTask;
        if (await window.camApp.saveTaskFromUI()) {
            demand.close();
            if (creating) window.camApp.matchTaskMaterials();
        }
    };
    demand.querySelector('.workbench-dialog-body').append(el('card-demands').querySelector('.section-content'));
    const card = el('card-demands');
    card.classList.remove('collapsible', 'collapsed');
    card.querySelector('.section-header').removeAttribute('title');
    card.querySelector('.section-header').innerHTML = '<strong>本次需求 <span id="demands-summary-badge"></span></strong><button class="tool-btn" onclick="openDemandManager()">管理需求 ↗</button>';
    const summary = document.createElement('div'); summary.id = 'demand-quick-list';card.append(summary);
    const body = document.createElement('section');body.id = 'material-details';body.hidden = true;
    document.body.append(body);
    body.innerHTML = '<section id="material-inspection"></section><div id="inspection-radar-slot"></div>';
    // Keep the existing inputs and IDs: there is still one authoritative editor.
    body.append(el('card-defects'), el('card-mother-roll'));
    const marker=document.createElement('span');marker.id='radar-home';marker.hidden=true;
    el('roll-radar-bar').before(marker);
    el('card-defects').classList.remove('collapsed');
    el('card-defects').querySelector('.section-toggle').setAttribute('aria-expanded','true');
    el('card-mother-roll').classList.remove('collapsed');
    el('card-mother-roll').querySelector('.section-toggle').setAttribute('aria-expanded','true');
    el('right-roll-actions').querySelector('.reset-actions').append(el('btn-radar-reset'));
    el('btn-radar-reset').textContent = '重置本卷报工与库存…';
    const inputs = el('left-input-actions');
    inputs.append(el('btn-workflow-next'));
    // Demand and material inputs stay left; execution controls stay right.
    el('input-flow-status').append(el('workflow-current'), el('station-action-hint'));
    el('sidebar-left').querySelector('.sidebar-scroll-body').prepend(el('card-demands'), el('material-context'), el('remnant-entry'));
}

export function openDemandManager(id) {
    const dialog = el('demand-manager'); if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    if (id != null) {
        const row = [...el('demands-container').querySelectorAll('.item-row')].find(row => Number(row.dataset.id) === Number(id));
        if (row) {row.tabIndex = -1;row.focus({preventScroll:true});row.scrollIntoView({block:'center'});}
    }
}

export function renderDemandEditor(flow) {
    const dialog = el('demand-manager');if (!dialog) return;
    const creating = !state.activeTask;
    dialog.dataset.new = String(creating);
    el('demand-manager-title').textContent = creating ? '新建裁切任务' : '任务需求';
    dialog.querySelector('.workbench-dialog-heading p').textContent = creating
        ? '填写任务信息，添加需求后选择材料。' : '修改当前任务的需求；已报工数量保留。';
    el('demand-manager-import').hidden = !creating;
    el('demand-manager-sample').hidden = !creating;
    el('demand-editor-save').disabled = flow.stage === 0;
    el('demand-editor-save').textContent = creating ? '保存并选择材料' : '保存修改';
    el('demand-editor-hint').textContent = flow.stage === 0 ? flow.hint : creating ? '需求已齐备，下一步选择母卷或料头。' : '修改自动保留为本机草稿。';
    const queued = queuedReports().length;
    dialog.querySelectorAll('.workbench-dialog-body input,.workbench-dialog-body select,.workbench-dialog-body button').forEach(node => node.disabled = !!queued);
    if(queued){el('demand-editor-save').disabled=true;el('demand-editor-hint').textContent=`${queued} 个工位待报工，完成集中报工后可修改需求。`;}
    dialog.querySelector('.workbench-dialog-footer [data-close]').textContent = creating ? '稍后继续' : '返回工作台';
    el('demand-progress-summary').hidden = creating;
}

export function renderDemandSummary(progress, rows) {
    const list = el('demand-quick-list'); if (!list) return;
    // Rebuild only when facts change, keeping focus and scroll stable during canvas navigation.
    const facts = progress.map((item, index) => ({...item, name:rows[index].querySelector('.dem-name').value,
        width:rows[index].querySelector('.dem-w').value, length:rows[index].querySelector('.dem-l').value}));
    const signature = JSON.stringify(facts);if (list.dataset.facts === signature) return;list.dataset.facts = signature;
    list.innerHTML = facts.length ? facts.map(item => `<button class="demand-quick-row" data-demand="${item.id}" data-complete="${item.remaining === 0}"><span><strong>${esc(item.name)}</strong><small>${esc(item.width)} × ${esc(item.length)} mm</small></span><span><b>${item.remaining === 0 ? '已满足' : item.toCut===0 ? '待报工 '+item.staged : '待切 '+(item.toCut ?? '—')}</b><small>已报工 ${item.completed} / ${item.total || '—'}${item.staged && item.toCut ? ' · 待报工 '+item.staged : ''}</small></span><span class="demand-meter" aria-hidden="true"><span style="width:${item.total>0?Math.min(100,item.completed/item.total*100):0}%"></span><span class="demand-meter-staged" style="width:${item.total>0?Math.max(0,Math.min(item.staged,item.total-item.completed)/item.total*100):0}%"></span></span></button>`).join('')
        : '<div class="workbench-empty"><strong>当前任务还没有需求</strong><p>导入订单，或在需求窗口填写规格和数量。</p><button class="tool-btn active" onclick="openDemandImport()">为当前任务导入</button><button class="tool-btn" onclick="openDemandManager()">填写需求</button></div>';
    list.querySelectorAll('[data-demand]').forEach(button => button.onclick = () => openDemandManager(button.dataset.demand));
    if (el('demand-task-caption')) el('demand-task-caption').textContent = el('task-name')?.value || '当前任务';
}

export function openMaterialDetails() {
    window.camApp.openMaterialModal('current');
}

export function mountInspectionRadar(active) {
    const radar=el('roll-radar-bar'), slot=el('inspection-radar-slot');
    if(!radar || !slot)return;
    if(active)slot.append(radar);else el('radar-home').after(radar);
}

export function renderMaterialInspection() {
    const panel = el('material-inspection');if (!panel) return;
    const data = state.getCurrentCaseData(), sheet = state.currentCutMode === 'remnant';
    if (!data.materialAvailable) {panel.innerHTML = '<p class="workbench-empty">尚未装载材料，请先选择本次用料。</p>';return;}
    const source = sheet ? state.loadedRemnant : null, width = Number(sheet ? source?.width : data.rollW), length = Number(sheet ? source?.length : data.totalRollL);
    const defects = data.globalDefects || [], used = sheet ? 0 : data.stockUsedLength || 0;
    const id = sheet ? source?.id : data.rollId;
    panel.innerHTML = `<div class="inspection-title"><div><span>${sheet ? '在库料头' : '当前母卷'}</span><h3>${esc(id)}</h3></div><strong>${defects.length} <small>处疵点记录</small></strong></div>
        <p class="muted">${esc(sheet ? source?.materialBatch : el('lbl-roll-model-desc').textContent)} · 幅宽 ${width.toLocaleString()} mm · ${sheet ? '长度' : '余量'} ${(sheet ? length : data.stockRemainingLength).toLocaleString()} mm</p>
        ${String(id).startsWith('ROLL-REAL-') ? '<p class="source-notice">此编号原为样例母卷，请核对长度和疵点是否已按实物更新。</p>' : ''}
        `;
    for(const row of el('defects-container').querySelectorAll('.item-row')) {
        const get=key=>Number(row.querySelector('.d-'+key).value), summary=row.querySelector('summary');
        if(summary)summary.innerHTML=`<strong>#${esc(row.dataset.id)}</strong><span>X ${get('x').toLocaleString()} / Y ${get('y').toLocaleString()}</span><span>${get('w')} × ${get('h')} mm</span><span>避让 ${get('margin')} mm</span><small>${get('y')+get('h')<=used?'已用段':get('y')<(data.windowStartY||0)+data.bedL && get('y')+get('h')>(data.windowStartY||0)?'当前工位':'待展开'} · 编辑 ▾</small>`;
    }
}
