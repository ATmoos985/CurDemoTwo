import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../main/resources/static/js/', import.meta.url));
async function files(dir) {
    const entries = await readdir(dir, {withFileTypes:true});
    return (await Promise.all(entries.map(e => e.isDirectory() ? files(path.join(dir,e.name))
        : e.name.endsWith('.js') ? [path.join(dir,e.name)] : []))).flat();
}
function references(code) {
    // Literal imports/re-exports, including dynamic import used by hosts.
    return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g)]
        .map(m => m[2]);
}
test('every static application module resolves its relative imports', async () => {
    const all = await files(root);
    assert.ok(all.length > 0);
    for (const file of all) for (const ref of references(await readFile(file,'utf8'))) {
        if (ref.startsWith('.')) await assert.doesNotReject(access(path.resolve(path.dirname(file),ref)),
            `${path.relative(root,file)} -> ${ref}`);
    }
});
test('canvas core imports only canvas core and cannot load or write business data', async () => {
    const canvas = path.join(root,'canvas');
    const all = await files(canvas);
    assert.ok(all.length > 0);
    for (const file of all) {
        const code = await readFile(file,'utf8');
        for (const ref of references(code)) {
            assert.ok(ref.startsWith('.'), `${file}: unexpected external dependency ${ref}`);
            const relative = path.relative(canvas,path.resolve(path.dirname(file),ref));
            assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file} -> ${ref}`);
        }
        assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|\/api\//,
            `${file}: transport and persistence belong to the host`);
    }
});
test('HTML entry scripts resolve after module migration', async () => {
    const staticRoot = path.dirname(root);
    const pages = (await readdir(staticRoot)).filter(p => p.endsWith('.html'));
    assert.ok(pages.length > 0);
    for (const page of pages) {
        const html = await readFile(path.join(staticRoot,page),'utf8');
        for (const match of html.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"]/g)) {
            const ref = match[1];
            if (/^(https?:)?\/\//.test(ref)) continue;
            await assert.doesNotReject(access(path.join(staticRoot,ref.split('?')[0])), `${page} -> ${ref}`);
        }
    }
});
test('import guard recognizes static imports, exports and dynamic imports', () => {
    assert.deepEqual(references(`import {x} from './a.js'; export * from './b.js';
        import('./c.js'); import './d.js';`), ['./a.js','./b.js','./c.js','./d.js']);
});
