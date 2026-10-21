import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTasks,taskLink} from '../../main/resources/static/js/business/cutting/task-list-model.js';
const rows=[{task:{id:'a',name:'裁切 A',materialModel:'TC',externalRef:'ERP-100'},status:'REPORT_PENDING'},
    {task:{id:'b',name:'裁切 B',materialModel:'布料'},status:'PLAN_PENDING'}];
test('task filters combine status and source/name/model search without changing input',()=>{
    assert.deepEqual(filterTasks(rows,' erp-100 ','REPORT_PENDING'),[rows[0]]);
    assert.deepEqual(filterTasks(rows,'TC','PLAN_PENDING'),[]);
    assert.deepEqual(filterTasks(rows,'布料'),[rows[1]]);
    assert.deepEqual(filterTasks(rows),[rows[1],rows[0]]);assert.equal(rows[0].task.id,'a');
});
test('task links encode identity and only open known read views',()=>{
    const row={task:{id:'A&B /中文'},nextAction:'executions'};
    const url=new URL(taskLink(row),'http://localhost');assert.equal(url.searchParams.get('taskId'),row.task.id);
    assert.equal(url.searchParams.get('view'),'executions');
    assert.equal(new URL(taskLink({...row,nextAction:'release'}),'http://localhost').searchParams.has('view'),false);
});
