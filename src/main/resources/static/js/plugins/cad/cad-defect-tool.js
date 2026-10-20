import {stage, mainLayer, interactionLayer} from './cad-stage.js';
import {stationCoordinates, stationOrigin, defectFromCenter, RULER_SIZE} from '../../canvas/cad-view.js';
import {toggleMeasureTool} from './cad-measure.js';
import {state} from '../../core/state.js';
import {bus} from '../../core/event-bus.js';
import {showToast} from '../../core/toast.js';
import {saveRollDefect} from '../material/material-manager.js';

let marking = false, guides = null, selected = null, saving = false;
const distanceLabels = [];
const el = id => document.getElementById(id);

export function toggleDefectTool(force = !marking) {
    const data = state.getCurrentCaseData();
    if (force && (!stage || !data.materialAvailable || state.currentCutMode !== 'roll')) {
        showToast('请先装载母卷，再在画布上标记疵点。', 'info');
        return;
    }
    if (force) toggleMeasureTool(false);
    marking = force;
    el('btn-defect-tool').setAttribute('aria-pressed', String(marking));
    el('btn-defect-tool').textContent = marking ? '结束标记' : '标记疵点';
    if (stage) {
        stage.off('.defect');
        stage.draggable(!marking);
        mainLayer.listening(!marking);
        if (marking) {
            stage.on('mousemove.defect', drawPointer);
            stage.on('mouseleave.defect', hidePointer);
            stage.on('click.defect', selectPoint);
        }
    }
    el('konva-container').style.cursor = marking ? 'crosshair' : 'default';
    hidePointer();
}

function pointerPoint() {
    const pointer = stage.getPointerPosition();
    if (!pointer || pointer.x < RULER_SIZE || pointer.y < RULER_SIZE || pointer.x > stage.width() || pointer.y > stage.height()) return null;
    const point = {
        x: Number(((pointer.x - stage.x()) / stage.scaleX()).toFixed(1)),
        y: Number(((pointer.y - stage.y()) / stage.scaleY()).toFixed(1))
    };
    const data = state.getCurrentCaseData();
    return point.x >= 0 && point.x <= data.rollW && point.y >= 0 && point.y <= data.totalRollL ? point : null;
}

function hidePointer() {
    for (const label of distanceLabels) label.hidden = true;
    if (guides) {guides.hide();interactionLayer.batchDraw();}
}

function drawPointer() {
    if (!marking || el('cad-defect-dialog').open) return;
    const point = pointerPoint();
    if (!point) {hidePointer();return;}
    const data = state.getCurrentCaseData(), origin = stationOrigin(data);
    const local = stationCoordinates(point.x, point.y, data), inv = 1 / stage.scaleX();
    if (!guides) {guides = new Konva.Group({listening:false});interactionLayer.add(guides);}
    guides.destroyChildren();
    guides.clip({x:(RULER_SIZE-stage.x())*inv, y:(RULER_SIZE-stage.y())*inv,
        width:(stage.width()-RULER_SIZE)*inv, height:(stage.height()-RULER_SIZE)*inv});
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent-blue').trim();
    const line = (points, name) => guides.add(new Konva.Line({points, name, stroke:color, strokeWidth:1, strokeScaleEnabled:false}));
    line([point.x, point.y, origin.x, point.y], 'defect-distance-x');
    line([point.x, point.y, point.x, origin.y], 'defect-distance-y');
    line([origin.x, point.y-4*inv, origin.x, point.y+4*inv]);
    line([point.x-4*inv, origin.y, point.x+4*inv, origin.y]);
    guides.add(new Konva.Circle({x:point.x, y:point.y, radius:3*inv, fill:color, listening:false}));
    guides.show();guides.moveToTop();interactionLayer.batchDraw();
    if (!distanceLabels.length) {
        for (const axis of ['x', 'y']) {
            const label = document.createElement('span');
            label.id = `cad-defect-distance-${axis}`;label.className = 'cad-defect-distance';
            el('konva-container').parentElement.append(label);
            distanceLabels.push(label);
        }
    }
    const [horizontal, vertical] = distanceLabels;
    horizontal.textContent = `距${origin.label[0]} ${local.x.toFixed(1)} mm`;
    vertical.textContent = `距${origin.label[1]} ${local.y.toFixed(1)} mm`;
    for (const label of distanceLabels) label.hidden = false;
    const px = stage.x()+point.x/inv, py = stage.y()+point.y/inv;
    const clampX = x => Math.max(RULER_SIZE+4, Math.min(x, stage.width()-4));
    const clampY = y => Math.max(RULER_SIZE+4, Math.min(y, stage.height()-4));
    const place = (label, x, y) => {
        label.style.left = Math.max(RULER_SIZE+4, Math.min(x, stage.width()-label.offsetWidth-4))+'px';
        label.style.top = Math.max(RULER_SIZE+4, Math.min(y, stage.height()-label.offsetHeight-4))+'px';
    };
    place(horizontal, (px+clampX(stage.x()+origin.x/inv))/2-horizontal.offsetWidth/2,
        py+(origin.dy < 0 ? -horizontal.offsetHeight-8 : 8));
    place(vertical, px+(origin.dx < 0 ? -vertical.offsetWidth-8 : 8),
        (py+clampY(stage.y()+origin.y/inv))/2-vertical.offsetHeight/2);
    const h = horizontal.getBoundingClientRect(), v = vertical.getBoundingClientRect();
    if (h.left < v.right && h.right > v.left && h.top < v.bottom && h.bottom > v.top)
        place(vertical, vertical.offsetLeft, horizontal.offsetTop+(origin.dy < 0 ? h.height+8 : -v.height-8));
}

function selectPoint(event) {
    if (event.evt.button !== 0 || el('cad-defect-dialog').open) return;
    const point = pointerPoint();
    if (!point) return;
    const data = state.getCurrentCaseData(), origin = stationOrigin(data);
    selected = {point, data, rollId:data.rollId};
    const local = stationCoordinates(point.x, point.y, data);
    el('cad-defect-source').textContent = `母卷 ${data.rollId}`;
    el('cad-defect-position').textContent = `疵点中心距${origin.label}基准：横向 X ${local.x.toFixed(1)} mm · 竖向 Y ${local.y.toFixed(1)} mm`;
    el('cad-defect-error').textContent = '';
    el('cad-defect-form').reset();
    hidePointer();
    el('cad-defect-dialog').showModal();
    el('cad-defect-form').elements.width.focus();
}

const dialog = el('cad-defect-dialog'), form = el('cad-defect-form');
form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !selected) return;
    try {
        if (selected.data !== state.getCurrentCaseData() || selected.rollId !== selected.data.rollId || state.currentCutMode !== 'roll')
            throw new Error('当前材料已变化，请取消后重新标记。');
        const {point, data, rollId} = selected;
        const defect = defectFromCenter(point, form.elements.width.valueAsNumber, form.elements.height.valueAsNumber, form.elements.margin.valueAsNumber, data);
        saving = true;
        for (const control of form.elements) control.disabled = true;
        el('cad-defect-error').textContent = '';
        await saveRollDefect(rollId, {...defect, defectType:'MANUAL_MARK', typeName:'现场标记', detectionSource:'MANUAL_INSPECT', description:'画布人工标记疵点', avoidanceStrategy:'MUST_AVOID'});
        dialog.close();
        showToast('疵点已保存到母卷档案，请重新排料。', 'success');
    } catch (error) {
        el('cad-defect-error').textContent = error.message;
    } finally {
        saving = false;
        for (const control of form.elements) control.disabled = false;
    }
});
dialog.addEventListener('keydown', event => event.stopPropagation());
dialog.addEventListener('cancel', event => {if (saving) event.preventDefault();});
dialog.addEventListener('close', () => {selected = null;toggleDefectTool(false);el('btn-defect-tool').focus();});
form.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && marking && !dialog.open) {toggleDefectTool(false);el('btn-defect-tool').focus();}
});
bus.on('canvas:tool-changed', () => {if (marking) toggleDefectTool(false);});
for (const event of ['stage:transformed', 'stage:resized', 'theme:changed', 'station:moved']) bus.on(event, drawPointer);
for (const event of ['case:changed', 'mode:changed', 'remnant:loaded']) bus.on(event, () => {
    if (marking) toggleDefectTool(false);
    if (dialog.open && !saving) dialog.close();
});
