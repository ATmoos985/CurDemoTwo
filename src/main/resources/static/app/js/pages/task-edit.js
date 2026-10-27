// 任务编辑：新建 / 编辑任务与需求，导入 Excel / CSV / JSON 需求（复用经典 demand-import-model 解析）。
// 本机草稿防丢失；保存走 /api/cutting/tasks（带 revision，冲突时提示重新载入）。
import {requestJSON, esc, fmtN, errorBox, toast} from '../util.js';
import {emptyTask, fromTask, addDemand, mergeImport, taskProblems, lineLock, toPayload, demandTemplateCsv} from '../model/task-form.js';
import {parseDemandSheet, parseDemandJSON, importedTask, importGroups} from '../../../js/business/cutting/demand-import-model.js';

const ORIGINS = [['right-bottom', '右下'], ['left-bottom', '左下'], ['right-top', '右上'], ['left-top', '左上']];
const draftKey = id => 'cutplan.app.taskdraft.' + (id || 'new');
let sheetLib;
function loadSheetLib() {
    sheetLib ||= new Promise((resolve, reject) => {
        const s = document.createElement('script'); s.src = '/vendor/sheetjs/xlsx.mini.min.js';
        s.onload = () => resolve(window.XLSX); s.onerror = () => { sheetLib = null; s.remove(); reject(new Error('表格读取组件加载失败，请重试')); };
        document.head.append(s);
    });
    return sheetLib;
}

export async function mount(el, [taskId]) {
    let original = null, completed = {}, rolls = [];
    try {
        const [detail, r] = await Promise.all([taskId && taskId !== 'new' ? requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId)) : null, requestJSON('/api/rolls')]);
        rolls = r;
        if (detail) { original = detail.task; completed = detail.completed || {}; }
    } catch (e) { el.innerHTML = errorBox(e); return; }
    const key = draftKey(original?.id);
    const draft = JSON.parse(localStorage.getItem(key) || 'null');
    let form = draft && (!original || draft.revision === original.revision) ? draft : original ? fromTask(original) : emptyTask();
    let imp = null; // {result, groups, gi, selected:Set, source}
    let saving = false, conflict = false;
    const models = [...new Set(rolls.map(r => r.rollModel).filter(Boolean))].sort();
    const persist = () => localStorage.setItem(key, JSON.stringify(form));
    const dirty = () => !original || JSON.stringify(toPayload(form)) !== JSON.stringify(toPayload(fromTask(original)));

    function render() {
        const problems = taskProblems(form, {original, completed}), p = form.process;
        const total = form.demands.reduce((a, d) => a + (Number(d.quantity) || 0), 0);
        el.innerHTML = `<div class="ph"><h1>${original ? '编辑任务' : '新建任务'}</h1><span class="crumb">${original ? esc(original.name) + ' · 版本 ' + original.revision : '填写需求后保存，再进入工作台选料排料'}</span>
            ${draft && dirty() ? '<span class="tag warn">本机草稿</span>' : ''}<span class="sp"></span>
            <a class="btn" href="${original ? '#/workbench/' + encodeURIComponent(original.id) : '#/tasks'}">${original ? '返回工作台' : '返回任务'}</a>
            ${dirty() ? '<button class="btn" id="discard">放弃修改</button>' : ''}
            <button class="btn pri" id="save" ${problems.length || saving || !dirty() ? 'disabled' : ''}>${saving ? '保存中…' : original ? '保存修改' : '保存并进入工作台'}</button></div>
          ${conflict ? `<div class="notice" style="margin:12px 16px 0;display:flex;align-items:center;gap:10px"><span>任务已在别处被修改（版本已更新）。你的修改仍保留在本页，可对照后再载入最新版本重新编辑。</span><span class="sp"></span><button class="btn sm pri" id="reload-latest">载入最新版本（放弃本页修改）</button></div>` : ''}
          <div class="body"><div style="display:grid;grid-template-columns:340px 1fr;gap:12px;align-items:start">
            <div>
              <div class="box"><div class="pane-h">基本信息</div><div class="form" style="grid-template-columns:80px 1fr">
                <label>任务名称</label><input class="field" data-f="name" value="${esc(form.name)}">
                <label>材料型号</label><div><input class="field" data-f="materialModel" list="models" value="${esc(form.materialModel)}" style="width:100%" ${original && Object.keys(completed).length ? 'disabled title="已有报工，不能更改型号"' : ''}>
                  <datalist id="models">${models.map(m => `<option>${esc(m)}</option>`).join('')}</datalist>
                  <div class="muted" style="font-size:11.5px;margin-top:3px">在库同型号母卷 ${rolls.filter(r => r.rollModel === form.materialModel).length} 卷</div></div>
                <label>来源</label><input class="field" data-f="externalRef" value="${esc(form.externalRef)}" placeholder="订单文件 / 外部单号">
              </div></div>
              <div class="box"><div class="pane-h">工艺参数</div><div class="form" style="grid-template-columns:100px 1fr">
                <label>拉布长度 mm</label><input class="field num" data-p="bedLength" value="${p.bedLength}">
                <label>切头 mm</label><input class="field num" data-p="trimStart" value="${p.trimStart}">
                <label>件间距 mm</label><input class="field num" data-p="pieceGap" value="${p.pieceGap}">
                <label>切割基准</label><select class="field" data-p="cutOrigin">${ORIGINS.map(([k, t]) => `<option value="${k}" ${p.cutOrigin === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
                <label>第一刀方向</label><select class="field" data-p="firstStageOrientation"><option value="horizontal" ${p.firstStageOrientation === 'horizontal' ? 'selected' : ''}>横向</option><option value="vertical" ${p.firstStageOrientation === 'vertical' ? 'selected' : ''}>纵向</option></select>
                <label>允许旋转</label><select class="field" data-p="allowRotation"><option value="0">否</option><option value="1" ${p.allowRotation ? 'selected' : ''}>是</option></select>
                <label>允许纵切</label><select class="field" data-p="allowLongitudinal"><option value="1">是</option><option value="0" ${p.allowLongitudinal ? '' : 'selected'}>否</option></select>
              </div></div>
              ${problems.length ? `<div class="notice" style="margin:0">${problems.slice(0, 8).map(esc).join('<br>')}${problems.length > 8 ? `<br>… 共 ${problems.length} 项` : ''}</div>` : ''}
            </div>
            <div class="box" style="margin:0"><div class="pane-h">需求<span class="sub">${form.demands.length} 项 · ${fmtN(total)} 件</span><span class="sp"></span>
                <label class="btn sm" style="cursor:pointer">导入 Excel / CSV / JSON<input type="file" id="file" accept=".xlsx,.xls,.csv,.json" hidden></label>
                <button class="btn sm" id="template">下载模板</button><button class="btn sm" id="add">＋ 添加需求</button></div>
              ${imp ? importHtml() : ''}
              ${form.demands.length ? `<table class="t" style="border:0"><thead><tr><th class="r">编号</th><th>名称</th><th class="r">宽 mm</th><th class="r">长 mm</th><th class="r">件数</th><th>可旋转</th><th class="r">已报工</th><th></th></tr></thead><tbody>
              ${form.demands.map((d, i) => { const l = lineLock(d, completed); return `<tr>
                <td class="r num">${d.id}</td>
                <td><input class="field" data-d="${i}" data-k="name" value="${esc(d.name)}" style="width:100%;height:22px" ${l.locked ? 'disabled' : ''}></td>
                <td class="r"><input class="field num" data-d="${i}" data-k="width" value="${d.width}" style="width:80px;height:22px;text-align:right" ${l.locked || d.shape ? 'disabled' : ''}></td>
                <td class="r"><input class="field num" data-d="${i}" data-k="length" value="${d.length}" style="width:80px;height:22px;text-align:right" ${l.locked || d.shape ? 'disabled' : ''}></td>
                <td class="r"><input class="field num" data-d="${i}" data-k="quantity" value="${d.quantity}" style="width:64px;height:22px;text-align:right" title="${l.locked ? '不得少于已报工 ' + l.minQuantity + ' 件' : ''}"></td>
                <td><input type="checkbox" data-d="${i}" data-k="allowRotation" ${d.allowRotation ? 'checked' : ''}></td>
                <td class="r num">${completed[d.id] || completed[String(d.id)] || 0}</td>
                <td>${l.locked ? '<span class="tag">已报工</span>' : `<button class="btn sm" data-del="${i}">删除</button>`}</td></tr>`; }).join('')}</tbody></table>`
                : '<div class="empty">还没有需求。添加需求，或导入订单表（9.28 订单格式 / 标准模板 / 任务 JSON）。</div>'}
            </div></div></div>`;
        bind();
    }

    function importHtml() {
        const g = imp.groups[imp.gi] || imp.groups[0];
        return `<div style="border-bottom:1px solid var(--line-2);background:var(--panel-2)">
          <div class="pane-h">导入预览<span class="sub">${esc(imp.result.format)} · ${esc(imp.source)}</span><span class="sp"></span><button class="btn sm" id="imp-cancel">取消</button></div>
          <div style="display:flex;gap:8px;padding:8px 12px;align-items:center;flex-wrap:wrap">
            <select class="field" id="imp-group">${imp.groups.map((x, i) => `<option value="${i}" ${i === imp.gi ? 'selected' : ''}>${esc(x.materialModel || '未识别型号')}${x.fabricCode ? ' · ' + esc(x.fabricCode) : ''} · ${x.demands.length} 项${x.issues.length ? ' · ' + x.issues.length + ' 项待修正' : ''}</option>`).join('')}</select>
            <button class="btn sm" id="imp-all">全选</button><button class="btn sm" id="imp-none">清空</button>
            <span class="muted">已选 ${imp.selected.size} 项</span><span class="sp"></span>
            <label class="muted"><input type="checkbox" id="imp-append" ${imp.append ? 'checked' : ''}> 追加到现有需求</label>
            <button class="btn sm pri" id="imp-apply" ${imp.selected.size && g.index >= 0 ? '' : 'disabled'}>导入所选</button></div>
          <div style="max-height:240px;overflow:auto"><table class="t" style="border:0"><tbody>
            ${g.demands.map(d => `<tr><td><input type="checkbox" data-pick="${d.id}" ${imp.selected.has(d.id) ? 'checked' : ''}></td><td class="wrap">${esc(d.name)}</td><td class="r num">${fmtN(d.width, 1)} × ${fmtN(d.length, 1)}</td><td class="r num">${d.quantity} 件</td><td class="muted">${esc(d.note || '')}</td></tr>`).join('')}
            ${g.issues.map(x => `<tr><td></td><td class="wrap" colspan="4" style="color:var(--warn)">第 ${x.row} 行：${esc(x.message)}</td></tr>`).join('')}</tbody></table></div></div>`;
    }

    function bind() {
        const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach(x => x.addEventListener(ev, fn));
        on('[data-f]', 'change', e => { form = {...form, [e.target.dataset.f]: e.target.value}; persist(); render(); });
        on('[data-p]', 'change', e => {
            const k = e.target.dataset.p, raw = e.target.value;
            const v = ['allowRotation', 'allowLongitudinal'].includes(k) ? raw === '1' : ['cutOrigin', 'firstStageOrientation'].includes(k) ? raw : Number(raw);
            form = {...form, process: {...form.process, [k]: v}}; persist(); render();
        });
        on('[data-d]', 'change', e => {
            const i = Number(e.target.dataset.d), k = e.target.dataset.k;
            const v = k === 'allowRotation' ? e.target.checked : k === 'name' ? e.target.value : k === 'quantity' ? Math.round(Number(e.target.value)) : Number(e.target.value);
            form = {...form, demands: form.demands.map((d, j) => j === i ? {...d, [k]: v} : d)}; persist(); render();
        });
        on('[data-del]', 'click', e => { const i = Number(e.target.dataset.del); form = {...form, demands: form.demands.filter((_, j) => j !== i)}; persist(); render(); });
        on('#add', 'click', () => { form = addDemand(form); persist(); render(); });
        on('#template', 'click', () => {
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([demandTemplateCsv()], {type: 'text/csv;charset=utf-8'}));
            a.download = '需求导入模板.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
        on('#file', 'change', e => readFile(e.target.files[0]));
        on('#discard', 'click', () => { localStorage.removeItem(key); form = original ? fromTask(original) : emptyTask(); render(); });
        on('#save', 'click', save);
        on('#reload-latest', 'click', async () => {
            try {
                const d = await requestJSON('/api/cutting/tasks/' + encodeURIComponent(original.id));
                original = d.task; completed = d.completed || {}; form = fromTask(original); conflict = false;
                localStorage.removeItem(key); render(); toast('已载入最新版本');
            } catch (e) { toast(e.message, true); }
        });
        if (imp) {
            on('#imp-cancel', 'click', () => { imp = null; render(); });
            on('#imp-group', 'change', e => { imp.gi = Number(e.target.value); imp.selected = new Set((imp.groups[imp.gi].demands || []).map(d => d.id)); render(); });
            on('#imp-all', 'click', () => { imp.selected = new Set(imp.groups[imp.gi].demands.map(d => d.id)); render(); });
            on('#imp-none', 'click', () => { imp.selected = new Set(); render(); });
            on('#imp-append', 'change', e => { imp.append = e.target.checked; });
            on('[data-pick]', 'change', e => { const id = Number(e.target.dataset.pick); e.target.checked ? imp.selected.add(id) : imp.selected.delete(id); render(); });
            on('#imp-apply', 'click', () => {
                try {
                    const g = imp.groups[imp.gi];
                    if (form.materialModel && g.materialModel !== form.materialModel && !confirm(`导入的型号 ${g.materialModel} 与当前任务 ${form.materialModel} 不同，仍要导入吗？（型号保持当前值）`)) return;
                    const t = importedTask(imp.result, g.index, imp.source, [...imp.selected]);
                    form = mergeImport(form, t, {replace: !imp.append, completed}); imp = null; persist(); render();
                    toast(`已导入 ${t.demands.length} 项需求，请核对后保存`);
                } catch (err) { toast(err.message, true); }
            });
        }
    }

    async function readFile(file) {
        if (!file) return;
        try {
            let result;
            if (/\.json$/i.test(file.name)) result = parseDemandJSON(JSON.parse(await file.text()));
            else {
                const XLSX = await loadSheetLib();
                const book = XLSX.read(await file.arrayBuffer(), {type: 'array'});
                const sheet = book.Sheets[book.SheetNames[0]];
                result = parseDemandSheet(XLSX.utils.sheet_to_json(sheet, {header: 1, raw: true, defval: ''}));
            }
            const groups = importGroups(result), gi = Math.max(0, groups.findIndex(g => g.materialModel === form.materialModel && g.index >= 0));
            imp = {result, groups, gi, selected: new Set((groups[gi]?.demands || []).map(d => d.id)), source: file.name, append: false};
            render();
        } catch (e) { toast('导入失败：' + e.message, true); }
    }

    async function save() {
        const problems = taskProblems(form, {original, completed});
        if (problems.length) return toast(problems[0], true);
        saving = true; persist(); render();
        try {
            const task = await requestJSON('/api/cutting/tasks', toPayload(form));
            localStorage.removeItem(key);
            toast(original ? '任务已保存' : '任务已创建');
            location.hash = '#/workbench/' + encodeURIComponent(task.id);
        } catch (e) {
            saving = false; conflict = !!original && /已更新|重新打开|revision/.test(e.message); render();
            toast((conflict ? '任务已被他处修改：' : '保存失败，草稿已保留：') + e.message + (e.code === 'NETWORK' ? '（结果可能已生效，请到任务列表核对）' : ''), true);
        }
    }
    render();
}
