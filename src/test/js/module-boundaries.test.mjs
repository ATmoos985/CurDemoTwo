import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('../../../frontend/', import.meta.url));
const frontendSrc = path.join(frontendRoot, 'src');
const libRoot = path.join(frontendSrc, 'lib');
const staticRoot = fileURLToPath(new URL('../../main/resources/static/', import.meta.url));

async function walkFiles(dir, predicate, options = {}) {
    const { skipDirs = [] } = options;
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (skipDirs.includes(e.name)) return [];
            return walkFiles(full, predicate, options);
        }
        return predicate(e.name, full) ? [full] : [];
    }))).flat();
}

function references(code) {
    // Literal imports/re-exports, including dynamic import used by hosts.
    return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g)]
        .map(m => m[2]);
}

/**
 * 词法级剥离注释（同时保留字符串与模板字面量原样，避免破坏 URL 或正则中的 //），
 * 确保静态 import/re-export 扫描不会被注释中的示例代码误触发。
 */
function stripCommentsPreservingStrings(code) {
    let out = '';
    let i = 0;
    const n = code.length;
    while (i < n) {
        const ch = code[i];
        const next = code[i + 1];
        // 字符串或模板字面量：整体原样保留（模板内插值保留字符）
        if (ch === '\'' || ch === '"' || ch === '`') {
            const quote = ch;
            out += ch;
            i += 1;
            while (i < n) {
                const c = code[i];
                out += c;
                if (c === '\\') {
                    if (i + 1 < n) {
                        out += code[i + 1];
                        i += 2;
                    } else {
                        i += 1;
                    }
                    continue;
                }
                i += 1;
                if (c === quote) break;
            }
            continue;
        }
        // 单行注释
        if (ch === '/' && next === '/') {
            i += 2;
            while (i < n && code[i] !== '\n') i += 1;
            continue;
        }
        // 多行注释（保留换行以免拼合相邻行标识符）
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
                if (code[i] === '\n') out += '\n';
                i += 1;
            }
            i += 2;
            out += ' ';
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

/**
 * 提取文件中的静态 ES Module import 与 re-export 路径（含 import type / export type / 副作用 import）。
 * 通过逐行/语句起始边界匹配，避免把普通字符串字面量里的文本误判为模块依赖。
 */
function extractStaticModuleSpecifiers(code) {
    const clean = stripCommentsPreservingStrings(code);
    const specs = [];
    // 1. import ... from 'spec' 或 export ... from 'spec'（允许跨行）
    const fromRe = /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+)?from\s*(['"])([^'"\n]+)\1/g;
    for (const m of clean.matchAll(fromRe)) {
        specs.push(m[2]);
    }
    // 2. 副作用导入：import 'spec'
    const sideEffectRe = /(?:^|[;\n])\s*import\s*(['"])([^'"\n]+)\1/g;
    for (const m of clean.matchAll(sideEffectRe)) {
        specs.push(m[2]);
    }
    return specs;
}

/** 解析 frontend/tsconfig.json 中的 baseUrl 与 paths 别名规则（兼容 JSONC 注释与尾逗号）。 */
async function loadTsPathRules(rootDir) {
    const tsconfigPath = path.join(rootDir, 'tsconfig.json');
    try {
        const raw = await readFile(tsconfigPath, 'utf8');
        const stripped = stripCommentsPreservingStrings(raw).replace(/,\s*([}\]])/g, '$1');
        const cfg = JSON.parse(stripped);
        const compilerOptions = cfg?.compilerOptions || {};
        const baseDir = compilerOptions.baseUrl
            ? path.resolve(rootDir, compilerOptions.baseUrl)
            : rootDir;
        const paths = compilerOptions.paths || {};
        const rules = [];
        for (const [pattern, targets] of Object.entries(paths)) {
            if (!Array.isArray(targets) || targets.length === 0) continue;
            const starIdx = pattern.indexOf('*');
            rules.push({
                pattern,
                prefix: starIdx >= 0 ? pattern.slice(0, starIdx) : pattern,
                suffix: starIdx >= 0 ? pattern.slice(starIdx + 1) : '',
                hasWildcard: starIdx >= 0,
                targets: targets.map(t => ({
                    raw: t,
                    baseDir
                }))
            });
        }
        return rules;
    } catch {
        return [];
    }
}

/** 将相对路径或 tsconfig paths 别名解析为已知源码文件绝对路径。 */
function resolveFrontendImport(fromFile, specifier, knownFiles, tsPathRules) {
    const candidates = [];

    const pushCandidateBase = (absBase) => {
        candidates.push(absBase);
        // 兼容 TS 中写 .js/.jsx 扩展名但源码为 .ts/.tsx 的场景
        if (/\.(?:js|jsx|mjs)$/.test(absBase)) {
            const stem = absBase.replace(/\.(?:js|jsx|mjs)$/, '');
            candidates.push(`${stem}.ts`, `${stem}.tsx`);
        }
        candidates.push(
            `${absBase}.ts`,
            `${absBase}.tsx`,
            `${absBase}.js`,
            path.join(absBase, 'index.ts'),
            path.join(absBase, 'index.tsx'),
            path.join(absBase, 'index.js')
        );
    };

    if (specifier.startsWith('.')) {
        pushCandidateBase(path.resolve(path.dirname(fromFile), specifier));
    } else {
        for (const rule of tsPathRules) {
            if (rule.hasWildcard) {
                if (specifier.startsWith(rule.prefix) && specifier.endsWith(rule.suffix)) {
                    const matched = specifier.slice(
                        rule.prefix.length,
                        specifier.length - rule.suffix.length
                    );
                    for (const t of rule.targets) {
                        const replaced = t.raw.replace('*', matched);
                        pushCandidateBase(path.resolve(t.baseDir, replaced));
                    }
                }
            } else if (specifier === rule.pattern) {
                for (const t of rule.targets) {
                    pushCandidateBase(path.resolve(t.baseDir, t.raw));
                }
            }
        }
    }

    for (const candidate of candidates) {
        const normalized = path.resolve(candidate);
        if (knownFiles.has(normalized)) return normalized;
    }
    return null;
}

/**
 * Tarjan 强连通分量（SCC）算法：
 * 返回全部形成循环依赖的分量（节点数 > 1 或存在自环 v -> v），保证检出 2 节点互引与任意 N 节点长环。
 */
function findCyclicSccs(adjacency) {
    let nextIndex = 0;
    const indexMap = new Map();
    const lowlinkMap = new Map();
    const onStack = new Set();
    const stack = [];
    const cyclicComponents = [];

    const strongConnect = (v) => {
        indexMap.set(v, nextIndex);
        lowlinkMap.set(v, nextIndex);
        nextIndex += 1;
        stack.push(v);
        onStack.add(v);

        for (const w of adjacency.get(v) || []) {
            if (!indexMap.has(w)) {
                strongConnect(w);
                lowlinkMap.set(v, Math.min(lowlinkMap.get(v), lowlinkMap.get(w)));
            } else if (onStack.has(w)) {
                lowlinkMap.set(v, Math.min(lowlinkMap.get(v), indexMap.get(w)));
            }
        }

        if (lowlinkMap.get(v) === indexMap.get(v)) {
            const component = [];
            let w;
            do {
                w = stack.pop();
                onStack.delete(w);
                component.push(w);
            } while (w !== v);

            const hasSelfLoop = (adjacency.get(v) || []).includes(v);
            if (component.length > 1 || hasSelfLoop) {
                cyclicComponents.push(component.sort());
            }
        }
    };

    for (const node of adjacency.keys()) {
        if (!indexMap.has(node)) {
            strongConnect(node);
        }
    }
    return cyclicComponents;
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

test('Tarjan SCC detector catches 2-node cycles, N-node cycles and ignores DAG / comments', () => {
    // 1. 无环 DAG
    const dag = new Map([
        ['a', ['b', 'c']],
        ['b', ['d']],
        ['c', ['d']],
        ['d', []]
    ]);
    assert.deepEqual(findCyclicSccs(dag), []);

    // 2. 2 节点互引 + 3 节点长环 + 非环附着节点
    const graphWithCycles = new Map([
        ['entry', ['a', 'x']],
        ['a', ['b']],
        ['b', ['a']],
        ['x', ['y']],
        ['y', ['z']],
        ['z', ['x', 'leaf']],
        ['leaf', []]
    ]);
    const cycles = findCyclicSccs(graphWithCycles).sort((c1, c2) => c1[0].localeCompare(c2[0]));
    assert.deepEqual(cycles, [
        ['a', 'b'],
        ['x', 'y', 'z']
    ]);

    // 3. 注释中的伪 import 不得触发误判，真实 static import / re-export 正常提取
    const sampleCode = `
        // import { fake } from './fake-cycle';
        /* export * from './block-comment-fake'; */
        import type { A } from './types';
        export { foo } from './helper';
        import './side-effect';
        const url = 'https://example.com/a//b';
    `;
    assert.deepEqual(extractStaticModuleSpecifiers(sampleCode), [
        './types',
        './helper',
        './side-effect'
    ]);
});

test('frontend/src static import graph has zero circular dependencies (Tarjan SCC gate)', async () => {
    const prodFiles = await walkFiles(
        frontendSrc,
        (name) => /\.(ts|tsx|js)$/.test(name) && !/\.(test|spec)\.(ts|tsx|js)$/.test(name),
        { skipDirs: ['__tests__', 'vendor'] }
    );
    assert.ok(prodFiles.length >= 30, `应扫描到完整 frontend/src 生产源码集合，当前仅 ${prodFiles.length}`);

    const knownFiles = new Set(prodFiles.map(f => path.resolve(f)));
    const tsPathRules = await loadTsPathRules(frontendRoot);
    const adjacency = new Map();

    for (const file of prodFiles) {
        const abs = path.resolve(file);
        const code = await readFile(abs, 'utf8');
        const deps = new Set();
        for (const spec of extractStaticModuleSpecifiers(code)) {
            const target = resolveFrontendImport(abs, spec, knownFiles, tsPathRules);
            if (target) deps.add(target);
        }
        adjacency.set(abs, [...deps]);
    }

    const cyclicSccs = findCyclicSccs(adjacency);
    if (cyclicSccs.length > 0) {
        const detail = cyclicSccs.map((comp, idx) => {
            const compSet = new Set(comp);
            const relNodes = comp.map(f => path.relative(frontendSrc, f).replace(/\\/g, '/'));
            const edges = [];
            for (const u of comp) {
                for (const v of adjacency.get(u) || []) {
                    if (compSet.has(v)) {
                        edges.push(
                            `${path.relative(frontendSrc, u).replace(/\\/g, '/')} -> ${path.relative(frontendSrc, v).replace(/\\/g, '/')}`
                        );
                    }
                }
            }
            return `环 #${idx + 1} (${relNodes.join(' <-> ')}):\n    ${edges.join('\n    ')}`;
        }).join('\n');
        assert.fail(`frontend/src 存在 ${cyclicSccs.length} 组静态循环 import（违反零循环门禁）：\n${detail}`);
    }
});
