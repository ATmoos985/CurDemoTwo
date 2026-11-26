import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('../../../frontend/', import.meta.url));
const frontendSrc = path.join(frontendRoot, 'src');
const libRoot = path.join(frontendSrc, 'lib');
const staticRoot = fileURLToPath(new URL('../../main/resources/static/', import.meta.url));

async function walkFiles(dir, predicate) {
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walkFiles(full, predicate);
        return predicate(e.name, full) ? [full] : [];
    }))).flat();
}

function references(code) {
    // Literal imports/re-exports, including dynamic import used by hosts.
    return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g)]
        .map(m => m[2]);
}

test('every frontend/src/lib module resolves its relative imports', async () => {
    const all = await walkFiles(libRoot, name => name.endsWith('.js'));
    assert.ok(all.length > 0, 'frontend/src/lib 应包含迁入的共享模块');
    for (const file of all) {
        for (const ref of references(await readFile(file, 'utf8'))) {
            if (ref.startsWith('.')) {
                await assert.doesNotReject(
                    access(path.resolve(path.dirname(file), ref)),
                    `${path.relative(libRoot, file)} -> ${ref}`
                );
            }
        }
    }
});

test('canvas core imports only canvas core and cannot load or write business data', async () => {
    const canvas = path.join(libRoot, 'canvas');
    const all = await walkFiles(canvas, name => name.endsWith('.js'));
    assert.ok(all.length > 0);
    for (const file of all) {
        const code = await readFile(file, 'utf8');
        for (const ref of references(code)) {
            assert.ok(ref.startsWith('.'), `${file}: unexpected external dependency ${ref}`);
            const relative = path.relative(canvas, path.resolve(path.dirname(file), ref));
            assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file} -> ${ref}`);
        }
        assert.doesNotMatch(
            code,
            /\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|\/api\//,
            `${file}: transport and persistence belong to the host`
        );
    }
});

test('static directory strictly keeps only api-v2 and app with clean Vite output and valid entry assets', async () => {
    const rootEntries = (await readdir(staticRoot)).sort();
    assert.deepEqual(
        rootEntries,
        ['api-v2', 'app'],
        `src/main/resources/static/ 顶层仅允许 ['api-v2', 'app']，当前发现：${JSON.stringify(rootEntries)}`
    );

    const appDir = path.join(staticRoot, 'app');
    const appEntries = await readdir(appDir);
    assert.ok(!appEntries.includes('js'), 'src/main/resources/static/app/ 不得残留 js/ 目录');
    assert.ok(!appEntries.includes('dist'), 'src/main/resources/static/app/ 不得残留 dist/ 目录');
    assert.ok(!appEntries.includes('app.css'), 'src/main/resources/static/app/ 不得残留未打包的 app.css');

    const html = await readFile(path.join(appDir, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"]/g)].map(m => m[1]);
    const links = [...html.matchAll(/<link\b[^>]*\bhref=['"]([^'"]+)['"]/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, 'static/app/index.html 应包含 Vite 构建产物脚本引用');
    assert.match(html, /<script\b[^>]*\btype=['"]module['"]/, 'static/app/index.html 应使用 ESM 模块脚本入口');

    const resolveAsset = ref => {
        const clean = ref.split('?')[0].split('#')[0];
        if (clean.startsWith('/')) return path.resolve(staticRoot, clean.slice(1));
        return path.resolve(appDir, clean);
    };

    for (const ref of [...scripts, ...links]) {
        if (/^(?:https?:|data:|mailto:|javascript:)|^\/\//.test(ref)) continue;
        await assert.doesNotReject(access(resolveAsset(ref)), `static/app/index.html -> ${ref}`);
    }
});

test('import guard recognizes static imports, exports and dynamic imports', () => {
    assert.deepEqual(
        references(`import {x} from './a.js'; export * from './b.js';
        import('./c.js'); import './d.js';`),
        ['./a.js', './b.js', './c.js', './d.js']
    );
});

test('frontend sources and configs have zero @static aliases and no LegacyPageHost references', async () => {
    const srcFiles = await walkFiles(
        frontendSrc,
        (name, full) => /\.(ts|tsx|js|css)$/.test(name) && !full.includes(`${path.sep}vendor${path.sep}`)
    );
    const tsFiles = srcFiles.filter(f => /\.(ts|tsx)$/.test(f));
    assert.ok(tsFiles.length >= 13, 'expected full suite of native React pages');

    const configFiles = [
        path.join(frontendRoot, 'vite.config.ts'),
        path.join(frontendRoot, 'vitest.config.ts'),
        path.join(frontendRoot, 'tsconfig.json'),
        path.join(frontendRoot, 'index.html')
    ];

    for (const file of [...srcFiles, ...configFiles]) {
        const code = await readFile(file, 'utf8');
        assert.doesNotMatch(code, /@static\b/, `${path.relative(frontendRoot, file)} 不得残留 @static 引用`);
        assert.doesNotMatch(code, /LegacyPageHost/, `${path.relative(frontendRoot, file)} 不得引用 LegacyPageHost`);
    }
});
