import {parseDemandSheet, parseDemandJSON, importedTask, evaluateModelMatches, importedTasks} from './demand-import-model.js';
import {importDemandTask, escapeText, loadTask} from './task-workspace.js';
import {openDemandManager} from '../layout/workbench-panels.js';
import {demandSample} from './demand-sample.js';
import {state} from '../../core/state.js';
import {showToast} from '../../core/toast.js';

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
    if (state.activeTask) { showToast('当前任务已保存，请在需求窗口编辑；导入另一批订单请先新建任务。', 'info'); return; }
    if (document.getElementById('demand-import')) { document.getElementById('demand-import').showModal(); return; }

    // 预拉取最新在库母卷库存
    let allRolls = [];
    try {
        const res = await fetch('/api/rolls', {cache: 'no-store'});
        if (res.ok) allRolls = await res.json();
    } catch { allRolls = []; }

    const dialog = document.createElement('dialog');
    dialog.id = 'demand-import';
    dialog.className = 'action-dialog workbench-dialog';
    dialog.setAttribute('aria-labelledby', 'demand-import-title');

    dialog.innerHTML = `<div class="workbench-dialog-heading">
        <div>
            <h2 id="demand-import-title">${sample ? '选择 9.28 样例需求' : '导入订单需求'}</h2>
            <p>先选母卷智能筛选可切型号 · 支持单选直接排料或批量勾选生成任务</p>
        </div>
        <button class="tool-btn" data-close>关闭</button>
    </div>
    <div class="workbench-dialog-body">
        <div class="import-file">
            <label>选择订单文件<input id="demand-import-file" type="file" accept=".xlsx,.csv,.json"></label>
            <button class="tool-btn" id="demand-import-template">下载标准模板</button>
        </div>
        <p class="muted">支持现有 9.28 Excel、标准需求表和现有任务 JSON。文件在本机读取，安全可靠。</p>
        <p id="demand-import-status" role="status">等待选择文件</p>
        <label id="demand-import-sheet-label" hidden>工作表 <select id="demand-import-sheet" class="prop-input"></select></label>

        <!-- 母卷筛选器 -->
        <div id="demand-import-roll-filter-bar" class="import-roll-filter-bar" hidden>
            <div class="filter-row">
                <label class="import-filter-label">
                    <span>母卷筛选：</span>
                    <select id="demand-import-roll" class="prop-input"></select>
                </label>
                <label class="import-checkbox-label">
                    <input id="demand-import-only-matched" type="checkbox" checked>
                    仅看当前母卷可切型号
                </label>
                <input id="demand-import-search" class="prop-input import-search-input" type="search" placeholder="筛选型号名称...">
            </div>
        </div>

        <!-- 型号多选与高密清单 -->
        <div id="demand-import-models-wrapper" class="import-models-wrapper" hidden>
            <div class="models-header-bar">
                <span>订单材料型号（共 <strong id="demand-import-model-count">0</strong> 种，已勾选 <strong id="demand-import-checked-count">0</strong> 种）：</span>
                <div class="models-batch-actions">
                    <button type="button" class="tool-btn" id="demand-import-select-all">全选可见</button>
                    <button type="button" class="tool-btn" id="demand-import-clear-selection">清空选择</button>
                </div>
            </div>
            <div class="import-models-scroll">
                <table class="import-model-table">
                    <thead>
                        <tr>
                            <th style="width:36px;text-align:center;">选</th>
                            <th>材料型号</th>
                            <th>需求 / 件数</th>
                            <th>最大宽 (mm)</th>
                            <th>母卷可切状态</th>
                        </tr>
                    </thead>
                    <tbody id="demand-import-models-rows"></tbody>
                </table>
            </div>
        </div>

        <!-- 裁片明细预览折叠面板 -->
        <div id="demand-import-preview" hidden>
            <div class="preview-heading">
                <h4 id="demand-import-preview-title">裁片明细预览</h4>
                <span id="demand-import-count" class="muted"></span>
            </div>
            <p id="demand-import-rule" class="source-notice"></p>
            <div class="import-table">
                <table>
                    <thead>
                        <tr>
                            <th>来源行 / 订单</th>
                            <th>裁片</th>
                            <th>宽 × 长 (mm)</th>
                            <th>件数</th>
                        </tr>
                    </thead>
                    <tbody id="demand-import-rows"></tbody>
                </table>
            </div>
        </div>

        <div id="demand-import-issues" hidden></div>
        <p id="demand-import-error" role="alert" hidden></p>
    </div>

    <div class="workbench-dialog-footer">
        <div class="import-footer-container">
            <div class="import-footer-summary">
                <span id="demand-import-selected-summary">请先选择材料型号</span>
            </div>
            <div class="import-footer-buttons">
                <button class="tool-btn" data-close>取消</button>
                <button class="tool-btn active" id="demand-import-batch" style="display:none;">批量创建任务</button>
                <button class="tool-btn active" id="demand-import-apply" disabled>导入当前任务并排料</button>
            </div>
        </div>
    </div>`;

    document.body.append(dialog);
    dialog.showModal();

    const el = id => dialog.querySelector('#' + id);
    const apply = el('demand-import-apply');
    const batchBtn = el('demand-import-batch');

    let result = null, workbook = null, source = '', version = 0, importing = false;
    let checkedIndices = new Set();
    let activePreviewIndex = -1;

    // 当前机台母卷
    const currentMachineRollId = document.getElementById('sel-mother-roll-id')?.value || state.getCurrentCaseData()?.rollId || '';

    // 初始化母卷下拉选项
    const initRollOptions = () => {
        const rollSelect = el('demand-import-roll');
        rollSelect.replaceChildren();

        const currentRoll = allRolls.find(r => r.rollId === currentMachineRollId);
        if (currentRoll) {
            rollSelect.add(new Option(`🎯 当前机台：${currentRoll.rollId} (${currentRoll.rollModel} · ${currentRoll.width}mm · 余${Math.round(currentRoll.currentRemainingLength/1000)}m)`, currentRoll.rollId));
        }

        allRolls.forEach(roll => {
            if (roll.rollId !== currentMachineRollId) {
                rollSelect.add(new Option(`在库母卷：${roll.rollId} (${roll.rollModel} · ${roll.width}mm · 余${Math.round(roll.currentRemainingLength/1000)}m)`, roll.rollId));
            }
        });

        rollSelect.add(new Option('🌐 不限母卷 (显示文件中全部型号)', 'ALL'));

        if (currentMachineRollId && currentRoll) {
            rollSelect.value = currentMachineRollId;
        } else if (allRolls.length > 0) {
            rollSelect.value = allRolls[0].rollId;
        } else {
            rollSelect.value = 'ALL';
        }
    };
    initRollOptions();

    const getSelectedRoll = () => {
        const val = el('demand-import-roll').value;
        if (val === 'ALL') return null;
        return allRolls.find(r => r.rollId === val) || null;
    };

    const fail = error => {
        el('demand-import-error').hidden = false;
        el('demand-import-error').textContent = error.message;
        el('demand-import-status').textContent = '尚未导入，请核对后重试。';
    };

    const getEvaluatedList = () => {
        if (!result || !result.groups.length) return [];
        const roll = getSelectedRoll();
        return evaluateModelMatches(result.groups, roll, allRolls);
    };

    // 渲染裁片明细表
    const renderPreviewDetails = index => {
        activePreviewIndex = index;
        const group = result?.groups[index];
        el('demand-import-preview').hidden = !group;
        if (!group) return;

        el('demand-import-preview-title').textContent = `【${group.materialModel}】裁片明细预览`;
        el('demand-import-count').textContent = `${group.demands.length} 项需求 · ${group.demands.reduce((n, d) => n + d.quantity, 0)} 件`;
        el('demand-import-rule').textContent = result.format.startsWith('9.28')
            ? '沿用 RH 横裁口径：幅宽方向 = 裁布高度 × 10；卷长方向 = 每片宽度 × 10；双片数量 × 2。禁止旋转；拼接上限仅供核对，不自动拆片。'
            : '按表内 mm 尺寸和总需求件数导入；不会恢复原任务编号、完成量或库存状态。';
        el('demand-import-rows').innerHTML = group.demands.map(d =>
            `<tr><td>第 ${d.row} 行${d.order ? '<br>' + escapeText(d.order) : ''}</td><td>${escapeText(d.name)}${d.note ? '<small>' + escapeText(d.note) + '</small>' : ''}</td><td>${d.width} × ${d.length}</td><td>${d.quantity}</td></tr>`
        ).join('');
    };

    // 更新底部操作栏与提示
    const updateFooter = () => {
        const issuesBlocked = result?.issues?.length > 0 && !el('demand-import-skip')?.checked;
        const count = checkedIndices.size;
        el('demand-import-checked-count').textContent = count;

        if (count === 0) {
            el('demand-import-selected-summary').innerHTML = '<span class="muted">请勾选需要导入的材料型号</span>';
            apply.disabled = true;
            apply.textContent = '导入当前任务并排料';
            apply.className = 'tool-btn active';
            batchBtn.style.display = 'none';
        } else if (count === 1) {
            const idx = [...checkedIndices][0];
            const g = result.groups[idx];
            const qty = g.demands.reduce((n, d) => n + d.quantity, 0);
            el('demand-import-selected-summary').innerHTML = `已选型号：<strong>${escapeText(g.materialModel)}</strong> (${g.demands.length} 项需求 · ${qty} 件) · 单选导入工作台排料`;
            apply.disabled = importing || issuesBlocked;
            apply.textContent = '导入当前任务并排料';
            apply.className = 'tool-btn active';
            batchBtn.style.display = 'none';
        } else {
            let totalQty = 0;
            checkedIndices.forEach(idx => {
                totalQty += result.groups[idx]?.demands.reduce((n, d) => n + d.quantity, 0) || 0;
            });
            el('demand-import-selected-summary').innerHTML = `已多选 <strong>${count}</strong> 种型号 (共 ${totalQty} 件裁片) · 建议批量保存为独立切割任务`;
            apply.disabled = importing || issuesBlocked;
            apply.textContent = '合并导入当前任务';
            apply.className = 'tool-btn';
            batchBtn.style.display = 'inline-block';
            batchBtn.disabled = importing || issuesBlocked;
            batchBtn.textContent = `批量创建任务 (${count} 个)`;
        }
    };

    // 渲染型号列表
    const renderModelsList = () => {
        const list = getEvaluatedList();
        el('demand-import-model-count').textContent = list.length;
        const search = el('demand-import-search').value.trim().toLowerCase();
        const onlyMatched = el('demand-import-only-matched').checked && el('demand-import-roll').value !== 'ALL';

        let filtered = list.filter(item => {
            if (search && !item.materialModel.toLowerCase().includes(search)) return false;
            if (onlyMatched && item.matchStatus !== 'MATCHED' && item.matchStatus !== 'OVERSIZE') return false;
            return true;
        });

        // 排序：MATCHED 优先，然后是 OVERSIZE，然后是其他
        filtered.sort((a, b) => {
            const score = s => s === 'MATCHED' ? 3 : s === 'OVERSIZE' ? 2 : s === 'IN_STOCK_OTHER' ? 1 : 0;
            return score(b.matchStatus) - score(a.matchStatus);
        });

        const tbody = el('demand-import-models-rows');
        if (!filtered.length) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;" class="muted">
                当前筛选条件下无匹配型号。${onlyMatched ? '可尝试取消勾选“仅看当前母卷可切型号”或更换母卷。' : ''}
            </td></tr>`;
            updateFooter();
            return;
        }

        tbody.innerHTML = filtered.map(item => {
            const isChecked = checkedIndices.has(item.index);
            const isActive = activePreviewIndex === item.index;
            let badgeState = item.matchStatus === 'MATCHED' ? 'CONFIRMED' : item.matchStatus === 'OVERSIZE' ? 'CANCELLED' : item.matchStatus === 'IN_STOCK_OTHER' ? 'PENDING' : 'MUTED';
            return `<tr class="import-model-row ${isActive ? 'active' : ''}" data-index="${item.index}">
                <td style="text-align:center;"><input type="checkbox" class="model-checkbox" data-index="${item.index}" ${isChecked ? 'checked' : ''}></td>
                <td class="import-model-name">${escapeText(item.materialModel)}</td>
                <td class="import-model-stat">${item.demandCount} 项 / ${item.totalQuantity} 件</td>
                <td class="import-model-stat">${item.maxWidth} mm</td>
                <td><span class="ui-status" data-state="${badgeState}">${escapeText(item.statusText)}</span></td>
            </tr>`;
        }).join('');

        // 绑定行点击与勾选事件
        tbody.querySelectorAll('.import-model-row').forEach(row => {
            const idx = Number(row.dataset.index);
            const checkbox = row.querySelector('.model-checkbox');

            checkbox.addEventListener('change', event => {
                event.stopPropagation();
                if (checkbox.checked) checkedIndices.add(idx);
                else checkedIndices.delete(idx);
                renderPreviewDetails(idx);
                updateFooter();
            });

            row.addEventListener('click', event => {
                if (event.target === checkbox) return;
                tbody.querySelectorAll('.import-model-row').forEach(r => r.classList.remove('active'));
                row.classList.add('active');
                renderPreviewDetails(idx);
                if (checkedIndices.size === 0) {
                    checkbox.checked = true;
                    checkedIndices.add(idx);
                }
                updateFooter();
            });
        });

        updateFooter();
    };

    const render = () => {
        el('demand-import-status').textContent = source + ' · ' + result.format;
        el('demand-import-roll-filter-bar').hidden = false;
        el('demand-import-models-wrapper').hidden = false;

        const issues = el('demand-import-issues');
        issues.hidden = !result.issues.length;
        issues.innerHTML = result.issues.length
            ? `<details open><summary>${result.issues.length} 行无法导入</summary><ul>${result.issues.map(item => `<li>第 ${item.row} 行 · ${escapeText(item.model || '未填型号')}：${escapeText(item.message)}</li>`).join('')}</ul></details><label class="import-checkbox-label"><input id="demand-import-skip" type="checkbox">已核对，跳过以上行，仅导入有效需求</label>`
            : '';
        el('demand-import-skip')?.addEventListener('change', updateFooter);

        // 默认勾选完全匹配当前母卷的型号；若无，勾选第一项
        const evaluated = getEvaluatedList();
        const matched = evaluated.find(e => e.matchStatus === 'MATCHED');
        const defaultIndex = matched ? matched.index : (evaluated[0]?.index ?? 0);

        checkedIndices.clear();
        if (evaluated.length > 0) {
            checkedIndices.add(defaultIndex);
            renderPreviewDetails(defaultIndex);
        }

        renderModelsList();
    };

    const parseSheet = () => {
        result = null;
        checkedIndices.clear();
        apply.disabled = true;
        batchBtn.style.display = 'none';
        el('demand-import-error').hidden = true;
        el('demand-import-preview').hidden = true;
        el('demand-import-issues').hidden = true;
        el('demand-import-roll-filter-bar').hidden = true;
        el('demand-import-models-wrapper').hidden = true;

        try {
            const sheet = el('demand-import-sheet').value;
            if (workbook.Sheets[sheet]['!fullref']) throw new Error('工作表超过 10000 行，请按批次拆分；未导入任何数据。');
            result = parseDemandSheet(window.XLSX.utils.sheet_to_json(workbook.Sheets[sheet], {header: 1, defval: '', raw: true}));
            source = el('demand-import-file').files[0].name + ' / ' + sheet;
            render();
        } catch (error) { fail(error); }
    };

    el('demand-import-file').onchange = async event => {
        const file = event.target.files[0], token = ++version;
        result = null; workbook = null; checkedIndices.clear();
        apply.disabled = true; batchBtn.style.display = 'none';
        el('demand-import-preview').hidden = true; el('demand-import-issues').hidden = true;
        el('demand-import-sheet-label').hidden = true; el('demand-import-error').hidden = true;
        el('demand-import-roll-filter-bar').hidden = true; el('demand-import-models-wrapper').hidden = true;

        if (!file) return;
        el('demand-import-status').textContent = '正在读取 ' + file.name;

        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请按批次拆分后导入。');
            source = file.name;
            if (/\.json$/i.test(file.name)) {
                const value = JSON.parse(await file.text());
                if (token !== version || !dialog.open) return;
                result = parseDemandJSON(value);
                render();
            } else {
                if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('请选择 .xlsx、.csv 或 .json 文件。');
                const xlsx = await loadSpreadsheetLibrary(), bytes = await file.arrayBuffer();
                if (token !== version || !dialog.open) return;
                workbook = xlsx.read(bytes, {type: 'array', sheetRows: 10002});
                el('demand-import-sheet').replaceChildren(...workbook.SheetNames.map(name => new Option(name, name)));
                el('demand-import-sheet-label').hidden = workbook.SheetNames.length < 2;
                parseSheet();
            }
        } catch (error) { if (token === version) fail(error); }
    };

    // 母卷筛选切换与搜索
    el('demand-import-roll').onchange = () => {
        renderModelsList();
        // 如果当前预览的型号不再匹配，切换到第一个可见项
        const evaluated = getEvaluatedList();
        const matched = evaluated.find(e => e.matchStatus === 'MATCHED');
        if (matched) renderPreviewDetails(matched.index);
    };
    el('demand-import-only-matched').onchange = renderModelsList;
    el('demand-import-search').oninput = renderModelsList;
    el('demand-import-sheet').onchange = parseSheet;

    // 全选与清空
    el('demand-import-select-all').onclick = () => {
        const rows = el('demand-import-models-rows').querySelectorAll('.model-checkbox');
        rows.forEach(cb => {
            cb.checked = true;
            checkedIndices.add(Number(cb.dataset.index));
        });
        updateFooter();
    };

    el('demand-import-clear-selection').onclick = () => {
        const rows = el('demand-import-models-rows').querySelectorAll('.model-checkbox');
        rows.forEach(cb => cb.checked = false);
        checkedIndices.clear();
        updateFooter();
    };

    dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => { version++; dialog.remove(); });

    // 单选导入当前任务并排料
    apply.onclick = async () => {
        if (apply.disabled || checkedIndices.size === 0) return;
        const indices = [...checkedIndices];
        const token = version;
        importing = true;
        const inputs = [...dialog.querySelectorAll('input,select,button')];
        inputs.forEach(input => input.disabled = true);
        el('demand-import-error').hidden = true;

        try {
            let task;
            if (indices.length === 1) {
                task = importedTask(result, indices[0], source);
            } else {
                // 合并导入模式：将多个型号合并为一个复合任务
                const groups = indices.map(i => result.groups[i]);
                const combinedDemands = [];
                let dId = 1;
                groups.forEach(g => {
                    g.demands.forEach(d => {
                        combinedDemands.push({
                            id: dId++,
                            name: d.order ? `订单 ${d.order} · ${g.materialModel} · ${d.name}` : `[${g.materialModel}] ${d.name}`,
                            width: d.width,
                            length: d.length,
                            quantity: d.quantity,
                            allowRotation: d.allowRotation
                        });
                    });
                });
                task = {
                    name: `${source} · 合并 ${groups.length} 种型号`,
                    materialModel: groups[0].materialModel,
                    externalRef: source,
                    demands: combinedDemands
                };
            }

            if (await importDemandTask(task, () => dialog.open && token === version)) {
                // 若选择了特定母卷，自动对齐主工作台材料母卷
                const selectedRoll = getSelectedRoll();
                if (selectedRoll) {
                    const rollSelect = document.getElementById('sel-mother-roll-id');
                    if (rollSelect && [...rollSelect.options].some(o => o.value === selectedRoll.rollId)) {
                        rollSelect.value = selectedRoll.rollId;
                    }
                }
                dialog.close();
                openDemandManager();
            }
        } catch (error) { fail(error); }
        finally {
            importing = false;
            if (dialog.open) { inputs.forEach(input => input.disabled = false); updateFooter(); }
        }
    };

    // 批量创建任务（针对勾选了多个型号）
    batchBtn.onclick = async () => {
        if (batchBtn.disabled || checkedIndices.size < 2) return;
        const indices = [...checkedIndices];
        const token = version;
        importing = true;
        const inputs = [...dialog.querySelectorAll('input,select,button')];
        inputs.forEach(input => input.disabled = true);
        el('demand-import-error').hidden = true;

        try {
            const bedL = Number(document.getElementById('inp-bed-l')?.value) || 5000;
            const trimStart = Number(document.getElementById('inp-trim-start')?.value) || 20;
            const cutOrigin = document.getElementById('sel-cut-origin')?.value || 'left-top';
            const firstStage = document.getElementById('sel-first-stage')?.value || 'horizontal';
            const allowRot = document.getElementById('sel-allow-rotation')?.value === '1';
            const allowLong = document.getElementById('sel-allow-longitudinal')?.value === '1';

            let createdTasks = [];
            for (const idx of indices) {
                const group = result.groups[idx];
                const taskPayload = {
                    name: `${source} · ${group.materialModel}`,
                    materialModel: group.materialModel,
                    externalRef: source,
                    process: {
                        bedLength: bedL,
                        trimStart,
                        cutOrigin,
                        firstStageOrientation: firstStage,
                        allowRotation: allowRot,
                        allowLongitudinal: allowLong
                    },
                    demands: group.demands.map(d => ({
                        id: d.id,
                        name: d.order ? `订单 ${d.order} · ${d.name}` : d.name,
                        width: d.width,
                        length: d.length,
                        quantity: d.quantity,
                        allowRotation: d.allowRotation
                    }))
                };

                const res = await fetch('/api/cutting/tasks', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(taskPayload)
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(`保存型号 ${group.materialModel} 失败：${err.message || '服务器错误'}`);
                }
                const saved = await res.json();
                createdTasks.push(saved);
            }

            showToast(`已成功批量创建 ${createdTasks.length} 个切割任务！可在【打开任务】中随时调取排料。`, 'success');

            // 如果当前工作台未排料且无任务，自动载入第一个创建的任务
            if (createdTasks.length > 0 && !state.activeTask) {
                await loadTask(createdTasks[0].id, {skipDraftGuard: true});
            }

            dialog.close();
        } catch (error) { fail(error); }
        finally {
            importing = false;
            if (dialog.open) { inputs.forEach(input => input.disabled = false); updateFooter(); }
        }
    };

    el('demand-import-template').onclick = () => {
        const blob = new Blob(['\ufeff订单编号,材料型号,裁片名称,宽度(mm),长度(mm),数量,允许旋转\r\n示例订单,请填写真实型号,示例裁片,600,800,2,否\r\n'], {type: 'text/csv;charset=utf-8'});
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = '需求导入模板.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    if (sample) {
        result = demandSample; source = '9.28 样例';
        dialog.querySelector('.import-file').hidden = true;
        render();
        el('demand-import-status').textContent = '9.28 Excel · 100 项有效需求 / 156 件 · 完整保留客户订单编号、工艺款号与规格尺寸。';
    }
}
