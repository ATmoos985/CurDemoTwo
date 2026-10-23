import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceRoute,WORKSPACE_GROUPS} from '../../main/resources/static/js/workspace/workspace-routes.js';
const origin='http://localhost:8080';
test('workspace routes preserve object identity and remove only embedding flags',()=>{
    assert.deepEqual(workspaceRoute('/index.html?taskId=T%20A&view=reports&workspace=1&embed=1',origin),{id:'workbench',name:'二维排料与切割',url:'/index.html?taskId=T+A&view=reports'});
    assert.equal(workspaceRoute('/inspection.html?roll=A#defect',origin).url,'/inspection.html?roll=A#defect');
    assert.equal(workspaceRoute('/cutting.html',origin).id,'workbench');
    assert.equal(workspaceRoute('/counts.html',origin).id,'counts');
    assert.ok(!WORKSPACE_GROUPS.flatMap(group=>group.items).some(item=>item.id==='counts'),'单据分支不堆叠为顶层导航');
});
test('workspace never turns external, executable, API or download URLs into tabs',()=>{
    for(const url of ['https://example.com/index.html','http://127.0.0.1:8080/index.html','javascript:alert(1)','/api/rolls','/api/linear/tasks/1/export','/workspace.html'])assert.equal(workspaceRoute(url,origin),null,url);
});
test('workspace menu contains one identity per real application',()=>{
    const items=WORKSPACE_GROUPS.flatMap(g=>g.items);assert.equal(new Set(items.map(i=>i.id)).size,items.length);
    for(const id of ['workbench','linear','marker','tasks','inventory','transfers','inspection','analysis','settings'])assert.ok(items.some(item=>item.id===id));
});
