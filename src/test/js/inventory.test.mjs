import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const detail = { innerHTML: '' };
globalThis.document = {
    getElementById: id => id === 'material-roll-detail-panel' ? detail : null,
    querySelectorAll: () => []
};
const { filterInventory, selectRollForDetail } = await import('../../main/resources/static/js/plugins/material/material-manager.js');

test('roll search combines literal keywords with inspection status without changing inventory', () => {
    const rolls = [
        { rollId: 'ROLL-A', materialName: '纯棉', storageLocation: 'A-01', inspectionStatus: 'PASSED' },
        { rollId: 'ROLL-B', materialName: '纯棉', storageLocation: 'B-02', inspectionStatus: 'PENDING' }
    ];
    const before = JSON.stringify(rolls);
    assert.deepEqual(filterInventory(rolls, '  roll  纯棉  A-01 ', 'PASSED', 'rolls'), [rolls[0]]);
    assert.deepEqual(filterInventory(rolls, '', 'PENDING', 'rolls'), [rolls[1]]);
    assert.deepEqual(filterInventory(rolls, '[', '', 'rolls'), []);
    assert.equal(JSON.stringify(rolls), before);
});

test('remnants can be found by parent, source roll and location with defect filtering', () => {
    const rows = [
        { id: 'REM-1', sourceRollId: 'ROLL-A', parentRemnantId: 'PARENT-1', location: 'B-03', hasDefect: true },
        { id: 'REM-2', sourceRollId: 'ROLL-A', hasDefect: false }
    ];
    assert.deepEqual(filterInventory(rows, 'parent-1 B-03', 'defect', 'remnants'), [rows[0]]);
    assert.deepEqual(filterInventory(rows, 'roll-a', 'clean', 'remnants'), [rows[1]]);
    assert.deepEqual(filterInventory([], '', '', 'remnants'), []);
});

test('slow detail responses cannot replace the latest selected roll', async () => {
    const pending = new Map();
    globalThis.fetch = url => new Promise(resolve => pending.set(url, resolve));
    const first = selectRollForDetail('A'), second = selectRollForDetail('B');
    pending.get('/api/rolls/B')({ ok: true, json: async () => ({ rollId: 'B', totalLength: 5000, currentRemainingLength: 0, width: 2000 }) });
    await second;
    assert.match(detail.innerHTML, /<h3>B<\/h3>/);
    assert.match(detail.innerHTML, /<strong>0 <small>m<\/small>/);
    pending.get('/api/rolls/A')({ ok: true, json: async () => ({ rollId: 'A' }) });
    await first;
    assert.match(detail.innerHTML, /<h3>B<\/h3>/);
});

test('detail encodes IDs and escapes stock data; missing fields remain unregistered', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ rollId: 'A/B', materialName: '<img onerror="x">', totalLength: 5000, width: 2000, defects: [{ typeName: '<script>', x: 0, y: 0, w: 20, h: 20, margin: 0, points: 0 }] }) };
    };
    await selectRollForDetail('A/B');
    assert.equal(request.url, '/api/rolls/A%2FB');
    assert.equal(request.options.method, undefined);
    assert.ok(!detail.innerHTML.includes('<img'));
    assert.ok(!detail.innerHTML.includes('<script>'));
    assert.match(detail.innerHTML, /&lt;img onerror=&quot;x&quot;&gt;/);
    assert.match(detail.innerHTML, /<dt>供应商<\/dt><dd>未登记<\/dd>/);
    assert.match(detail.innerHTML, /<dt>避让间距 \(mm\)<\/dt><dd>0<\/dd>/);
});

test('failed detail load clears the previous action instead of offering stale stock', async () => {
    globalThis.fetch = async () => ({ ok: false });
    await selectRollForDetail('missing');
    assert.match(detail.innerHTML, /详情读取失败/);
    assert.ok(!detail.innerHTML.includes('data-mount'));
});
