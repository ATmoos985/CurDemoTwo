import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from '../../main/resources/static/js/plugins/solver/task-drafts.js';

function storage() {
    const values = new Map();
    return {get length() { return values.size; }, key:i => [...values.keys()][i],
        getItem:k => values.get(k) ?? null, setItem:(k,v) => values.set(k,v), removeItem:k => values.delete(k)};
}
const draft = (id, updatedAt = 1) => ({version:1, id, updatedAt, task:{name:'未完成录入', demands:[{id:7,width:'',length:'123.4',quantity:'2'}]}});

test('drafts preserve incomplete fields and each retained task independently', () => {
    const store = createDraftStore(storage());
    store.write(draft('first')); store.write(draft('second', 2));
    assert.equal(store.read('first').task.demands[0].width, '');
    assert.deepEqual(store.list().map(d => d.id), ['second', 'first']);
    store.remove('second');
    assert.equal(store.read('first').task.demands[0].length, '123.4');
});

test('corrupt or unsupported entries never erase other drafts', () => {
    const memory = storage(), store = createDraftStore(memory);
    store.write(draft('ok'));
    memory.setItem('cutting-demand-draft:broken', '{');
    memory.setItem('cutting-demand-draft:future', JSON.stringify({...draft('future'), version:99}));
    assert.deepEqual(store.list().map(d => d.id), ['ok']);
    assert.equal(memory.getItem('cutting-demand-draft:broken'), '{');
});

test('storage failure is surfaced and leaves the previously persisted draft intact', () => {
    const memory = storage(), store = createDraftStore(memory);
    store.write(draft('first'));
    memory.setItem = () => { throw new Error('quota exceeded'); };
    assert.throws(() => store.write({...draft('first'), task:{name:'new', demands:[]}}), /quota/);
    assert.equal(store.read('first').task.name, '未完成录入');
});
