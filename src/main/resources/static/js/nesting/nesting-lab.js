import { rectangle, polygon, shapeArea, createNestingScene } from './nesting-scene.js';
import { mountNestingViewer } from './nesting-viewer.js';
import { NestingSession } from './nesting-client.js';
import {scenarioExample} from './scenario-examples.js';

const byId = id => document.getElementById(id);
const session = new NestingSession();
let problem, engines = [], solveToken = 0;
const viewer = mountNestingViewer(byId('nesting-canvas'), {
    onZoom: scale => { byId('zoom-label').textContent = `${(scale * 100).toFixed(1)}%`; },
    onSelect: piece => {
        byId('selected-piece').hidden = !piece;
        if (piece) byId('piece-description').textContent = `${piece.name || piece.id}\n外接尺寸 ${piece.shape.width} × ${piece.shape.height} mm\n左上角 X ${piece.x} · Y ${piece.y} mm\n旋转 ${piece.rotationDegrees}°`;
    }
});

function example(mode) {
    if (mode === 'CONTOUR') return { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 3,
        material: { id: 'POLYGON-1', shape: polygon([{x:0,y:0},{x:1600,y:0},{x:1600,y:900},{x:1000,y:900},{x:1000,y:1600},{x:0,y:1600}]), continuesAfterRegion: false,
            exclusions: [{ id: 1, x: 300, y: 300, shape: rectangle(120,120), clearance: 0 }] },
        parts: [{ id: 1, name: 'L 形裁片', shape: polygon([{x:0,y:0},{x:500,y:0},{x:500,y:200},{x:200,y:200},{x:200,y:500},{x:0,y:500}]), quantity: 8, allowRotation: true },
            { id: 2, name: '三角裁片', shape: polygon([{x:0,y:0},{x:400,y:0},{x:0,y:400}]), quantity: 6, allowRotation: true }],
        process: { mode, feedMode: 'SHEET', startCorner: 'left-top', firstStageOrientation: 'none', trimStart: 0,
            minReusableWidth: 0, minReusableHeight: 0, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' } };
    const crosscut = mode === 'CROSSCUT';
    return { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 3,
        material: { id: 'MATERIAL-1', shape: rectangle(2000, crosscut ? 3000 : 4000), continuesAfterRegion: false,
            exclusions: crosscut ? [] : [{ id: 1, x: 200, y: 1500, shape: rectangle(150, 600), clearance: 50 }] },
        parts: [{ id: 1, name: crosscut ? '整幅裁片' : '矩形裁片', shape: rectangle(crosscut ? 2000 : 1500, crosscut ? 1200 : 3000), quantity: crosscut ? 3 : 1, allowRotation: false }],
        process: { mode, feedMode: 'SHEET', startCorner: 'right-bottom', firstStageOrientation: 'horizontal',
            trimStart: 0, minReusableWidth: 100, minReusableHeight: 100, kerf: 0,
            objective: crosscut ? 'INPUT_ORDER' : 'MAXIMIZE_PIECE_AREA' } };
}
const fieldMap = { 'material-id': p => p.material.id, 'material-width': p => p.material.shape.width,
    'material-height': p => p.material.shape.height, 'feed-mode': p => p.process.feedMode,
    'process-mode': p => p.process.mode, 'start-corner': p => p.process.startCorner,
    'first-orientation': p => p.process.firstStageOrientation, 'trim-start': p => p.process.trimStart,
    'reuse-width': p => p.process.minReusableWidth, 'reuse-height': p => p.process.minReusableHeight,
    'time-limit': p => p.timeLimitSeconds };

function numberInput(name, value, min = 0.1, step = 0.1) {
    const label = document.createElement('label'); label.append(name);
    const input = document.createElement('input'); input.type = 'number'; input.required = true;
    input.min = min; input.step = step; input.value = value;
    label.append(input); return label;
}
function pair(...labels) { const row = document.createElement('div'); row.className = 'lab-pair'; row.append(...labels); return row; }
function rowHeader(name, remove) {
    const header = document.createElement('div'); header.className = 'lab-row-head';
    const label = document.createElement('label'); label.append('名称');
    const input = document.createElement('input'); input.value = name; input.maxLength = 120; label.append(input);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tool-btn';
    button.textContent = '移除'; button.addEventListener('click', () => inputAction(remove)); header.append(label, button); return header;
}
function shapeEditor(value, widthInput, heightInput) {
    const root = document.createElement('div'); root.className = 'shape-editor';
    const label = document.createElement('label'); label.append('轮廓');
    const select = document.createElement('select'); select.className = 'shape-kind';
    for (const [type, title] of [['RECTANGLE', '矩形'], ['POLYGON', '多边形']]) { const option = document.createElement('option'); option.value = type; option.textContent = title; select.append(option); }
    select.value = value.type; label.append(select);
    const pointsLabel = document.createElement('label'); pointsLabel.append('顶点 X, Y · 每行一点，按边界顺序，末点不重复首点');
    const points = document.createElement('textarea'); points.className = 'shape-vertices'; points.spellcheck = false;
    points.value = (value.vertices || []).map(p => `${p.x}, ${p.y}`).join('\n'); pointsLabel.append(points);
    const update = () => {
        pointsLabel.hidden = select.value !== 'POLYGON';
        widthInput.readOnly = heightInput.readOnly = !pointsLabel.hidden;
        if (!pointsLabel.hidden && !points.value) points.value = `0, 0\n${widthInput.value}, 0\n0, ${heightInput.value}`;
    };
    select.addEventListener('change', update); update(); root.append(label, pointsLabel); return root;
}
function readShape(original, root, widthInput, heightInput) {
    const type = root.querySelector('.shape-kind').value;
    if (type === 'RECTANGLE') return { ...original, type, width: widthInput.valueAsNumber, height: heightInput.valueAsNumber,
        ...(original.type === 'POLYGON' ? { vertices: [] } : {}) };
    const text = root.querySelector('.shape-vertices').value.trim();
    // Preserve imported, unexposed vertex fields until the user actually edits this outline.
    if (original.type === 'POLYGON' && text === original.vertices.map(p => `${p.x}, ${p.y}`).join('\n')) return original;
    const vertices = text.split(/\n+/).map(line => {
        const values = line.trim().split(/[,，\s]+/);
        if (values.length !== 2 || values.some(v => v === '' || !Number.isFinite(Number(v)))) throw new Error('每行顶点应为 X, Y 两个数字');
        return { x: Number(values[0]), y: Number(values[1]) };
    });
    const next = { ...original, ...polygon(vertices) };
    widthInput.value = next.width; heightInput.value = next.height; return next;
}
function fillRows() {
    byId('part-rows').replaceChildren();
    problem.parts.forEach((part, index) => {
        const row = document.createElement('div'); row.className = 'lab-row';
        row.append(rowHeader(part.name || '', () => { problem = readForm({ skipPart: index }); problem.parts.splice(index, 1); fillRows(); changed(); }));
        const dimensions = pair(numberInput('裁片宽度', part.shape.width), numberInput('裁片长度', part.shape.height));
        row.append(dimensions);
        const dims = dimensions.querySelectorAll('input'); row.append(shapeEditor(part.shape, dims[0], dims[1]));
        const rotation = document.createElement('label'); rotation.className = 'lab-check';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = part.allowRotation;
        rotation.append(checkbox, '允许 90° 步进旋转');
        row.append(pair(numberInput('需求件数', part.quantity, 1, 1), rotation));
        byId('part-rows').append(row);
    });
    byId('exclusion-rows').replaceChildren();
    (problem.material.exclusions || []).forEach((item, index) => {
        const row = document.createElement('div'); row.className = 'lab-row';
        row.append(pair(numberInput('X 坐标', item.x, 0), numberInput('Y 坐标', item.y, 0)),
            pair(numberInput('区域宽度', item.shape.width), numberInput('区域长度', item.shape.height)), numberInput('外扩距离', item.clearance, 0));
        const dims = row.querySelectorAll('input'); row.append(shapeEditor(item.shape, dims[2], dims[3]));
        const button = document.createElement('button'); button.className = 'tool-btn'; button.type = 'button'; button.textContent = '移除区域';
        button.addEventListener('click', () => inputAction(() => { problem = readForm({ skipExclusion: index }); problem.material.exclusions.splice(index, 1); fillRows(); changed(); }));
        row.append(button); byId('exclusion-rows').append(row);
    });
    byId('exclusion-count').textContent = `${problem.material.exclusions?.length || 0} 处`;
}
function readForm({ skipPart = -1, skipExclusion = -1 } = {}) {
    // Keep fields not exposed in the form (including imported constraints). The API must decide whether they are supported.
    const p = structuredClone(problem), n = id => byId(id).valueAsNumber;
    p.material.id = byId('material-id').value;
    p.material.shape = readShape(p.material.shape, byId('material-shape-editor'), byId('material-width'), byId('material-height'));
    p.material.continuesAfterRegion = byId('continues').checked;
    Object.assign(p.process, { feedMode: byId('feed-mode').value, mode: byId('process-mode').value,
        startCorner: byId('start-corner').value, firstStageOrientation: byId('first-orientation').value,
        trimStart: n('trim-start'), minReusableWidth: n('reuse-width'), minReusableHeight: n('reuse-height') });
    p.timeLimitSeconds = n('time-limit');
    [...byId('part-rows').children].forEach((row, index) => {
        if (index === skipPart) return;
        const inputs = row.querySelectorAll('input'), part = p.parts[index];
        part.name = inputs[0].value; part.shape = readShape(part.shape, row, inputs[1], inputs[2]);
        part.quantity = inputs[3].valueAsNumber; part.allowRotation = inputs[4].checked;
    });
    [...byId('exclusion-rows').children].forEach((row, index) => {
        if (index === skipExclusion) return;
        const inputs = row.querySelectorAll('input'), item = p.material.exclusions[index];
        item.x = inputs[0].valueAsNumber; item.y = inputs[1].valueAsNumber;
        item.shape = readShape(item.shape, row, inputs[2], inputs[3]); item.clearance = inputs[4].valueAsNumber;
    });
    return p;
}
function showError(message) { byId('solve-error').hidden = !message; byId('solve-error').textContent = message; }
function inputAction(action) { try { action(); } catch (error) { showError(error.message); } }
function engineHint() {
    const mode = byId('process-mode').value;
    const capability = engines.find(e => e.modes.includes(mode));
    byId('engine-hint').textContent = capability ? `${mode === 'CROSSCUT' ? '需求宽度须等于材料宽度' : mode === 'CONTOUR' ? '简单多边形 · 单块材料 · 90° 步进旋转' : '支持逐件选择 90° 旋转'} · 精度 ${capability.coordinateResolutionMm} mm${capability.available ? '' : ' · 引擎未就绪'}` : '引擎状态尚未获取，求解时将检查能力。';
}
const area = value => `${(value / 1_000_000).toFixed(3)} m²`;
function results(scene) {
    byId('area-processing').textContent = scene ? area(shapeArea(scene.region.shape)) : '—';
    byId('region-summary').textContent = scene ? `${scene.region.shape.width} × ${scene.region.shape.height} mm` : '请完善输入';
    byId('contour-note').hidden = scene?.process.mode !== 'CONTOUR';
    const metrics = scene?.metrics;
    byId('area-pieces').textContent = metrics ? `${area(metrics.pieceAreaMm2)} / ${(metrics.pieceAreaMm2 / metrics.processingAreaMm2 * 100).toFixed(1)}%` : '—';
    byId('area-leftovers').textContent = metrics ? area(metrics.reusableAreaMm2) : '—';
    byId('area-unassigned').textContent = metrics ? area(metrics.unassignedAreaMm2) : '—';
    byId('fulfillment').replaceChildren();
    if (!scene?.fulfillment.length) byId('fulfillment').textContent = '生成方案后显示排入与未排数量。';
    for (const item of scene?.fulfillment || []) {
        const row = document.createElement('div'); row.className = 'fulfillment-row';
        const name = scene.parts.find(p => p.id === item.demandId)?.name || `需求 ${item.demandId}`;
        row.append(name); const counts = document.createElement('span');
        counts.textContent = `需求 ${item.requested} · 排入 ${item.placed} · 未排 ${item.unplaced}`; row.append(counts); byId('fulfillment').append(row);
    }
    table('placement-list', ['裁片', '左上角 X / Y', '外接宽 × 长'], (scene?.placements || []).map(p => [p.name || p.id, `${p.x} / ${p.y}`, `${p.shape.width} × ${p.shape.height}`]));
    if (scene?.process.mode === 'CONTOUR') table('cut-list', ['裁片编号', '闭合轮廓'], scene.contours.map(c => [c.placementId, `${c.vertices.length} 个顶点（无刀序）`]));
    else table('cut-list', ['刀序', '起点 → 终点'], (scene?.cuts || []).map(c => [c.sequence, `(${c.startX}, ${c.startY}) → (${c.endX}, ${c.endY})`]));
    byId('export-result').disabled = !session.result;
}
function table(id, headings, rows) {
    const node = document.createElement('table'), header = document.createElement('tr');
    for (const title of headings) { const cell = document.createElement('th'); cell.textContent = title; header.append(cell); }
    node.append(header);
    for (const values of rows) { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } node.append(row); }
    byId(id).replaceChildren(node);
}
function changed() {
    solveToken++; byId('solve-button').disabled = false; byId('solve-button').textContent = '生成排料'; showError('');
    if (byId('scenario-select')) byId('scenario-select').value = '';
    try {
        problem = readForm();
        const scene = session.setProblem(problem); viewer.setScene(scene); results(scene);
        byId('solve-status').textContent = '输入已更新，等待排料。';
    } catch (error) {
        session.invalidate(); viewer.setScene(null); results(null); byId('solve-status').textContent = '请完善裁切输入。'; showError(error.message);
    }
    engineHint();
}
function loadProblem(next) {
    const scene = createNestingScene(next);
    if (!next.process || !Array.isArray(next.parts)) throw new Error('缺少工艺参数或需求列表');
    // Supported select values must round-trip; unknown values must not be silently replaced by the browser.
    for (const [id, get] of Object.entries(fieldMap)) if (byId(id).tagName === 'SELECT' && ![...byId(id).options].some(o => o.value === get(next))) throw new Error(`不支持的参数：${get(next)}`);
    problem = structuredClone(next); solveToken++; session.setProblem(problem);
    for (const [id, get] of Object.entries(fieldMap)) byId(id).value = get(problem) ?? '';
    byId('continues').checked = !!problem.material.continuesAfterRegion;
    byId('continues').disabled = problem.process.feedMode === 'SHEET';
    byId('material-shape-editor').replaceChildren(shapeEditor(problem.material.shape, byId('material-width'), byId('material-height')));
    fillRows(); viewer.setScene(scene, { fitView: true }); results(scene); engineHint(); showError('');
    byId('solve-status').textContent = '输入就绪，等待排料。'; byId('solve-button').disabled = false; byId('solve-button').textContent = '生成排料';
}
// A select emits input before change; keep the chosen scenario until its own loader runs.
byId('problem-form').addEventListener('input', event => { if (!event.target.matches('.shape-kind, #scenario-select')) changed(); });
byId('problem-form').addEventListener('change', event => {
    if (!event.target.matches('.shape-kind')) return;
    if (event.target.value === 'POLYGON' && byId('process-mode').value !== 'CONTOUR') {
        byId('process-mode').value = 'CONTOUR'; byId('process-mode').dispatchEvent(new Event('change'));
    } else changed();
});
byId('feed-mode').addEventListener('change', () => {
    byId('continues').disabled = byId('feed-mode').value === 'SHEET';
    if (byId('continues').disabled) byId('continues').checked = false;
    changed();
});
byId('process-mode').addEventListener('change', () => {
    problem.engine = 'auto'; problem.process.objective = byId('process-mode').value === 'CROSSCUT' ? 'INPUT_ORDER' : 'MAXIMIZE_PIECE_AREA';
    if (byId('process-mode').value === 'CONTOUR') {
        byId('feed-mode').value = 'SHEET'; byId('continues').checked = false; byId('continues').disabled = true;
        byId('start-corner').value = 'left-top'; byId('first-orientation').value = 'none';
        for (const id of ['trim-start', 'reuse-width', 'reuse-height']) byId(id).value = 0;
    } else if (byId('process-mode').value === 'CROSSCUT' || byId('first-orientation').value === 'none') byId('first-orientation').value = 'horizontal';
    changed();
});
byId('add-part').onclick = () => inputAction(() => { problem = readForm(); problem.parts.push({ id: Math.max(0, ...problem.parts.map(p => p.id)) + 1, name: '新裁片', shape: rectangle(500, 500), quantity: 1, allowRotation: false }); fillRows(); changed(); });
byId('add-exclusion').onclick = () => inputAction(() => { problem = readForm(); problem.material.exclusions ||= []; problem.material.exclusions.push({ id: Math.max(0, ...problem.material.exclusions.map(d => d.id)) + 1, x: 0, y: 0, shape: rectangle(100, 100), clearance: 20 }); fillRows(); changed(); });
function loadScenario(key) {
    if (byId('scenario-select')) byId('scenario-select').value = key;
    if (key === 'CROSSCUT' || key === 'GUILLOTINE' || key === 'CONTOUR') {
        loadProblem(example(key));
    } else if (key) {
        loadProblem(scenarioExample(Number(key)));
    }
}
byId('scenario-select')?.addEventListener('change', event => loadScenario(event.target.value));
byId('problem-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!byId('problem-form').reportValidity()) return;
    try {
        problem = readForm(); session.setProblem(problem); const token = ++solveToken;
        viewer.setScene(createNestingScene(problem)); results(createNestingScene(problem));
        byId('solve-button').disabled = true; byId('solve-button').textContent = '正在排料…'; byId('solve-status').textContent = '正在求解…'; showError('');
        try {
            const scene = await session.solve();
            if (token !== solveToken || !scene) return;
            viewer.setScene(scene); results(scene);
            const unplaced = scene.fulfillment.reduce((sum, f) => sum + f.unplaced, 0);
            byId('solve-status').textContent = scene.status === 'NO_SOLUTION_FOUND' ? '本次未找到可用布局，可调整需求或工艺后重试。' : `已排入 ${scene.placements.length} 件 · 未排 ${unplaced} 件 · ${session.result.elapsedMs} ms`;
        } catch (error) { if (token === solveToken) { showError(error.message); byId('solve-status').textContent = '求解未完成，请检查输入或引擎状态。'; } }
        finally { if (token === solveToken) { byId('solve-button').disabled = false; byId('solve-button').textContent = '生成排料'; } }
    } catch (error) { showError(error.message); }
});
byId('fit-view').onclick = () => viewer.fit();
byId('zoom-in').onclick = () => viewer.zoom(1.25);
byId('zoom-out').onclick = () => viewer.zoom(1 / 1.25);
byId('show-paths').onchange = event => viewer.setPaths(event.target.checked);
byId('show-dimensions').onchange = event => viewer.setDimensions(event.target.checked);
byId('open-json').onclick = () => inputAction(() => { byId('json-input').value = JSON.stringify(readForm(), null, 2); byId('json-error').textContent = ''; byId('json-dialog').showModal(); });
byId('apply-json').onclick = () => { try { loadProblem(JSON.parse(byId('json-input').value)); if (byId('scenario-select')) byId('scenario-select').value = ''; byId('json-dialog').close(); } catch (error) { byId('json-error').textContent = error.message; } };
function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
byId('export-input').onclick = () => inputAction(() => { if (byId('problem-form').reportValidity()) download('nesting-input.json', readForm()); });
byId('export-result').onclick = () => { if (session.result) download('nesting-result.json', session.result); };
window.addEventListener('pagehide', event => { if (!event.persisted) { session.invalidate(); viewer.destroy(); } });
loadScenario('GUILLOTINE');
fetch('/api/v1/nesting/engines').then(response => { if (!response.ok) throw new Error(); return response.json(); })
    .then(data => { engines = data; engineHint(); }).catch(() => { byId('engine-hint').textContent = '暂时无法读取引擎状态，请检查连接。'; });
