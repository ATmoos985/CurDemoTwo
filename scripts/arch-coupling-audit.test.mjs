import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  auditRepository,
  extractStaticFrontendImports,
  findCyclicSccs,
  findStronglyConnectedComponents,
  formatMarkdownReport,
  stripJavaCommentsAndStrings,
  stripJsComments,
  toSecondLevelPackage
} from './arch-coupling-audit.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const CLI_PATH = path.join(THIS_DIR, 'arch-coupling-audit.mjs');

function writeFixtureFiles(rootDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
}

function withTempFixture(files, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-coupling-audit-'));
  try {
    writeFixtureFiles(tmpDir, files);
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('Tarjan SCC：准确区分无环 DAG、2 节点互环、3 节点长环与多独立环', () => {
  // 1. 无环 DAG
  const dag = new Map([
    ['A', ['B', 'C']],
    ['B', ['D']],
    ['C', ['D']],
    ['D', []]
  ]);
  assert.deepEqual(findCyclicSccs(dag), []);
  assert.deepEqual(findStronglyConnectedComponents(dag), [['A'], ['B'], ['C'], ['D']]);

  // 2. 2 节点互环
  const pairCycle = {
    A: ['B'],
    B: ['A', 'C'],
    C: []
  };
  assert.deepEqual(findCyclicSccs(pairCycle), [['A', 'B']]);

  // 3. 3 节点长环
  const tripleCycle = {
    N1: ['N2'],
    N2: ['N3'],
    N3: ['N1'],
    Leaf: []
  };
  assert.deepEqual(findCyclicSccs(tripleCycle), [['N1', 'N2', 'N3']]);

  // 4. 多独立环 + 自环 + 枝干节点
  const multiCycles = {
    A: ['B', 'X'],
    B: ['A'],
    C: ['D'],
    D: ['E'],
    E: ['C'],
    S: ['S'],
    X: ['Y'],
    Y: []
  };
  assert.deepEqual(findCyclicSccs(multiCycles), [
    ['A', 'B'],
    ['C', 'D', 'E'],
    ['S']
  ]);
});

test('Java 与 JS 注释/字符串剥离严格保留行号且屏蔽伪引用', () => {
  const javaSample = [
    'package com.example.cutdemotwo.business.cutting;',
    '// com.example.cutdemotwo.contracts.jobs.FakeA synchronized',
    '/* multi-line',
    '   FakeB synchronized',
    '*/',
    'class Demo {',
    '  String a = "FakeC synchronized /* not comment */";',
    '  String b = """',
    '     FakeD synchronized',
    '  """;',
    '  synchronized void realLock() {}',
    '}'
  ].join('\n');

  const strippedJava = stripJavaCommentsAndStrings(javaSample);
  assert.equal(strippedJava.split('\n').length, javaSample.split('\n').length);
  assert.doesNotMatch(strippedJava, /FakeA|FakeB|FakeC|FakeD/);
  const syncLines = strippedJava
    .split('\n')
    .map((line, i) => (/\bsynchronized\b/.test(line) ? i + 1 : null))
    .filter(Boolean);
  assert.deepEqual(syncLines, [11]);

  const jsSample = [
    '// import { ghost } from "./ghost";',
    '/* export * from "./ghost2"; */',
    'const url = "http://localhost/not-a-comment";',
    'const re = /\\/\\//g;',
    'import {',
    '  realFn',
    '} from "./real";',
    'export { realFn } from "./reexport";'
  ].join('\n');

  const strippedJs = stripJsComments(jsSample);
  assert.equal(strippedJs.split('\n').length, jsSample.split('\n').length);
  const imports = extractStaticFrontendImports(jsSample);
  assert.deepEqual(
    imports.map((i) => ({ specifier: i.specifier, line: i.line, kind: i.kind })),
    [
      { specifier: './real', line: 5, kind: 'import' },
      { specifier: './reexport', line: 8, kind: 're-export' }
    ]
  );

  assert.equal(toSecondLevelPackage('com.example.cutdemotwo'), '(root)');
  assert.equal(toSecondLevelPackage('com.example.cutdemotwo.persistence'), 'persistence');
  assert.equal(toSecondLevelPackage('com.example.cutdemotwo.contracts.jobs'), 'contracts.jobs');
  assert.equal(toSecondLevelPackage('com.example.cutdemotwo.algorithm.nesting.constraints'), 'algorithm.nesting');
});

test('合成临时目录 fixture 端到端检出全部环与热点，并屏蔽注释/字符串/测试/vendor 伪告警', () => {
  const longJavaBody = Array.from({ length: 1015 }, (_, i) => `    // filler ${i + 1}`).join('\n');
  const longTsBody = Array.from({ length: 1010 }, (_, i) => `export const v${i} = ${i};`).join('\n');

  withTempFixture(
    {
      // 1. 后端 2 级子包 3 节点环：contracts.alpha -> contracts.beta -> contracts.gamma -> contracts.alpha
      'src/main/java/com/example/cutdemotwo/contracts/alpha/AlphaContract.java': [
        'package com.example.cutdemotwo.contracts.alpha;',
        'import com.example.cutdemotwo.contracts.beta.BetaContract;',
        'public class AlphaContract { BetaContract b; }'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/contracts/beta/BetaContract.java': [
        'package com.example.cutdemotwo.contracts.beta;',
        'public class BetaContract {',
        '  com.example.cutdemotwo.contracts.gamma.GammaContract g;',
        '}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/contracts/gamma/GammaContract.java': [
        'package com.example.cutdemotwo.contracts.gamma;',
        'import com.example.cutdemotwo.contracts.alpha.*;',
        'public class GammaContract { AlphaContract a; }'
      ].join('\n'),

      // 2. 后端 business.* 类级 2 节点环（ServiceA <-> ServiceB）+ 伪引用无环类 CleanService
      'src/main/java/com/example/cutdemotwo/business/cutting/ServiceA.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'public class ServiceA {',
        '  private ServiceB b;',
        '  // CleanService 注释里提到不算引用',
        '  private String note = "CleanService 字符串里提到不算引用";',
        '  public synchronized void runLocked() {',
        '    synchronized (this) {}',
        '  }',
        longJavaBody,
        '}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/cutting/ServiceB.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'public class ServiceB {',
        '  private ServiceA a;',
        '  // synchronized 注释里的关键字不应误报',
        '  String msg = "synchronized 字符串里不应误报";',
        '}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/cutting/CleanService.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'public class CleanService {',
        '  private ServiceA a;',
        '  // ServiceBHelper 子串不应误判为 ServiceB',
        '  private Object ServiceBHelper;',
        '}'
      ].join('\n'),

      // 3. business.model 互引必须被排除出 business.* 类环统计
      'src/main/java/com/example/cutdemotwo/business/model/ModelX.java': [
        'package com.example.cutdemotwo.business.model;',
        'public class ModelX { ModelY y; }'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/model/ModelY.java': [
        'package com.example.cutdemotwo.business.model;',
        'public class ModelY { ModelX x; }'
      ].join('\n'),

      // 4. 前端 tsconfig paths + 3 节点循环 import（a.ts -> b/index.tsx -> c.ts -> @/a）
      'frontend/tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] }
        }
      }),
      'frontend/src/a.ts': [
        '// import { fake } from "./c";',
        'import { bVal } from "./b";',
        'export const aVal = bVal + 1;'
      ].join('\n'),
      'frontend/src/b/index.tsx': [
        'export { cVal } from "../c";',
        'export const bVal = 2;'
      ].join('\n'),
      'frontend/src/c.ts': [
        'import { aVal } from "@/a";',
        'import { useStudioStore } from "./store/useStudioStore";',
        'export const cVal = aVal + (useStudioStore ? 1 : 0);',
        longTsBody
      ].join('\n'),
      'frontend/src/store/useStudioStore.ts': 'export const useStudioStore = () => ({});\n',
      'frontend/src/pages/DemoPage.tsx': [
        'import { useStudioStore } from "../store/useStudioStore";',
        'export const DemoPage = () => useStudioStore();'
      ].join('\n'),

      // 5. 测试文件与 vendor 中的环与大文件必须被排除
      'frontend/src/pages/DemoPage.test.ts': [
        'import { useStudioStore } from "../store/useStudioStore";',
        'export const t = useStudioStore;'
      ].join('\n'),
      'frontend/src/__tests__/loopA.ts': 'import { b } from "./loopB"; export const a = b;',
      'frontend/src/__tests__/loopB.ts': 'import { a } from "./loopA"; export const b = a;',
      'frontend/src/vendor/huge.js': longTsBody,

      // 6. 故意越界的 WorkbenchBoardCanvas.tsx
      'frontend/src/components/WorkbenchBoardCanvas.tsx': [
        'import { useStudioStore } from "../store/useStudioStore";',
        'export async function loadBad() {',
        '  // /api/comment-ignored',
        '  return fetch("/api/v2/bad");',
        '}',
        'export const ref = useStudioStore;'
      ].join('\n')
    },
    (tmpDir) => {
      const report = auditRepository(tmpDir);

      // 结论应不通过
      assert.equal(report.summary.verdict, 'FAIL');
      assert.equal(report.summary.satisfiesLowerTriangularMatrix, false);
      assert.equal(report.summary.totalCycles, 3);

      // 后端 2 级子包 3 节点环
      assert.equal(report.backendPackages.cycles.length, 1);
      assert.deepEqual(report.backendPackages.cycles[0].nodes, [
        'contracts.alpha',
        'contracts.beta',
        'contracts.gamma'
      ]);
      assert.equal(report.backendPackages.cycles[0].edges.length, 3);

      // 后端 business.* 类环（仅 ServiceA <-> ServiceB，不含 CleanService 和 business.model）
      assert.equal(report.backendBusinessClasses.cycles.length, 1);
      assert.deepEqual(report.backendBusinessClasses.cycles[0].nodes, [
        'business.cutting.ServiceA',
        'business.cutting.ServiceB'
      ]);

      // 前端 3 节点环（含 tsconfig @/* 与 index.tsx 解析，排除 __tests__）
      assert.equal(report.frontend.cycles.length, 1);
      assert.deepEqual(report.frontend.cycles[0].nodes, [
        'frontend/src/a.ts',
        'frontend/src/b/index.tsx',
        'frontend/src/c.ts'
      ]);

      // >1000 行超大文件清单（仅 ServiceA.java 与 c.ts，vendor/huge.js 已排除）
      assert.deepEqual(
        report.hotspots.largeFiles.map((f) => f.file),
        [
          'src/main/java/com/example/cutdemotwo/business/cutting/ServiceA.java',
          'frontend/src/c.ts'
        ]
      );
      assert.ok(report.hotspots.largeFiles[0].lines > 1000);
      assert.ok(report.hotspots.largeFiles[1].lines > 1000);

      // useStudioStore 直接扇入（c.ts, DemoPage.tsx, WorkbenchBoardCanvas.tsx；排除 test）
      assert.equal(report.hotspots.useStudioStoreFanIn.count, 3);
      assert.deepEqual(
        report.hotspots.useStudioStoreFanIn.files.map((f) => f.file),
        [
          'frontend/src/c.ts',
          'frontend/src/components/WorkbenchBoardCanvas.tsx',
          'frontend/src/pages/DemoPage.tsx'
        ]
      );

      // 后端 synchronized 精确行号（仅 ServiceA 第 6、7 行，ServiceB 注释/字符串零误报）
      assert.deepEqual(
        report.hotspots.backendSynchronized.map((h) => ({ file: h.file, line: h.line, kind: h.kind })),
        [
          {
            file: 'src/main/java/com/example/cutdemotwo/business/cutting/ServiceA.java',
            line: 6,
            kind: 'method'
          },
          {
            file: 'src/main/java/com/example/cutdemotwo/business/cutting/ServiceA.java',
            line: 7,
            kind: 'block'
          }
        ]
      );

      // 通用画布边界校验：应检出 store import 与 /api/ 调用，且忽略第 3 行注释
      assert.equal(report.hotspots.canvasBoundary.passed, false);
      assert.equal(report.hotspots.canvasBoundary.importsStore, true);
      assert.equal(report.hotspots.canvasBoundary.callsApi, true);
      assert.deepEqual(
        report.hotspots.canvasBoundary.violations.map((v) => ({ line: v.line, rule: v.rule })),
        [
          { line: 1, rule: 'canvas-no-store-import' },
          { line: 4, rule: 'canvas-no-api-call' }
        ]
      );

      // CLI --fail-on-cycle 在有环时必须返回退出码 1，且 --format json / md 输出完整
      const failRun = spawnSync(
        process.execPath,
        [CLI_PATH, '--root', tmpDir, '--format', 'json', '--fail-on-cycle'],
        { encoding: 'utf8' }
      );
      assert.equal(failRun.status, 1);
      const parsedJson = JSON.parse(failRun.stdout);
      assert.equal(parsedJson.summary.totalCycles, 3);

      const mdOutputPath = path.join(tmpDir, 'reports', 'audit.md');
      const mdRun = spawnSync(
        process.execPath,
        [CLI_PATH, '--root', tmpDir, '--format', 'md', '--output', mdOutputPath],
        { encoding: 'utf8' }
      );
      assert.equal(mdRun.status, 0);
      const mdText = fs.readFileSync(mdOutputPath, 'utf8');
      assert.match(mdText, /仅提供只读诊断，绝不自动修改任何业务代码/);
      assert.match(mdText, /不通过/);
      assert.match(mdText, /contracts\.alpha/);
      assert.match(mdText, /ServiceA\.java:6/);
    }
  );
});

test('无环干净 fixture 验证注释伪引用零误报与 --fail-on-cycle 返回 0', () => {
  withTempFixture(
    {
      'src/main/java/com/example/cutdemotwo/contracts/common/BaseProblem.java': [
        'package com.example.cutdemotwo.contracts.common;',
        '// com.example.cutdemotwo.contracts.jobs.JobEnvelope 不应误报',
        'public interface BaseProblem {}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/contracts/jobs/JobEnvelope.java': [
        'package com.example.cutdemotwo.contracts.jobs;',
        'import com.example.cutdemotwo.contracts.common.BaseProblem;',
        'public record JobEnvelope(BaseProblem problem) {}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/cutting/Facade.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'public class Facade {',
        '  private Worker worker;',
        '}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/cutting/Worker.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'public class Worker {',
        '  // Facade 在注释中出现',
        '  String s = "Facade 在字符串中出现";',
        '}'
      ].join('\n'),
      'frontend/src/store/studioTypes.ts': 'export interface Draft { id: string; }\n',
      'frontend/src/store/useStudioStore.ts': [
        'import type { Draft } from "./studioTypes";',
        'export const useStudioStore = (): Draft => ({ id: "1" });'
      ].join('\n'),
      'frontend/src/components/WorkbenchBoardCanvas.tsx': [
        '// 不允许 import useStudioStore 或调用 /api/foo',
        'export const WorkbenchBoardCanvas = () => null;'
      ].join('\n')
    },
    (tmpDir) => {
      const report = auditRepository(tmpDir);
      assert.equal(report.summary.verdict, 'PASS');
      assert.equal(report.summary.satisfiesLowerTriangularMatrix, true);
      assert.equal(report.summary.totalCycles, 0);
      assert.equal(report.hotspots.canvasBoundary.passed, true);

      const passRun = spawnSync(
        process.execPath,
        [CLI_PATH, '--root', tmpDir, '--format', 'md', '--fail-on-cycle'],
        { encoding: 'utf8' }
      );
      assert.equal(passRun.status, 0);
      assert.match(passRun.stdout, /通过（满足下三角无环设计矩阵）/);
    }
  );
});

test('边界场景：无分号/同行多条 import、UTF-8 BOM、他包同名类显式遮蔽与静态导入', () => {
  const compactJs = [
    '\uFEFFimport a from "./a"',
    'import b from "./b";import type { C } from "./c";',
    'export * as ns from "./ns"',
    'import "./side-effect";',
    'export function demo() { return "from \'./not-an-import\'"; }'
  ].join('\n');

  const extracted = extractStaticFrontendImports(compactJs.replace(/^\uFEFF/, ''));
  assert.deepEqual(
    extracted.map((e) => ({ specifier: e.specifier, line: e.line, kind: e.kind, isTypeOnly: e.isTypeOnly })),
    [
      { specifier: './a', line: 1, kind: 'import', isTypeOnly: false },
      { specifier: './b', line: 2, kind: 'import', isTypeOnly: false },
      { specifier: './c', line: 2, kind: 'import', isTypeOnly: true },
      { specifier: './ns', line: 3, kind: 're-export', isTypeOnly: false },
      { specifier: './side-effect', line: 4, kind: 'import', isTypeOnly: false }
    ]
  );

  withTempFixture(
    {
      // 同包有 ShadowTarget，但 Caller 显式导入了其他包的 ShadowTarget，不能误判为同包环
      'src/main/java/com/example/cutdemotwo/business/cutting/ShadowTarget.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'public class ShadowTarget { Caller c; }'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/cutting/Caller.java': [
        'package com.example.cutdemotwo.business.cutting;',
        'import java.external.ShadowTarget;',
        'public class Caller { ShadowTarget externalRef; }'
      ].join('\n'),
      // 跨业务子包通过 import static 构成真实类环
      'src/main/java/com/example/cutdemotwo/business/alpha/AlphaSvc.java': [
        'package com.example.cutdemotwo.business.alpha;',
        'import static com.example.cutdemotwo.business.beta.BetaSvc.ping;',
        'public class AlphaSvc { void run() { ping(); } }'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/business/beta/BetaSvc.java': [
        'package com.example.cutdemotwo.business.beta;',
        'public class BetaSvc {',
        '  public static void ping() { com.example.cutdemotwo.business.alpha.AlphaSvc.class.getName(); }',
        '}'
      ].join('\n')
    },
    (tmpDir) => {
      const report = auditRepository(tmpDir);
      assert.deepEqual(
        report.backendBusinessClasses.cycles.map((c) => c.nodes),
        [['business.alpha.AlphaSvc', 'business.beta.BetaSvc']]
      );
      assert.deepEqual(
        report.backendPackages.cycles.map((c) => c.nodes),
        [['business.alpha', 'business.beta']]
      );
    }
  );
});

test('CLI 参数校验：非法格式返回退出码 2', () => {
  const badRun = spawnSync(process.execPath, [CLI_PATH, '--format', 'yaml'], {
    encoding: 'utf8'
  });
  assert.equal(badRun.status, 2);
  assert.match(badRun.stderr, /不支持的输出格式/);
});

test('真实仓库根目录只读冒烟测试：稳定运行并输出完整结构与 Markdown 报告', () => {
  const report = auditRepository(REPO_ROOT);

  assert.equal(report.readOnly, true);
  assert.ok(report.backendPackages.scannedFiles > 50, '应扫描到真实后端 Java 源码文件');
  assert.ok(report.backendPackages.packageCount >= 10, '应识别出多个后端 2 级子包');
  assert.ok(report.backendBusinessClasses.scannedClasses >= 15, '应扫描到多个非模型业务类');
  assert.ok(report.frontend.scannedModules >= 30, '应扫描到多个前端生产源码模块');
  assert.equal(report.hotspots.canvasBoundary.exists, true);
  assert.equal(report.hotspots.canvasBoundary.passed, true);

  const md = formatMarkdownReport(report);
  assert.match(md, /# MIT 公理设计架构耦合体检报告（只读）/);
  assert.match(md, /仅提供只读诊断，绝不自动修改任何业务代码/);
  assert.match(md, /## 一、核心裁决/);
  assert.match(md, /## 二、量化指标汇总/);
  assert.match(md, /## 三、实质隐患与事实证据/);
});
