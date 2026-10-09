import {state} from '../../core/state.js';

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
    const demand = panel('demand-manager', '需求管理', '编辑订单与裁片；合格报工才计入完成。',
        '<span class="muted">修改保留在当前任务</span><button class="tool-btn" id="demand-manager-import" onclick="openDemandImport()">导入需求</button><button class="tool-btn" onclick="addDemandRow()">＋ 添加裁片</button><button class="tool-btn active" onclick="saveTaskFromUI()">保存需求</button>');
    demand.querySelector('.workbench-dialog-body').append(el('card-demands').querySelector('.section-content'));
    const card = el('card-demands');
    card.classList.remove('collapsible', 'collapsed');
    card.querySelector('.section-header').removeAttribute('title');
    card.querySelector('.section-header').innerHTML = '<strong>本次需求 <span id="demands-summary-badge"></span></strong><button class="tool-btn" onclick="openDemandManager()">管理需求 ↗</button>';
    const summary = document.createElement('div'); summary.id = 'demand-quick-list';card.append(summary);
    const body = document.createElement('section');body.id = 'material-details';body.hidden = true;
    document.body.append(body);
    body.innerHTML = '<section id="material-inspection"></section>';
    // Keep the existing inputs and IDs: there is still one authoritative editor.
    body.append(el('card-mother-roll'), el('card-defects'));
    el('card-mother-roll').classList.remove('collapsed');
    el('card-mother-roll').querySelector('.section-toggle').setAttribute('aria-expanded','true');
    const reset = document.createElement('details');reset.className = 'detail-disclosure';
    reset.innerHTML = '<summary>重置搭切记录</summary>';
    reset.append(el('btn-radar-reset'));body.append(reset);
    const inputs = el('left-input-actions');
    inputs.append(el('btn-workflow-next'), el('btn-trigger-solve-station'));
    el('sidebar-left').querySelector('.sidebar-scroll-body').append(el('right-roll-actions').querySelector('.secondary-workflow-tools'));
    // Input preparation stays left; reporting and validated output stay right.
    el('input-flow-status').append(el('workflow-current'), el('station-action-hint'));
    el('sidebar-left').querySelector('.sidebar-scroll-body').prepend(el('card-demands'), el('material-context'), el('remnant-entry'));
}

export function openDemandManager(id) {
    const dialog = el('demand-manager'); if (!dialog) return;
    el('demand-manager-import').hidden = !!state.activeTask;
    if (!dialog.open) dialog.showModal();
    if (id != null) {
        const row = [...el('demands-container').querySelectorAll('.item-row')].find(row => Number(row.dataset.id) === Number(id));
        if (row) {row.tabIndex = -1;row.focus({preventScroll:true});row.scrollIntoView({block:'center'});}
    }
}

export function renderDemandSummary(progress, rows) {
    const list = el('demand-quick-list'); if (!list) return;
    // Rebuild only when facts change, keeping focus and scroll stable during canvas navigation.
    const facts = progress.map((item, index) => ({...item, name:rows[index].querySelector('.dem-name').value,
        width:rows[index].querySelector('.dem-w').value, length:rows[index].querySelector('.dem-l').value}));
    const signature = JSON.stringify(facts);if (list.dataset.facts === signature) return;list.dataset.facts = signature;
    list.innerHTML = facts.length ? facts.map(item => `<button class="demand-quick-row" data-demand="${item.id}" data-complete="${item.remaining === 0}"><span><strong>${esc(item.name)}</strong><small>${esc(item.width)} × ${esc(item.length)} mm</small></span><span><b>${item.remaining === 0 ? '已满足' : '还差 ' + (item.remaining ?? '—')}</b><small>${item.completed} / ${item.total || '—'} 件</small></span></button>`).join('')
        : '<div class="workbench-empty"><strong>当前任务还没有需求</strong><p>导入订单，或在需求窗口填写规格和数量。</p><button class="tool-btn active" onclick="openDemandImport()">为当前任务导入</button><button class="tool-btn" onclick="openDemandManager()">填写需求</button></div>';
    list.querySelectorAll('[data-demand]').forEach(button => button.onclick = () => openDemandManager(button.dataset.demand));
    if (el('demand-task-caption')) el('demand-task-caption').textContent = el('task-name')?.value || '当前任务';
}

export function openMaterialDetails() {
    window.camApp.openMaterialModal('current');
}

export function renderMaterialInspection() {
    const panel = el('material-inspection');if (!panel) return;
    const data = state.getCurrentCaseData(), sheet = state.currentCutMode === 'remnant';
    if (!data.materialAvailable) {panel.innerHTML = '<p class="workbench-empty">尚未装载材料，请先选择本次用料。</p>';return;}
    const source = sheet ? state.loadedRemnant : null, width = Number(sheet ? source?.width : data.rollW), length = Number(sheet ? source?.length : data.totalRollL);
    const defects = data.globalDefects || [], used = sheet ? 0 : data.stockUsedLength || 0;
    const id = sheet ? source?.id : data.rollId;
    const marks = defects.map((d, index) => {
        const x = Number(d.x) / width * 100, y = Number(d.y) / length * 100;
        return `<span class="defect-map-mark" style="left:${Math.max(0,Math.min(99,y))}%;top:${Math.max(0,Math.min(99,x))}%;width:${Math.max(.45,Math.min(100,Number(d.h)/length*100))}%;height:${Math.max(4,Math.min(100,Number(d.w)/width*100))}%" title="疵点 ${index+1} · X ${Number(d.x)} / Y ${Number(d.y)} mm"></span>`;
    }).join('');
    panel.innerHTML = `<div class="inspection-title"><div><span>${sheet ? '在库料头' : '当前母卷'}</span><h3>${esc(id)}</h3></div><strong>${defects.length} <small>处疵点记录</small></strong></div>
        <p class="muted">${esc(sheet ? source?.materialBatch : el('lbl-roll-model-desc').textContent)} · 幅宽 ${width.toLocaleString()} mm · ${sheet ? '长度' : '余量'} ${(sheet ? length : data.stockRemainingLength).toLocaleString()} mm</p>
        ${String(id).startsWith('ROLL-REAL-') ? '<p class="source-notice">此编号原为样例母卷，请核对长度和疵点是否已按实物更新。</p>' : ''}
        <div class="defect-map" role="img" aria-label="疵点沿材料长度和幅宽的分布示意；精确坐标见下表"><span class="defect-map-used" style="width:${Math.min(100,used/length*100)}%"></span>${marks}</div>
        <div class="defect-map-axis"><span>布头 0 m · 灰色为已用部分</span><span>卷尾 ${(length/1000).toLocaleString()} m</span></div>
        <div class="inspection-table"><table><thead><tr><th>疵点</th><th>幅宽 X / 长向 Y (mm)</th><th>宽 × 长 (mm)</th><th>避让余量</th><th>位置</th></tr></thead><tbody>${defects.map((d,index) => `<tr><td>#${esc(d.id || index+1)} ${esc(d.type || d.name || '')}</td><td>${Number(d.x).toLocaleString()} / ${Number(d.y).toLocaleString()}</td><td>${Number(d.w)} × ${Number(d.h)}</td><td>${Number(d.margin ?? 20)} mm</td><td>${Number(d.y)+Number(d.h)<=used ? '已用段' : Number(d.y)<(data.windowStartY||0)+data.bedL && Number(d.y)+Number(d.h)>(data.windowStartY||0) ? '当前工位' : '待展开'}</td></tr>`).join('') || '<tr><td colspan="5">未登记疵点；不代表已完成质量检验。</td></tr>'}</tbody></table></div>`;
}
