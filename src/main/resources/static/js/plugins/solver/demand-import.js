import {parseDemandSheet, parseDemandJSON, importedTask} from './demand-import-model.js';
import {importDemandTask, escapeText} from './task-workspace.js';
import {openDemandManager} from '../layout/workbench-panels.js';
import {demandSample} from './demand-sample.js';
import {state} from '../../core/state.js';
import {showToast} from '../../core/toast.js';

let library;
function loadSpreadsheetLibrary() {
    if (!library) library = new Promise((resolve, reject) => {
        const script = document.createElement('script');script.src = 'vendor/sheetjs/xlsx.mini.min.js';
        script.onload = () => resolve(window.XLSX);
        script.onerror = () => {library = null;script.remove();reject(new Error('表格读取组件加载失败，请重试。'));};
        document.head.append(script);
    });
    return library;
}

export function openDemandImport({sample = false} = {}) {
    if (state.activeTask) {showToast('当前任务已保存，请在需求窗口编辑；导入另一批订单请先新建任务。','info');return;}
    if (document.getElementById('demand-import')) {document.getElementById('demand-import').showModal();return;}
    const dialog = document.createElement('dialog');dialog.id = 'demand-import';dialog.className = 'action-dialog workbench-dialog';
    dialog.setAttribute('aria-labelledby','demand-import-title');
    dialog.innerHTML = `<div class="workbench-dialog-heading"><div><h2 id="demand-import-title">${sample ? '选择 9.28 样例需求' : '导入当前任务的需求'}</h2><p>当前任务：${escapeText(document.getElementById('task-name').value)} · 每次选取一种材料型号。</p></div><button class="tool-btn" data-close>关闭</button></div>
        <div class="workbench-dialog-body"><div class="import-file"><label>选择订单文件<input id="demand-import-file" type="file" accept=".xlsx,.csv,.json"></label><button class="tool-btn" id="demand-import-template">下载标准模板</button></div>
        <p class="muted">支持现有 9.28 Excel、标准需求表和现有任务 JSON。文件在本机读取；确认后生成草稿，保存需求才写入服务器。</p>
        <p id="demand-import-status" role="status">等待选择文件</p><label id="demand-import-sheet-label" hidden>工作表 <select id="demand-import-sheet" class="prop-input"></select></label>
        <div id="demand-import-preview" hidden><label class="import-model-label">本次导入的材料型号<select id="demand-import-model" class="prop-input"></select></label><p id="demand-import-count"></p>
        <p id="demand-import-rule" class="source-notice"></p><div class="import-table"><table><thead><tr><th>来源行 / 订单</th><th>裁片</th><th>宽 × 长 (mm)</th><th>件数</th></tr></thead><tbody id="demand-import-rows"></tbody></table></div></div>
        <div id="demand-import-issues" hidden></div><p id="demand-import-error" role="alert" hidden></p></div>
        <div class="workbench-dialog-footer"><span class="muted">母卷库存、疵点和报工不随订单导入</span><button class="tool-btn" data-close>取消</button><button class="tool-btn active" id="demand-import-apply" disabled>导入当前任务</button></div>`;
    document.body.append(dialog);dialog.showModal();
    const el = id => dialog.querySelector('#' + id), apply = el('demand-import-apply');
    let result, workbook, source = '', version = 0, importing = false;
    const fail = error => {el('demand-import-error').hidden = false;el('demand-import-error').textContent = error.message;el('demand-import-status').textContent = '尚未导入，请核对后重试。';};
    const ready = () => {apply.disabled = importing || !result?.groups.length || (result.issues.length > 0 && !el('demand-import-skip')?.checked);};
    const renderGroup = () => {
        const group = result.groups[Number(el('demand-import-model').value)];
        el('demand-import-preview').hidden = !group;
        if (group) {
            el('demand-import-count').textContent = `${group.demands.length} 项需求 · ${group.demands.reduce((n,d) => n+d.quantity,0)} 件 · 文件共 ${result.groups.length} 种材料，每次导入一种`;
            el('demand-import-rule').textContent = result.format.startsWith('9.28')
                ? '沿用 RH 横裁口径：幅宽方向 = 裁布高度 × 10；卷长方向 = 每片宽度 × 10；双片数量 × 2。禁止旋转；拼接上限仅供核对，不自动拆片。'
                : '按表内 mm 尺寸和总需求件数导入；不会恢复原任务编号、完成量或库存状态。';
            el('demand-import-rows').innerHTML = group.demands.map(d => `<tr><td>第 ${d.row} 行${d.order ? '<br>'+escapeText(d.order) : ''}</td><td>${escapeText(d.name)}${d.note ? '<small>'+escapeText(d.note)+'</small>' : ''}</td><td>${d.width} × ${d.length}</td><td>${d.quantity}</td></tr>`).join('');
        }
        ready();
    };
    const render = () => {
        el('demand-import-status').textContent = source + ' · ' + result.format;
        el('demand-import-model').replaceChildren(...result.groups.map((group,index) => new Option(group.materialModel,index)));
        const issues = el('demand-import-issues');issues.hidden = !result.issues.length;
        issues.innerHTML = result.issues.length ? `<details open><summary>${result.issues.length} 行无法导入</summary><ul>${result.issues.map(item => `<li>第 ${item.row} 行 · ${escapeText(item.model || '未填型号')}：${escapeText(item.message)}</li>`).join('')}</ul></details><label><input id="demand-import-skip" type="checkbox">已核对，跳过以上行，仅导入所选型号的有效需求</label>` : '';
        el('demand-import-skip')?.addEventListener('change', ready);renderGroup();
    };
    const parseSheet = () => {result = null;apply.disabled = true;el('demand-import-error').hidden = true;el('demand-import-preview').hidden = true;el('demand-import-issues').hidden = true;
        try {const sheet = el('demand-import-sheet').value;
            if (workbook.Sheets[sheet]['!fullref']) throw new Error('工作表超过 10000 行，请按批次拆分；未导入任何数据。');
            result = parseDemandSheet(window.XLSX.utils.sheet_to_json(workbook.Sheets[sheet], {header:1,defval:'',raw:true}));
            source = el('demand-import-file').files[0].name + ' / ' + sheet;render();
        } catch(error) {fail(error);}
    };
    el('demand-import-file').onchange = async event => {
        const file = event.target.files[0], token = ++version;
        result = null;workbook = null;apply.disabled = true;el('demand-import-preview').hidden = true;el('demand-import-issues').hidden = true;el('demand-import-sheet-label').hidden = true;el('demand-import-error').hidden = true;
        if (!file) return;el('demand-import-status').textContent = '正在读取 ' + file.name;
        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请按批次拆分后导入。');
            source = file.name;
            if (/\.json$/i.test(file.name)) {const value = JSON.parse(await file.text());if(token!==version || !dialog.open)return;result = parseDemandJSON(value);render();}
            else {
                if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('请选择 .xlsx、.csv 或 .json 文件。');
                const xlsx = await loadSpreadsheetLibrary(), bytes = await file.arrayBuffer();
                if(token!==version || !dialog.open)return;
                workbook = xlsx.read(bytes, {type:'array',sheetRows:10002});
                el('demand-import-sheet').replaceChildren(...workbook.SheetNames.map(name => new Option(name,name)));
                el('demand-import-sheet-label').hidden = workbook.SheetNames.length < 2;
                parseSheet();
            }
        } catch(error) {if(token===version)fail(error);}
    };
    el('demand-import-model').onchange = renderGroup;el('demand-import-sheet').onchange = parseSheet;
    dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => {version++;dialog.remove();});
    apply.onclick = async () => {
        if (apply.disabled) return;
        const task = importedTask(result, Number(el('demand-import-model').value), source);
        const token = version;
        importing = true;
        const inputs = [...dialog.querySelectorAll('input,select')];inputs.forEach(input => input.disabled = true);
        apply.disabled = true;el('demand-import-error').hidden = true;
        try {if (await importDemandTask(task, () => dialog.open && token === version)) {dialog.close();openDemandManager();}}
        catch(error) {fail(error);}
        finally {importing = false;if(dialog.open){inputs.forEach(input => input.disabled = false);ready();}}
    };
    el('demand-import-template').onclick = () => {
        const blob = new Blob(['\ufeff订单编号,材料型号,裁片名称,宽度(mm),长度(mm),数量,允许旋转\r\n示例订单,请填写真实型号,示例裁片,600,800,2,否\r\n'], {type:'text/csv;charset=utf-8'});
        const url = URL.createObjectURL(blob), link = document.createElement('a');link.href = url;link.download = '需求导入模板.csv';link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
    };
    if (sample) {
        result = demandSample;source = '9.28 样例';
        dialog.querySelector('.import-file').hidden = true;
        render();
        const cream = result.groups.findIndex(group => group.materialModel === '2#A3A-Cream');
        el('demand-import-model').value = String(Math.max(0,cream));renderGroup();
        el('demand-import-status').textContent = '9.28 Excel · 100 项有效需求 / 156 件 · 保留原尺寸与数量，订单编号以来源行替代。第 78、79、108、109 行字段不完整，未纳入样例。';
    }
}
