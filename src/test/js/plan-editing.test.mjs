import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanHistory,planScene} from '../../main/resources/static/js/plugins/solver/plan-editing.js';

test('undo and redo restore geometry and derived cuts without mutating the saved plan', () => {
    const original={pieces:[{id:1,x:0,y:0,w:800,l:1000}],cuts:[{pos:1000}],remnants:[{id:'r',w:100}],cutIntervals:[]};
    const history=createPlanHistory(planScene(original));
    const moved=planScene(original);moved.pieces[0].x=20;moved.cuts=[];moved.remnants=[];
    assert.equal(history.record(moved),true);assert.equal(original.pieces[0].x,0);
    assert.deepEqual(history.undo(),original);assert.equal(history.canUndo,false);assert.equal(history.canRedo,true);
    const redo=history.redo();assert.deepEqual(redo,moved);redo.pieces[0].x=99;
    assert.equal(history.current.pieces[0].x,20);
});
test('a new edit after undo replaces the redo branch and a new plan has its own history', () => {
    const history=createPlanHistory({pieces:[]});history.record({pieces:[{id:1}]});history.record({pieces:[{id:2}]});history.undo();
    history.record({pieces:[{id:3}]});assert.equal(history.canRedo,false);assert.equal(history.redo(),null);
    const next=createPlanHistory(history.current);assert.equal(next.canUndo,false);assert.equal(next.record(next.current),false);
});
