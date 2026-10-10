import {parseDemandSheet, parseDemandJSON, importedTask, importGroups, matchingImportRolls} from './demand-import-model.js';
import {importDemandTask, escapeText} from './task-workspace.js';
import {openDemandManager} from '../layout/workbench-panels.js';
import {demandSample} from './demand-sample.js';
import {state} from '../../core/state.js';
import {showToast} from '../../core/toast.js';
import {requestJSON} from '../../core/api-request.js';

let library;
function loadSpreadsheetLibrary() {
    if (!library) library = new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = 'vendor/sheetjs/xlsx.mini.min.js';
        script.onload = () => resolve(window.XLSX);
        script.onerror = () => { library = null; script.remove(); reject(new Error('表格读取组件加载失败，请重试。')); };
        document.head.append(script);
    });
    return library;
}

export async function openDemandImport({sample = false} = {}) {
    if (state.activeTask) { showToast('当前任务已保存，导入另一批订单请先新建任务。', 'info'); return; }
    if (document.getElementById('demand-import')) { document.getElementById('demand-import').showModal(); return; }
    const dialog = document.createElement('dialog');
    dialog.id = 'demand-import'; dialog.className = 'action-dialog workbench-dialog';
    dialog.setAttribute('aria-labelledby', 'demand-import-title');
    dialog.innerHTML = `<div class="workbench-dialog-heading">
        <div><h2 id="demand-import-title">${sample ? '9.28 订单需求' : '从 Excel 导入需求'}</h2>
        <p>① 选择文件中的布料 / 母卷　② 勾选其下需求　③ 导入本次任务</p></div>
        <button class="tool-btn" data-close aria-label="关闭需求导入">关闭</button></div>
        <div class="workbench-dialog-body">
            <div class="import-file"><label>订单文件<input id="demand-import-file" type="file" accept=".xlsx,.csv,.json"></label>
                <button class="tool-btn" id="demand-import-template">下载标准模板</button></div>
            <label id="demand-import-sheet-label" hidden>工作表 <select id="demand-import-sheet" class="prop-input"></select></label>
            <p id="demand-import-status" role="status">支持 9.28 订单 Excel、标准需求表和任务 JSON，文件在本机读取。</p>
            <p id="demand-import-error" role="alert" hidden></p>
            <div id="demand-import-workspace" class="import-workspace" hidden>
                <section class="import-fabrics" aria-label="文件中的布料与母卷">
                    <h3>文件中的布料 <span id="demand-import-model-count"></span></h3>
                    <input id="demand-import-search" class="prop-input" type="search" aria-label="查找布料编号或型号" placeholder="查找布料编号 / 型号">
                    <div id="demand-import-groups" class="import-group-list"></div>
                </section>
                <section class="import-demands" aria-label="当前布料需求">
                    <div class="import-demand-heading"><h3 id="demand-import-preview-title"></h3><p id="demand-import-count"></p></div>
                    <div class="import-stock"><label>关联母卷 <select id="demand-import-roll" class="prop-input"></select></label><p id="demand-import-stock-note"></p></div>
                    <div class="import-selection-bar"><strong>勾选本次要裁的需求</strong><div>
                        <button class="tool-btn" id="demand-import-select-all">全选当前布料</button>
                        <button class="tool-btn" id="demand-import-clear-selection">清空</button></div></div>
                    <div class="import-demand-scroll"><table class="data-table"><thead><tr>
                        <th><input id="demand-import-check-all" type="checkbox" aria-label="全选当前布料需求"></th><th>来源 / 订单</th>
                        <th>原表裁布尺寸 <small>cm</small></th><th>导入宽 × 长 <small>mm</small></th><th>片数</th>
                    </tr></thead><tbody id="demand-import-rows"></tbody></table></div>
                    <p class="import-axis-note">RH 横裁：裁布高度 → 母卷幅宽方向；每片裁布宽度 → 送料长度。双片按支数 × 2，保持纹向。</p>
                </section>
            </div>
            <details id="demand-import-issues" hidden><summary></summary><ul></ul></details>
        </div>
        <div class="workbench-dialog-footer import-actions"><p id="demand-import-selection" role="status">尚未选择需求</p>
            <button class="tool-btn active" id="demand-import-apply" disabled>导入本次任务</button></div>`;
    document.body.append(dialog); dialog.showModal();
    const el = id => dialog.querySelector('#' + id);
    let result = null, groups = [], active = 0, source = '', workbook = null, rolls = [], version = 0, importing = false;
    const checked = new Set(), group = () => groups[active];
    const fail = error => { el('demand-import-error').textContent = error.message; el('demand-import-error').hidden = false; };
    const footer = () => {
        const lines = group()?.demands.filter(d => checked.has(d.id)) || [];
        el('demand-import-selection').textContent = lines.length
            ? `${group().fabricCode || group().materialModel} · 已选 ${lines.length} 项 / ${lines.reduce((n,d)=>n+d.quantity,0)} 片`
            : '尚未勾选需求 · 一次导入一种布料';
        el('demand-import-apply').disabled = importing || !lines.length;
        el('demand-import-apply').textContent = importing ? '正在导入…' : lines.length ? `导入本次任务（${lines.length} 项）` : '导入本次任务';
        const all = el('demand-import-check-all');
        all.checked = lines.length > 0 && lines.length === group()?.demands.length;
        all.indeterminate = lines.length > 0 && lines.length < group()?.demands.length;
        all.disabled = importing || !group()?.demands.length;
    };
    const renderGroupList = () => {
        const query = el('demand-import-search').value.trim().toLowerCase();
        el('demand-import-groups').innerHTML = groups.map((g,i) => {
            if (!`${g.fabricCode || ''} ${g.materialModel}`.toLowerCase().includes(query)) return '';
            const stock = matchingImportRolls(g, rolls);
            return `<button type="button" class="import-group ${i === active ? 'active' : ''}" data-group="${i}" aria-pressed="${i === active}">
                <strong>${escapeText(g.fabricCode || g.materialModel || '布料待定')}</strong><span>${escapeText(g.materialModel || '型号未填写')}</span>
                <small>${g.demands.length} 项 / ${g.demands.reduce((n,d)=>n+d.quantity,0)} 片${g.issues.length ? ` · ${g.issues.length} 行待核对` : ''}</small>
                <small class="import-stock-status">${stock.length ? `${stock.length} 卷可关联 · ${stock.reduce((n,r)=>n+(r.remnantCount || 0),0)} 块料头` : '暂无匹配母卷'}</small></button>`;
        }).join('') || '<p class="muted">未找到该编号或型号</p>';
    };
    const renderStockNote = () => {
        const roll = rolls.find(r=>r.rollId === el('demand-import-roll').value);
        el('demand-import-stock-note').textContent = roll
            ? `幅宽 ${roll.width} mm · 余长 ${(roll.currentRemainingLength / 1000).toLocaleString()} m · ${roll.remnantCount || 0} 块料头${roll.storageLocation?.includes('演示') ? ' · 演示预置，非 Excel 库存' : ''}`
            : '可先导入需求，之后选择或登记相同型号的母卷。';
    };
    const renderDetails = () => {
        const g = group(); if (!g) return;
        el('demand-import-preview-title').textContent = `${g.fabricCode ? g.fabricCode + ' · ' : ''}${g.materialModel || '布料待定'}`;
        el('demand-import-count').textContent = `${g.demands.length} 项有效需求 / ${g.demands.reduce((n,d)=>n+d.quantity,0)} 片${g.issues.length ? ` · ${g.issues.length} 行待核对` : ''}`;
        const stock = matchingImportRolls(g, rolls);
        el('demand-import-roll').replaceChildren(...(stock.length
            ? stock.map(r=>new Option(`${r.rollId} · ${r.width} mm`,r.rollId)) : [new Option('暂无匹配母卷，先导入需求','')]));
        const current = state.getCurrentCaseData().rollId;
        if (stock.some(r=>r.rollId === current)) el('demand-import-roll').value = current;
        el('demand-import-rows').innerHTML = g.demands.map(d=>`<tr data-demand="${d.id}" class="${checked.has(d.id) ? 'selected' : ''}">
            <td><input type="checkbox" data-demand-id="${d.id}" aria-label="选择第 ${d.row} 行需求" ${checked.has(d.id) ? 'checked' : ''}></td>
            <td><strong>${escapeText(d.order || d.name)}</strong><small>第 ${d.row} 行${d.style ? ` · ${escapeText(d.style)}` : ''}${d.pair ? ` · ${d.pair}片 × ${d.orderQuantity} 支` : ''}</small></td>
            <td>${d.cutWidthCm ? `${d.cutWidthCm} × ${d.cutHeightCm}<small>每片宽度 × 裁布高度</small>` : '—'}</td>
            <td class="numeric">${d.width} × ${d.length}${d.note ? `<small title="${escapeText(d.note)}">${escapeText(d.note)}</small>` : ''}</td><td class="numeric">${d.quantity}</td></tr>`).join('')
            + g.issues.map(i=>`<tr class="import-invalid"><td>—</td><td>${escapeText(i.line?.order || '—')}<small>第 ${i.row} 行</small></td><td colspan="3">${escapeText(i.message)}</td></tr>`).join('');
        el('demand-import-select-all').disabled = !g.demands.length;
        dialog.querySelector('.import-axis-note').hidden = !result.format.startsWith('9.28');
        renderStockNote(); footer();
    };
    const render = () => {
        checked.clear(); groups = importGroups(result); active = 0; el('demand-import-search').value = '';
        el('demand-import-workspace').hidden = !groups.length;
        el('demand-import-model-count').textContent = `${groups.filter(g=>g.materialModel).length} 种`;
        const lines = result.groups.flatMap(g=>g.demands);
        el('demand-import-status').textContent = `${source} · ${groups.filter(g=>g.materialModel).length} 种明确布料 · 可导入 ${lines.length} 项 / ${lines.reduce((n,d)=>n+d.quantity,0)} 片${result.issues.length ? ` · ${result.issues.length} 行待核对` : ''}`;
        const issues = el('demand-import-issues'); issues.hidden = !result.issues.length;
        issues.querySelector('summary').textContent = `${result.issues.length} 行待核对，不参与导入 · 展开查看原表行号`;
        issues.querySelector('ul').innerHTML = result.issues.map(i=>`<li>第 ${i.row} 行 · ${escapeText(i.line?.fabricCode || i.model || '布料待定')}：${escapeText(i.message)}</li>`).join('');
        renderGroupList(); renderDetails();
    };
    const clearFile = () => {
        result = null; groups = []; checked.clear();
        for (const id of ['demand-import-workspace','demand-import-issues','demand-import-error']) el(id).hidden = true;
        footer();
    };
    const parseSheet = () => {
        clearFile();
        try {
            const name = el('demand-import-sheet').value, sheet = workbook.Sheets[name];
            if (sheet['!fullref']) throw new Error('工作表超过 10000 行，请按批次拆分。');
            result = parseDemandSheet(window.XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true}));
            source = `${el('demand-import-file').files[0].name} / ${name}`; render();
        } catch (error) { fail(error); }
    };
    el('demand-import-file').onchange = async event => {
        const file = event.target.files[0], token = ++version;
        clearFile(); workbook = null; el('demand-import-sheet-label').hidden = true;
        if (!file) { el('demand-import-status').textContent = '请选择订单文件'; return; }
        el('demand-import-status').textContent = '正在读取 ' + file.name;
        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请按批次拆分后导入。');
            source = file.name;
            if (/\.json$/i.test(file.name)) {
                const value = JSON.parse(await file.text());
                if (token !== version || !dialog.open) return;
                result = parseDemandJSON(value); render();
            } else {
                if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('请选择 .xlsx、.csv 或 .json 文件。');
                const xlsx = await loadSpreadsheetLibrary(), bytes = await file.arrayBuffer();
                if (token !== version || !dialog.open) return;
                workbook = xlsx.read(bytes,{type:'array',sheetRows:10002});
                el('demand-import-sheet').replaceChildren(...workbook.SheetNames.map(n=>new Option(n,n)));
                el('demand-import-sheet-label').hidden = workbook.SheetNames.length < 2; parseSheet();
            }
        } catch (error) { if (token === version && dialog.open) fail(error); }
    };
    el('demand-import-groups').onclick = event => {
        const button = event.target.closest('[data-group]'); if (!button || Number(button.dataset.group) === active) return;
        active = Number(button.dataset.group); checked.clear(); renderGroupList(); renderDetails();
    };
    el('demand-import-rows').onchange = event => {
        const input = event.target.closest('[data-demand-id]'); if (!input) return;
        const id = Number(input.dataset.demandId); input.checked ? checked.add(id) : checked.delete(id);
        input.closest('tr').classList.toggle('selected',input.checked); footer();
    };
    const selectAll = selected => {
        checked.clear(); if (selected) group()?.demands.forEach(d=>checked.add(d.id));
        el('demand-import-rows').querySelectorAll('[data-demand-id]').forEach(input => {
            input.checked = selected; input.closest('tr').classList.toggle('selected',selected);
        }); footer();
    };
    el('demand-import-select-all').onclick = () => selectAll(true);
    el('demand-import-clear-selection').onclick = () => selectAll(false);
    el('demand-import-check-all').onchange = event => selectAll(event.target.checked);
    el('demand-import-search').oninput = renderGroupList;
    el('demand-import-sheet').onchange = parseSheet;
    el('demand-import-roll').onchange = renderStockNote;
    el('demand-import-apply').onclick = async () => {
        if (importing || !checked.size) return;
        const token = ++version; importing = true; el('demand-import-error').hidden = true;
        const controls = [...dialog.querySelectorAll('button,input,select')].map(input=>[input,input.disabled]);
        controls.forEach(([input])=>input.disabled=true); footer();
        try {
            const task = importedTask(result, group().index, source, [...checked]);
            if (await importDemandTask(task, () => dialog.open && token === version, el('demand-import-roll').value)) {
                dialog.close(); openDemandManager();
            }
        } catch (error) { if (dialog.open) fail(error); }
        finally { importing = false; controls.forEach(([input,disabled])=>input.disabled=disabled); footer(); }
    };
    el('demand-import-template').onclick = () => {
        const csv = '\ufeff订单编号,材料型号,裁片名称,宽度(mm),长度(mm),数量,允许旋转\r\n订单001,材料A,窗帘主片,2000,1200,2,否\r\n';
        const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
        const link = document.createElement('a'); link.href=url; link.download='需求导入模板.csv'; link.click(); URL.revokeObjectURL(url);
    };
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    dialog.addEventListener('cancel',event=>{if(importing) event.preventDefault();});
    dialog.addEventListener('close',()=>{version++;dialog.remove();});
    try { rolls = await requestJSON('/api/rolls'); }
    catch (error) { if(dialog.open) fail(new Error('母卷库存读取失败，可先查看需求；导入时将重试。' + error.message)); }
    if (!dialog.open) return;
    if (sample && version === 0) { result = demandSample; source = '9.28.xlsx / Sheet1'; render(); }
    else if (result) { renderGroupList(); renderDetails(); }
}
