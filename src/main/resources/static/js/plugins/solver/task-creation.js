import {newCuttingTask, taskInputChanged} from './task-workspace.js';
import {openDemandImport} from './demand-import.js';
import {openDemandManager} from '../layout/workbench-panels.js';

export function openNewTask() {
    document.getElementById('new-task-dialog')?.remove();
    const dialog = document.createElement('dialog');dialog.id = 'new-task-dialog';dialog.className = 'action-dialog workbench-dialog new-task-dialog';
    dialog.setAttribute('aria-labelledby','new-task-title');
    dialog.innerHTML = `<form><div class="workbench-dialog-heading"><div><h2 id="new-task-title">新建裁切任务</h2><p>每个任务独立管理一批同型号需求、排料方案和报工。</p></div><button class="tool-btn" type="button" data-cancel>取消</button></div>
        <div class="workbench-dialog-body"><label class="new-task-name">任务名称<input class="prop-input" id="new-task-name" required maxlength="120" value="本次切割" autofocus></label>
        <fieldset class="task-source-options"><legend>需求从哪里开始</legend>
        <label><input type="radio" name="source" value="file" checked><span><strong>导入订单文件</strong><small>现有 Excel、标准表格或任务 JSON</small></span></label>
        <label><input type="radio" name="source" value="sample"><span><strong>使用 9.28 样例</strong><small>按 Excel 的实际尺寸与数量分组，新建一份独立任务</small></span></label>
        <label><input type="radio" name="source" value="manual"><span><strong>手动填写需求</strong><small>从空白任务开始添加裁片</small></span></label></fieldset><p id="new-task-error" role="alert"></p></div>
        <div class="workbench-dialog-footer"><button class="tool-btn active" type="submit">新建并导入需求</button></div></form>`;
    document.body.append(dialog);dialog.showModal();
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.addEventListener('keydown',event => event.stopPropagation());
    const submit = dialog.querySelector('[type=submit]');
    dialog.addEventListener('change',() => {submit.textContent = ({file:'新建并导入需求',sample:'新建并选择样例',manual:'新建并填写需求'})[dialog.querySelector('[name=source]:checked').value];});
    dialog.querySelector('form').onsubmit = async event => {
        event.preventDefault();if (submit.disabled) return;
        const name = dialog.querySelector('#new-task-name').value.trim();
        if (!name) {dialog.querySelector('#new-task-error').textContent = '请填写任务名称';return;}
        const source = dialog.querySelector('[name=source]:checked').value;
        submit.disabled = true;
        // Close before the existing draft-protection dialog so focus cannot escape its active modal.
        dialog.close();
        if (await newCuttingTask()) {
            document.getElementById('task-name').value = name;taskInputChanged();
            if (source === 'manual') openDemandManager();else openDemandImport({sample:source === 'sample'});
        }
        dialog.remove();
    };
}
