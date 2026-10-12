import {stage, mainLayer} from './cad-stage.js';
import {stationCoordinates, stationOrigin, defectFromCenter, RULER_SIZE} from './cad-view.js';
import {toggleMeasureTool} from './cad-measure.js';
import {state} from '../../core/state.js';
import {bus} from '../../core/event-bus.js';
import {showToast} from '../../core/toast.js';
import {saveRollDefect} from '../material/material-manager.js';

let marking = false, guides = null, tooltip = null, selected = null, saving = false;
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
    if (tooltip) tooltip.hidden = true;
    if (guides) {guides.hide();mainLayer.batchDraw();}
}

function drawPointer() {
    if (!marking || el('cad-defect-dialog').open) return;
    const point = pointerPoint();
    if (!point) {hidePointer();return;}
    const data = state.getCurrentCaseData(), origin = stationOrigin(data);
    const local = stationCoordinates(point.x, point.y, data), inv = 1 / stage.scaleX();
    if (!guides) {guides = new Konva.Group({listening:false});mainLayer.add(guides);}
    guides.destroyChildren();
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent-red').trim();
    guides.add(new Konva.Line({points:[origin.x, origin.y, point.x, origin.y, point.x, point.y], stroke:color,
        strokeWidth:1.2, strokeScaleEnabled:false, dash:[5*inv, 4*inv]}));
    guides.add(new Konva.Line({points:[point.x-7*inv, point.y, point.x+7*inv, point.y, point.x, point.y, point.x, point.y-7*inv, point.x, point.y+7*inv], stroke:color, strokeWidth:1.5, strokeScaleEnabled:false}));
    guides.show();guides.moveToTop();mainLayer.batchDraw();
    if (!tooltip) {
        tooltip = document.createElement('div');tooltip.id = 'cad-defect-tooltip';tooltip.className = 'cad-defect-tooltip';
        el('konva-container').parentElement.append(tooltip);
    }
    tooltip.textContent = `距${origin.label}基准点\n横向 X ${local.x.toFixed(1)} mm · 竖向 Y ${local.y.toFixed(1)} mm\n点击标记疵点中心 · Esc 退出`;
    tooltip.hidden = false;
    const pointer = stage.getPointerPosition();
    tooltip.style.left = Math.max(RULER_SIZE, Math.min(pointer.x + 16, stage.width() - tooltip.offsetWidth - 8)) + 'px';
    tooltip.style.top = Math.max(RULER_SIZE, Math.min(pointer.y + 16, stage.height() - tooltip.offsetHeight - 8)) + 'px';
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
