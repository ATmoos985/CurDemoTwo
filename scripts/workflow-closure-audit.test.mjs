import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  INFRA_HEALTH_PROBE_ENDPOINTS,
  LARGE_SOURCE_FILES_BASELINE,
  LEGACY_NON_V2_ENDPOINTS_BASELINE,
  auditWorkflowClosure,
  extractControllerEndpointsFromSource,
  formatMarkdownReport,
  runCli
} from './workflow-closure-audit.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const CLI_PATH = path.join(THIS_DIR, 'workflow-closure-audit.mjs');

function writeFixtureFiles(rootDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
}

function withTempFixture(files, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-closure-audit-'));
  try {
    writeFixtureFiles(tmpDir, files);
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function createHealthyFixtureFiles(overrides = {}) {
  const base = {
    'src/test/java/com/example/cutdemotwo/persistence/OptimizationTestDatabase.java': `
      package com.example.cutdemotwo.persistence;
      public final class OptimizationTestDatabase {
        public static Object create() { return "jdbc:h2:mem:helper"; }
      }
    `,
    'src/test/java/com/example/cutdemotwo/SampleJdbcTests.java': `
      package com.example.cutdemotwo;
      import org.junit.jupiter.api.Tag;
      import org.junit.jupiter.api.Test;
      @Tag("mysql-integration")
      class SampleJdbcTests {
        @Test void works() { OptimizationTestDatabase.create(); }
      }
    `,
    '.github/workflows/image.yml': `
name: Verify
jobs:
  mysql-integration:
    runs-on: ubuntu-24.04
    steps:
      - run: ./mvnw -B test -Dgroups=mysql-integration
  image:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          node --test integrations/inventory/test/sync-worker.test.mjs
          node --test scripts/arch-coupling-audit.test.mjs
          node scripts/arch-coupling-audit.mjs --fail-on-cycle
          node --test scripts/workflow-closure-audit.test.mjs
          node scripts/workflow-closure-audit.mjs --fail
`,
    'Dockerfile': `
FROM node:22-bookworm-slim AS frontend-tests
RUN node --test integrations/inventory/test/sync-worker.test.mjs \\
    && node --test scripts/arch-coupling-audit.test.mjs \\
    && node scripts/arch-coupling-audit.mjs --fail-on-cycle \\
    && node --test scripts/workflow-closure-audit.test.mjs \\
    && node scripts/workflow-closure-audit.mjs --fail
`,
    'src/main/java/com/example/cutdemotwo/controller/SampleV2Controller.java': `
      package com.example.cutdemotwo.controller;
      import org.springframework.http.MediaType;
      import org.springframework.web.bind.annotation.*;
      @RestController
      @RequestMapping("/api/v2")
      class SampleV2Controller {
        @GetMapping("/capabilities") public Object caps() { return null; }
        @PostMapping(value = "/orders/{orderId}/items", consumes = "application/json")
        public Object createItem() { return null; }
        @GetMapping(value = "/optimization-jobs/{jobId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
        public Object events() { return null; }
      }
    `,
    'src/main/java/com/example/cutdemotwo/controller/LegacyKeepController.java': `
      package com.example.cutdemotwo.controller;
      import org.springframework.web.bind.annotation.*;
      @RestController
      @RequestMapping("/api")
      class LegacyKeepController {
        @GetMapping("/health") public Object health() { return null; }
      }
    `,
    'src/main/resources/static/api-v2/openapi.json': JSON.stringify({
      openapi: '3.1.0',
      paths: {
        '/api/health': { get: { summary: 'health' } },
        '/api/v2/capabilities': { get: { summary: 'caps' } },
        '/api/v2/orders/{orderId}/items': { post: { summary: 'create' } },
        '/api/v2/optimization-jobs/{jobId}/events': { get: { summary: 'events' } }
      }
    }, null, 2),
    'frontend/tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'frontend/src/utils/routeUtils.ts': `
      export const KNOWN_MODERN_ROUTES: readonly string[] = [
        'workbench',
        'inventory'
      ];
    `,
    '.agents/skills/verify-cutdemotwo/SKILL.md': `
# Verify
| Check | Command |
| :--- | :--- |
| Audit | \`node scripts/workflow-closure-audit.mjs --fail\` |
`,
    'scripts/workflow-closure-audit.mjs': '// placeholder for SKILL path check\n',
    '.agents/skills/verify-cutdemotwo/features/README.md': '# Index\n- #/workbench\n- #/inventory\n',
    '.agents/skills/verify-cutdemotwo/features/core-flow.md': `---
routes:
  - workbench
  - inventory
---

# Core Flow
`
  };

  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) {
      delete base[k];
    } else {
      base[k] = v;
    }
  }
  return base;
}

test('基线常量数量与真实仓库基线一致', () => {
  assert.equal(LEGACY_NON_V2_ENDPOINTS_BASELINE.length, 0);
  assert.deepEqual(INFRA_HEALTH_PROBE_ENDPOINTS, ['GET /api/health']);
  assert.equal(LARGE_SOURCE_FILES_BASELINE.length, 0);
});

test('Controller 词法解析器：免疫 {id} 与 consumes 参数、支持数组路径与多方法、屏蔽注释', () => {
  const src = `
    package com.example.cutdemotwo.controller;
    import org.springframework.web.bind.annotation.*;
    import org.springframework.http.MediaType;
    // @GetMapping("/commented-out")
    /* @PostMapping("/block-commented") */
    @RestController
    @RequestMapping("/api/v2")
    class ComplexController {
      @GetMapping
      public Object root() { return null; }

      @PostMapping(value = "/cutting/reports/{id}/quality-dispositions", consumes = "application/json")
      public Object dispose() { return null; }

      @GetMapping(value = "/optimization-jobs/{jobId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
      public Object sse() { return null; }

      @RequestMapping(path = {"/alpha/{aId}", "/beta"}, method = {RequestMethod.GET, RequestMethod.POST})
      public Object multi() { return null; }
    }
  `;
  const parsed = extractControllerEndpointsFromSource(src, 'ComplexController.java');
  assert.equal(parsed.isController, true);
  assert.deepEqual(parsed.unresolvedMappings, []);

  const sigs = parsed.endpoints.map((e) => `${e.method} ${e.path}`);
  assert.deepEqual(sigs, [
    'GET /api/v2',
    'POST /api/v2/cutting/reports/{id}/quality-dispositions',
    'GET /api/v2/optimization-jobs/{jobId}/events',
    'GET /api/v2/alpha/{aId}',
    'POST /api/v2/alpha/{aId}',
    'GET /api/v2/beta',
    'POST /api/v2/beta'
  ]);
  assert.deepEqual(parsed.endpoints[1].paramNames, ['id']);
  assert.deepEqual(parsed.endpoints[2].paramNames, ['jobId']);

  // 非静态字符串表达式应进入 unresolvedMappings，不静默漏报
  const unresolved = extractControllerEndpointsFromSource(`
    @RestController
    @RequestMapping("/api/v2")
    class BadController {
      @GetMapping(PATH_CONST)
      public Object dyn() { return null; }
    }
  `, 'BadController.java');
  assert.equal(unresolved.unresolvedMappings.length, 1);
});

test('全绿合成 Fixture 与基线单向递减兼容性（--fail 返回退出码 0）', () => {
  withTempFixture(createHealthyFixtureFiles(), (tmpDir) => {
    const report = auditWorkflowClosure(tmpDir);
    assert.equal(report.summary.passed, true, JSON.stringify(report.violations));
    assert.equal(report.summary.verdict, 'PASS');
    assert.equal(report.dimensions.apiContract.infraEndpointCount, 1);
    assert.equal(report.dimensions.apiContract.legacyEndpointCount, 0);
    assert.equal(report.dimensions.apiContract.legacyBaselineCount, 0);
    assert.equal(report.dimensions.apiContract.resolvedLegacyCount, 0);
    assert.equal(report.dimensions.archAndLargeFiles.currentLargeFileCount, 0);
    assert.equal(report.dimensions.archAndLargeFiles.largeFileBaselineCount, 0);
    assert.equal(report.dimensions.archAndLargeFiles.resolvedBaselineLargeFiles.length, 0);

    const customReport = auditWorkflowClosure(tmpDir, {
      legacyBaseline: ['GET /api/legacy/sample'],
      largeFilesBaseline: ['frontend/src/components/WorkbenchBoardCanvas.tsx']
    });
    assert.equal(customReport.summary.passed, true);
    assert.equal(customReport.dimensions.apiContract.resolvedLegacyCount, 1);
    assert.deepEqual(
      customReport.dimensions.archAndLargeFiles.resolvedBaselineLargeFiles,
      ['frontend/src/components/WorkbenchBoardCanvas.tsx']
    );

    const res = spawnSync(process.execPath, [CLI_PATH, '--root', tmpDir, '--fail'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /总体裁决.*PASS/);
  });
});

test('维度 A 反例与零误报：漏标 @Tag、硬编码 H2、父类继承与 @SpringBootTest properties={...}', () => {
  // 1. 漏标 @Tag("mysql-integration")
  withTempFixture(
    createHealthyFixtureFiles({
      'src/test/java/com/example/cutdemotwo/MissingTagTests.java': `
        package com.example.cutdemotwo;
        import org.junit.jupiter.api.Test;
        class MissingTagTests {
          @Test void run() { Flyway.configure().load(); }
        }
      `
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      assert.ok(report.violations.some((v) => v.rule === 'missing-mysql-tag' && v.file.endsWith('MissingTagTests.java')));
    }
  );

  // 2. 硬编码 jdbc:h2:mem:
  withTempFixture(
    createHealthyFixtureFiles({
      'src/test/java/com/example/cutdemotwo/HardcodedH2Tests.java': `
        package com.example.cutdemotwo;
        import org.junit.jupiter.api.Tag;
        import org.junit.jupiter.api.Test;
        @Tag("mysql-integration")
        class HardcodedH2Tests {
          @Test void run() {
            String url = "jdbc:h2:mem:fake_db;MODE=MySQL";
            Flyway.configure();
          }
        }
      `
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      assert.ok(report.violations.some((v) => v.rule === 'hardcoded-h2-jdbc' && v.file.endsWith('HardcodedH2Tests.java')));
    }
  );

  // 3. 零误报：抽象父类继承 @Tag + @SpringBootTest(properties={...}) + 注释里的 Flyway.configure()
  withTempFixture(
    createHealthyFixtureFiles({
      'src/test/java/com/example/cutdemotwo/BaseMysqlTest.java': `
        package com.example.cutdemotwo;
        import org.junit.jupiter.api.Tag;
        @Tag("mysql-integration")
        abstract class BaseMysqlTest {}
      `,
      'src/test/java/com/example/cutdemotwo/ChildMysqlTest.java': `
        package com.example.cutdemotwo;
        import org.junit.jupiter.api.Test;
        class ChildMysqlTest extends BaseMysqlTest {
          @Test void run() { OptimizationTestDatabase.create(); }
        }
      `,
      'src/test/java/com/example/cutdemotwo/PropBraceTests.java': `
        package com.example.cutdemotwo;
        import org.junit.jupiter.api.Tag;
        import org.junit.jupiter.api.Test;
        @Tag("mysql-integration")
        @SpringBootTest(properties={"a=1", "b=2"})
        class PropBraceTests {
          @Test void run() { OptimizationTestDatabase.create(); }
        }
      `,
      'src/test/java/com/example/cutdemotwo/CommentOnlyTests.java': `
        package com.example.cutdemotwo;
        import org.junit.jupiter.api.Test;
        class CommentOnlyTests {
          // Flyway.configure(); OptimizationTestDatabase.create();
          // "jdbc:h2:mem:not-real"
          @Test void unitOnly() {}
        }
      `
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, true, JSON.stringify(report.violations));
    }
  );

  // 4. image.yml 使用静态 -Dtest= 白名单且缺少 closure gate；Dockerfile 缺失 sync-worker.test.mjs
  withTempFixture(
    createHealthyFixtureFiles({
      '.github/workflows/image.yml': `
name: Verify
jobs:
  mysql-integration:
    runs-on: ubuntu-24.04
    steps:
      - run: ./mvnw -B test -Dtest="OnlyOneTest"
`,
      'Dockerfile': `
FROM node:22-bookworm-slim AS frontend-tests
RUN npm test --prefix frontend
`
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      const rules = new Set(report.violations.map((v) => v.rule));
      assert.ok(rules.has('ci-missing-mysql-groups'));
      assert.ok(rules.has('ci-static-dtest-whitelist'));
      assert.ok(rules.has('ci-missing-workflow-closure-audit'));
      assert.ok(rules.has('dockerfile-missing-sync-worker-test'));
      assert.ok(rules.has('dockerfile-missing-arch-audit'));
      assert.ok(rules.has('dockerfile-missing-workflow-audit'));
    }
  );
});

test('维度 B 反例：漏写 OpenAPI v2 接口、路径参数名漂移、未登记非 v2 接口、OpenAPI 孤儿端点', () => {
  // 1. 新增 /api/v2/* 未同步 openapi.json + 路径参数名不一致
  withTempFixture(
    createHealthyFixtureFiles({
      'src/main/java/com/example/cutdemotwo/controller/SampleV2Controller.java': `
        package com.example.cutdemotwo.controller;
        import org.springframework.web.bind.annotation.*;
        @RestController
        @RequestMapping("/api/v2")
        class SampleV2Controller {
          @GetMapping("/capabilities") public Object caps() { return null; }
          @PostMapping(value = "/orders/{id}/items", consumes = "application/json")
          public Object createItem() { return null; }
          @PostMapping("/workbench/drafts/{draftId}/confirm")
          public Object confirmDraft() { return null; }
        }
      `
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      const rules = new Set(report.violations.map((v) => v.rule));
      assert.ok(rules.has('v2-missing-in-openapi'));
      assert.ok(rules.has('openapi-param-name-mismatch'));
      assert.ok(rules.has('orphan-openapi-operation'));
    }
  );

  // 2. 新增未登记的非 /api/v2/* 接口
  withTempFixture(
    createHealthyFixtureFiles({
      'src/main/java/com/example/cutdemotwo/controller/BackdoorController.java': `
        package com.example.cutdemotwo.controller;
        import org.springframework.web.bind.annotation.*;
        @RestController
        @RequestMapping("/api")
        class BackdoorController {
          @PostMapping("/legacy-backdoor") public Object backdoor() { return null; }
        }
      `
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      assert.ok(report.violations.some((v) => v.rule === 'unregistered-legacy-endpoint'));
    }
  );

  // 3. 基础设施健康探针缺失 openapi.json -> 拦截 infra-endpoint-missing-in-openapi
  withTempFixture(
    createHealthyFixtureFiles({
      'src/main/resources/static/api-v2/openapi.json': JSON.stringify({
        openapi: '3.1.0',
        paths: {
          '/api/v2/capabilities': { get: { summary: 'caps' } },
          '/api/v2/orders/{orderId}/items': { post: { summary: 'create' } },
          '/api/v2/optimization-jobs/{jobId}/events': { get: { summary: 'events' } }
        }
      }, null, 2)
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      assert.ok(report.violations.some((v) => v.rule === 'infra-endpoint-missing-in-openapi'));
    }
  );
});

test('维度 C 反例与零误报：新增超千行生产文件、测试文件超千行豁免、循环依赖拦截', () => {
  const bigLines = Array.from({ length: 1005 }, (_, i) => `export const x${i} = ${i};`).join('\n');

  // 1. 新增基线外 >1000 行生产源码文件 -> 拦截
  withTempFixture(
    createHealthyFixtureFiles({
      'frontend/src/pages/NewBigPage.tsx': bigLines
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      assert.ok(report.violations.some((v) => v.rule === 'new-large-source-file' && v.file === 'frontend/src/pages/NewBigPage.tsx'));
    }
  );

  // 2. 测试文件 >1000 行 -> 零误报
  withTempFixture(
    createHealthyFixtureFiles({
      'frontend/src/pages/NewBigPage.test.ts': bigLines,
      'src/test/java/com/example/cutdemotwo/BigUnitTests.java': Array.from({ length: 1005 }, (_, i) => `// line ${i}`).join('\n')
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, true, JSON.stringify(report.violations));
    }
  );

  // 3. 引入前端循环依赖 -> 拦截
  withTempFixture(
    createHealthyFixtureFiles({
      'frontend/src/a.ts': `import { b } from './b'; export const a = () => b();`,
      'frontend/src/b.ts': `import { a } from './a'; export const b = () => a();`
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      assert.ok(report.violations.some((v) => v.rule === 'arch-cycle-detected'));
    }
  );
});

test('维度 D 反例：新增路由仅写进 README.md 或完全漏记、SKILL 脚本路径失效', () => {
  // 1. 新增 login / profile 路由，仅写在 features/README.md 中，未写入具体特征文件 -> 拦截
  withTempFixture(
    createHealthyFixtureFiles({
      'frontend/src/utils/routeUtils.ts': `
        export const KNOWN_MODERN_ROUTES: readonly string[] = [
          'workbench',
          'inventory',
          'login',
          'profile'
        ];
      `,
      '.agents/skills/verify-cutdemotwo/features/README.md': '# Index\n- #/workbench\n- #/inventory\n- #/login\n- #/profile\n',
      '.agents/skills/verify-cutdemotwo/SKILL.md': `
# Verify
- \`node integrations/inventory/missing-worker.test.mjs\`
`
    }),
    (tmpDir) => {
      const report = auditWorkflowClosure(tmpDir);
      assert.equal(report.summary.passed, false);
      const missingRoutes = report.violations.filter((v) => v.rule === 'route-missing-verify-feature');
      assert.equal(missingRoutes.length, 2);
      assert.ok(report.violations.some((v) => v.rule === 'broken-verify-skill-path'));
    }
  );
});

test('CLI 参数校验、JSON/MD 输出写文件与真实仓库全量闭环门禁通过', () => {
  const helpCode = runCli(['--help'], {
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(helpCode, 0);

  const badFormat = runCli(['--format', 'xml'], {
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(badFormat, 2);

  const missingRoot = runCli(['--root', path.join(REPO_ROOT, '__non_existent_dir__')], {
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(missingRoot, 2);

  // 真实仓库只读验证（含 --format json --output）
  const outTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-out-'));
  try {
    const jsonOut = path.join(outTmp, 'closure.json');
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, '--root', REPO_ROOT, '--format', 'json', '--output', jsonOut, '--fail'],
      { encoding: 'utf8' }
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    assert.equal(parsed.summary.passed, true, JSON.stringify(parsed.violations));
    assert.equal(parsed.dimensions.testCoverage.taggedTestClassCount, 22);
    assert.equal(parsed.dimensions.apiContract.v2EndpointCount, 115);
    assert.equal(parsed.dimensions.apiContract.infraEndpointCount, 1);
    assert.equal(parsed.dimensions.apiContract.legacyEndpointCount, 0);
    assert.equal(parsed.dimensions.apiContract.openapiOperationCount, 116);
    assert.equal(parsed.dimensions.archAndLargeFiles.totalCycles, 0);
    assert.equal(parsed.dimensions.archAndLargeFiles.currentLargeFileCount, 0);
    assert.equal(parsed.dimensions.archAndLargeFiles.largeFileBaselineCount, 0);
    assert.equal(parsed.dimensions.archAndLargeFiles.resolvedBaselineLargeFiles.length, 0);
    assert.equal(parsed.dimensions.verifyMap.knownModernRouteCount, 18);
    assert.match(formatMarkdownReport(parsed), /四大防遗漏工作流闭环维度全部通过/);
  } finally {
    fs.rmSync(outTmp, { recursive: true, force: true });
  }
});
