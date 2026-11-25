import test from 'node:test';
import assert from 'node:assert/strict';
import {STATUS, PRESET_FIELDS, INDUSTRIES, CAPABILITIES, industryOfScenario, matchPreset, presets, describePreset, scenarioRules}
    from '../../main/resources/static/js/industry/industry-profiles.js';

test('statuses stay inside the three agreed levels and every rule is explained', () => {
    for (const industry of INDUSTRIES) {
        assert.ok(industry.rules.length >= 6, industry.id);
        for (const rule of industry.rules) {
            assert.ok(rule.status in STATUS, `${industry.id}/${rule.name}`);
            if (rule.status !== 'none') assert.ok(rule.where, `${industry.id}/${rule.name} 缺少入口说明`);
        }
        assert.ok(industry.rules.some(r => r.status === 'none'), `${industry.id} 应如实列出未支持项`);
    }
});

test('industryOfScenario maps 2D scenarios to their industry profile and ignores 1D scenarios', () => {
    const listed = INDUSTRIES.filter(i => i.dimension === '二维').flatMap(i => i.scenarios.map(s => s.key));
    assert.ok(listed.length > 0);
    assert.equal(new Set(listed).size, listed.length);
    assert.equal(industryOfScenario('GARMENT_SHIRT').id, 'garment');
    assert.equal(industryOfScenario(3).id, 'curtain');
    assert.equal(industryOfScenario('BOARD_GRAIN').id, 'board');
    assert.equal(industryOfScenario('film'), null);
});

test('every capability declares a valid status and target reference', () => {
    const scenarioKeys = new Set(INDUSTRIES.filter(i => i.dimension === '二维').flatMap(i => i.scenarios.map(s => String(s.key))));
    for (const item of CAPABILITIES) {
        assert.ok(item.status in STATUS, item.id);
        if (item.dimension === '二维') assert.ok(scenarioKeys.has(String(item.demo)), `${item.id} 的演示键 ${item.demo} 未登记`);
        else assert.ok(Boolean(item.link), `${item.id} 缺少链接`);
    }
});

test('workbench presets carry valid integer field values', () => {
    for (const {key, options} of PRESET_FIELDS) {
        for (const preset of presets()) {
            const value = preset.values[key];
            assert.ok(Number.isInteger(value), `${preset.id}.${key}`);
            if (options) assert.ok(String(value) in options);
            else assert.ok(value >= 0, `${preset.id}.${key}=${value}`);
        }
    }
});

test('a settings snapshot maps back to its preset, and any edit falls back to custom', () => {
    for (const preset of presets()) {
        assert.equal(matchPreset(preset.values), preset.id);
        assert.equal(matchPreset({...preset.values, defectMargin: preset.values.defectMargin + 1}), '');
    }
    assert.equal(new Set(presets().map(p => p.id)).size, presets().length);
    assert.equal(matchPreset({...presets()[0].values, allowRotation: '0', minRemnantWidth: '200'}), 'curtain');
    assert.deepEqual(describePreset(presets()[0].values).slice(0, 3).map(d => d.text), ['20 mm', '0 mm', '禁止旋转']);
});

test('board presets differ only by the rotation rule', () => {
    const [plain, grain] = ['board-plain', 'board-grain'].map(id => presets().find(p => p.id === id).values);
    assert.deepEqual({...plain, allowRotation: 0}, grain);
    assert.equal(plain.allowRotation, 1);
});

test('scenario rules report what the current standard input really uses', () => {
    const problem = {material: {shape: {width: 1220, height: 2440}, continuesAfterRegion: false, exclusions: [{}]},
        parts: [{allowRotation: false}, {allowRotation: true}],
        process: {mode: 'GUILLOTINE', feedMode: 'SHEET', trimStart: 0, minReusableWidth: 100, minReusableHeight: 100}};
    const rows = Object.fromEntries(scenarioRules(problem).map(r => [r.name, r.value]));
    assert.equal(rows['排料方式'], '矩形贯通切割');
    assert.equal(rows['材料'], '1220 × 2440 mm · 整块材料');
    assert.equal(rows['裁片旋转'], '1 / 2 种允许 90° 旋转');
    assert.equal(rows['禁入区'], '1 处（疵点 / 缺陷）');
    assert.equal(rows['最小回收'], '100 × 100 mm');
    const contour = scenarioRules({...problem, process: {...problem.process, mode: 'CONTOUR'}}).map(r => r.name);
    assert.ok(!contour.includes('最小回收') && !contour.includes('入口修边'));
});
