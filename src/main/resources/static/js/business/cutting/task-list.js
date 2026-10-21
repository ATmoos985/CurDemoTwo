import {requestJSON} from '../../core/api-request.js';
import {filterTasks,taskLabels,taskLink} from './task-list-model.js';
const el=id=>document.getElementById(id);
let summaries=[],generation=0;
function render() {
    const rows=filterTasks(summaries,el('task-search').value,el('task-status').value);
    el('task-list-summary').textContent=rows.length+' / '+summaries.length+' 个任务';
    el('task-list-empty').hidden=!!rows.length;el('task-rows').replaceChildren();
    for(const row of rows) {
        const tr=document.createElement('tr');tr.dataset.taskId=row.task.id;
        const cell=(text,cls)=>{const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;tr.append(td);return td;};
        const title=cell(''),name=document.createElement('strong');name.textContent=row.task.name;title.append(name);
        const source=document.createElement('small');source.textContent=row.task.externalRef || '无外部单号';title.append(source);
        const id=document.createElement('small');id.textContent=row.task.id;title.append(id);
        cell(row.task.materialModel);
        const status=cell(''),badge=document.createElement('span');badge.dataset.state=row.status;badge.textContent=taskLabels[row.status] || '状态待核对';status.append(badge);
        if(row.expiredCount){const warning=document.createElement('small');warning.textContent=row.expiredCount+' 个预约已过期';status.append(warning);}
        cell(row.completed+' / '+row.total+' 件','numeric');cell(row.reserved+' / '+row.availableToPlan+' 件','numeric');
        const materials=cell('');if(!row.materialReservations?.length)materials.textContent='未占用';
        for(const reservation of row.materialReservations || []) {const line=document.createElement('div');line.textContent=reservation.materialId+' · '+reservation.station;materials.append(line);}
        const action=cell(''),link=document.createElement('a');link.href=taskLink(row);link.textContent={executions:'查看执行与预约',reports:'查看报工',plans:'核对方案',workspace:'进入排料'}[row.nextAction] || '打开任务';action.append(link);
        el('task-rows').append(tr);
    }
    const params=new URLSearchParams();if(el('task-search').value)params.set('q',el('task-search').value);if(el('task-status').value!=='all')params.set('status',el('task-status').value);
    history.replaceState(null,'',location.pathname+(params.size?'?'+params:''));
}
async function refresh() {
    const ticket=++generation;el('refresh-tasks').disabled=true;el('task-list-error').hidden=true;el('task-list-summary').textContent='正在读取…';
    try {const data=await requestJSON('/api/cutting/task-summaries');if(ticket!==generation)return;summaries=data;render();}
    catch(error){if(ticket===generation){el('task-list-error').hidden=false;el('task-list-error').textContent='读取失败：'+error.message+' 已显示的旧列表仅供参考，请刷新后再操作。';el('task-list-summary').textContent='未取得最新数据';}}
    finally {if(ticket===generation)el('refresh-tasks').disabled=false;}
}
const params=new URLSearchParams(location.search);el('task-search').value=params.get('q') || '';if(Object.hasOwn(taskLabels,params.get('status')))el('task-status').value=params.get('status');
el('task-filters').onsubmit=event=>event.preventDefault();el('task-search').oninput=render;el('task-status').onchange=render;el('refresh-tasks').onclick=refresh;
await refresh();
