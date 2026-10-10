// Run with: node --test src/test/js/workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const elements = new Map();
globalThis.document = { getElementById: id => elements.get(id) || null, querySelectorAll: () => [] };
const { toggleSectionCollapse, switchRightPanelTab } = await import('../../main/resources/static/js/plugins/layout/splitter.js');
const { selectRemnant } = await import('../../main/resources/static/js/plugins/cad/cad-remnant-highlight.js');
const { state } = await import('../../main/resources/static/js/core/state.js');

function element(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        style: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        classList: {
            contains: name => classes.has(name),
            toggle(name, force = !classes.has(name)) {
                if (force) classes.add(name); else classes.delete(name);
                return force;
            }
        }
    };
}

test('section disclosure exposes its actual state to keyboard and screen-reader users', () => {
    const section = element(['collapsed']);
    const button = element();
    button.closest = () => section;
    section.querySelector = () => button;
    toggleSectionCollapse(button);
    assert.equal(section.classList.contains('collapsed'), false);
    assert.equal(button.attributes['aria-expanded'], 'true');
    toggleSectionCollapse(button);
    assert.equal(section.classList.contains('collapsed'), true);
    assert.equal(button.attributes['aria-expanded'], 'false');
});

test('result and cut detail switches preserve one visible pane and matching selected state', () => {
    for (const id of ['tab-right-cut', 'tab-right-balance', 'tab-pane-cut', 'tab-pane-balance']) elements.set(id, element());
    for (const selected of ['cut', 'balance']) {
        switchRightPanelTab(selected);
        for (const pane of ['cut', 'balance']) {
            assert.equal(elements.get(`tab-pane-${pane}`).style.display, pane === selected ? 'flex' : 'none');
            assert.equal(elements.get(`tab-right-${pane}`).attributes['aria-pressed'], String(pane === selected));
        }
    }
});

test('selecting a remnant from the drawing opens the expected-remnant tab', () => {
    const data = state.getCurrentCaseData(), before = data.remnants, opened = [];
    window.openRemnantModal = tab => opened.push(tab);
    data.remnants = [{id:'ui-check',x:0,y:0,w:500,l:600,area:.3}];
    try {
        selectRemnant('ui-check', {showToastMsg:false});
        assert.deepEqual(opened,['expected']);
        selectRemnant('ui-check', {showToastMsg:false,switchTab:false});
        assert.equal(opened.length,1);
        data.remnants[0].confirmed=true;
        selectRemnant('ui-check', {showToastMsg:false});
        assert.deepEqual(opened,['expected','stock']);
    } finally {data.remnants=before;delete window.openRemnantModal;}
});

test('current-station framing stays centered in both narrow and wide viewports', async () => {
    const { fitBounds } = await import('../../main/resources/static/js/plugins/cad/cad-view.js');
    const data = state.getCurrentCaseData();
    for (const [width, height] of [[280, 320], [620, 490], [1100, 720]]) {
        const { scale, x, y } = fitBounds(width, height, {
            x: 0, y: data.windowStartY || 0, width: data.rollW, height: data.bedL
        });
        const top = y + (data.windowStartY || 0) * scale;
        assert.ok(scale > 0);
        assert.ok(x >= 28 && x + data.rollW * scale <= width);
        assert.ok(top >= 28 && top + data.bedL * scale <= height);
        assert.ok(Math.abs(x + data.rollW * scale / 2 - width / 2) < width * .12);
    }
});

test('a remnant plan with zero mother-roll usage is distinct from an empty plan', async () => {
    elements.clear();
    const usage = element();
    elements.set('lbl-deduct-len', usage);
    const { updateUIInfo } = await import('../../main/resources/static/js/plugins/solver/solver-client.js');
    const data = state.getCurrentCaseData();
    const before = { totalArea: data.totalArea, deductLen: data.deductLen, pieces: data.pieces };
    try {
        Object.assign(data, { totalArea: 3.2, deductLen: 0, pieces: [] });
        updateUIInfo();
        assert.equal(usage.innerText, '0 mm');
        data.totalArea = 0;
        updateUIInfo();
        assert.equal(usage.innerText, '—');
    } finally { Object.assign(data, before); }
});
