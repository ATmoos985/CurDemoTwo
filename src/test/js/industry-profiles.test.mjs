import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ENTRIES, navGroups} from '../../main/resources/static/js/product-entries.js';
import {STATUS, PRESET_FIELDS, INDUSTRIES, CAPABILITIES, industryOfScenario, matchPreset, presets, describePreset, scenarioRules}
    from '../../main/resources/static/js/industry/industry-profiles.js';

const staticDir = fileURLToPath(new URL('../../main/resources/static/', import.meta.url));
const read = name => fs.readFileSync(staticDir + name, 'utf8');
const pages = fs.readdirSync(staticDir).filter(name => name.endsWith('.html'));

test('every entry points at a real page and every nav host names a known entry', () => {
    assert.equal(new Set(ENTRIES.map(e => e.id)).size, ENTRIES.length);
    for (const item of ENTRIES) assert.ok(fs.existsSync(staticDir + item.href.slice(1)), `${item.href} 不存在`);
    const hosts = new Map();
    for (const page of pages) for (const [, id] of read(page).matchAll(/data-product-nav="([^"]+)"/g)) hosts.set(id, page);
    for (const [id, page] of hosts) assert.ok(ENTRIES.some(e => e.id === id), `${page} 的导航标识 ${id} 未登记`);
    for (const item of ENTRIES) assert.equal(hosts.get(item.id), item.href.slice(1), `${item.id} 页面缺少对应导航宿主`);
});

test('navigation exposes the five unified product destinations on every page', () => {
    for (const active of ENTRIES.map(e => e.id)) {
        const items=navGroups(active).flatMap(g=>g.items);
        assert.deepEqual(items.map(item=>item.name), ['介绍','二维裁切','一维裁切','功能演示','跑布验疵']);
        assert.deepEqual(items.map(item=>item.href), ['/intro.html','/cutting.html','/linear.html','/demos.html','/inspection.html']);
    }
});

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

test('lab scenarios listed for industries are exactly the options of the scenario selector', () => {
    const html = read('nesting.html'), select = html.match(/<select id="scenario-select"[\s\S]*?<\/select>/)[0];
    const options = [...select.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    const listed = INDUSTRIES.filter(i => i.dimension === '二维').flatMap(i => i.scenarios.map(s => s.key));
    assert.deepEqual([...listed].sort(), [...options].sort());
    assert.equal(industryOfScenario('GARMENT_SHIRT').id, 'garment');
    assert.equal(industryOfScenario(3).id, 'curtain');
    assert.equal(industryOfScenario('BOARD_GRAIN').id, 'board');
    assert.equal(industryOfScenario('film'), null);
});

test('every capability opens a real lab scenario (2D) or a registered page (1D)', () => {
    const select = read('nesting.html').match(/<select id="scenario-select"[\s\S]*?<\/select>/)[0];
    const options = [...select.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    const hrefs = ENTRIES.map(e => e.href);
    for (const item of CAPABILITIES) {
        assert.ok(item.status in STATUS, item.id);
        if (item.dimension === '二维') assert.ok(options.includes(String(item.demo)), `${item.id} 的演示键 ${item.demo} 不在场景演示中`);
        else assert.ok(hrefs.includes(String(item.link).split(/[?#]/)[0]), `${item.id} 的链接 ${item.link} 未登记`);
    }
});

test('workbench presets fit the form constraints so saving them never fails validation', () => {
    const html = read('index.html');
    for (const {key, id, options} of PRESET_FIELDS) {
        const tag = html.match(new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`))?.[0];
        assert.ok(tag, `${id} 不在设置面板中`);
        for (const preset of presets()) {
            const value = preset.values[key], attr = name => tag.match(new RegExp(`${name}="([^"]+)"`))?.[1];
            assert.ok(Number.isInteger(value), `${preset.id}.${key}`);
            if (options) assert.ok(String(value) in options);
            else {
                const min = Number(attr('min') ?? 0), step = Number(attr('step') ?? 1);
                assert.ok(value >= min && value <= Number(attr('max')) && (value - min) % step === 0, `${preset.id}.${key}=${value} 违反 ${id} 的范围或步长`);
            }
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
