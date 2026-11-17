import {MARKER_STYLES} from '../../../js/nesting/marker-demo.js';
import {garmentDemands} from '../../../js/business/cutting/garment-demand-model.js';
import {WORKFLOW_TEMPLATES, workflowTemplate} from './showcase.js';
import {emptyTask, fromTask} from './task-form.js';

export const TASK_PACK_GROUPS = [
    {name: '服装 · M/L 齐套', packs: MARKER_STYLES},
    {name: '通用业务', packs: WORKFLOW_TEMPLATES}
];

export function taskPackForm(id) {
    const style = MARKER_STYLES.find(s => s.id === id);
    if (style) return fromTask({
        name: style.name + ' · M/L 齐套裁切', materialModel: 'TC涤棉-B2026',
        externalRef: '服装案例 · ' + style.name, process: {pieceGap: 5}, demands: garmentDemands(id)
    });
    const template = workflowTemplate(id);
    if (!template) return emptyTask();
    const materialModel = id === 'continuous' ? '窗帘样布-2D' : 'TC涤棉-B2026';
    return fromTask({...template.task, materialModel});
}
