#!/usr/bin/env node
/**
 * 防遗漏工作流闭环门禁 CLI（零第三方依赖，纯静态只读校验）。
 *
 * 4 大闭环校验维度：
 * A. 测试覆盖同步：JDBC/Flyway JUnit 测试类 @Tag("mysql-integration") 全覆盖、严禁硬编码 jdbc:h2:mem:、
 *    CI image.yml 与 Dockerfile 门禁同步（消除静态白名单漏测风险）。
 * B. 接口契约同步：全仓 Controller 端点提取（平衡括号+顶层逗号词法解析），/api/v2/* 100% 对齐 openapi.json，
 *    全仓业务接口须全部收敛至 /api/v2/*（唯一基础设施探针 GET /api/health 豁免且强制入 openapi.json）。
 * C. 架构与巨石文件红线同步：复用 arch-coupling-audit.mjs 校验 0 SCC 与通用画布零越界，
 *    全仓 >1000 行生产源码文件基线已清零（M4-5 归 0 锁定），严禁任何超千行生产源码文件回流。
 * D. 验收地图同步：frontend/src/utils/routeUtils.ts 的 KNOWN_MODERN_ROUTES 全量覆盖于
 *    .agents/skills/verify-cutdemotwo/features/*.md（排除 README.md），并核验 SKILL.md 脚本路径真实存在。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditRepository,
  stripJavaCommentsAndStrings,
  stripJsComments,
  toPosixPath
} from './arch-coupling-audit.mjs';

/** 存量非 /api/v2/* 业务端点基线（M4-1 已全部收敛清零，严禁出现任何非 /api/v2/* 业务接口）。 */
export const LEGACY_NON_V2_ENDPOINTS_BASELINE = Object.freeze([]);

/** 唯一豁免非 /api/v2/* 业务禁令的基础设施健康探针（仍须纳入 openapi.json）。 */
export const INFRA_HEALTH_PROBE_ENDPOINTS = Object.freeze(['GET /api/health']);

/** 存量 >1000 行生产源码文件基线（M4-3B/M4-4 已全部拆解清零，M4-5 正式归 0 锁定，严禁新增超千行生产源码文件）。 */
export const LARGE_SOURCE_FILES_BASELINE = Object.freeze([]);

function readUtf8NoBom(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function walkFilesSync(dir, predicate) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFilesSync(fullPath, predicate));
    } else if (entry.isFile() && (!predicate || predicate(entry.name, fullPath))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * 仅剥离 Java 注释（// 与 /* ... * /），完整保留字符串、字符字面量与文本块内容，且保留行号。
 */
export function stripJavaCommentsKeepStrings(source) {
  const n = source.length;
  const out = new Array(n);
  let i = 0;

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    if (ch === '/' && next === '/') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && source[i] !== '\n') {
        out[i++] = ' ';
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out[i++] = ' ';
          out[i++] = ' ';
          break;
        }
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '"' && next === '"' && source[i + 2] === '"') {
      out[i++] = '"';
      out[i++] = '"';
      out[i++] = '"';
      while (i < n) {
        if (source[i] === '\\' && i + 1 < n) {
          out[i] = source[i];
          i += 1;
          out[i] = source[i];
          i += 1;
          continue;
        }
        if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
          out[i++] = '"';
          out[i++] = '"';
          out[i++] = '"';
          break;
        }
        out[i] = source[i];
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i++] = quote;
      while (i < n) {
        const cur = source[i];
        if (cur === '\\' && i + 1 < n) {
          out[i] = source[i];
          i += 1;
          out[i] = source[i];
          i += 1;
          continue;
        }
        out[i++] = cur;
        if (cur === quote || cur === '\n') break;
      }
      continue;
    }

    out[i] = ch;
    i += 1;
  }

  return out.join('');
}

/** 提取大括号深度 0 处的类声明及其紧邻注解前缀与继承父类（免疫注解参数内的 {...}）。 */
function extractTopLevelJavaClasses(codeWithStrings) {
  const classes = [];
  const n = codeWithStrings.length;
  let braceDepth = 0;
  let parenDepth = 0;
  let lastBoundary = 0;
  let i = 0;

  while (i < n) {
    const ch = codeWithStrings[i];

    // 跳过文本块
    if (ch === '"' && codeWithStrings[i + 1] === '"' && codeWithStrings[i + 2] === '"') {
      i += 3;
      while (i < n) {
        if (codeWithStrings[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (codeWithStrings[i] === '"' && codeWithStrings[i + 1] === '"' && codeWithStrings[i + 2] === '"') {
          i += 3;
          break;
        }
        i += 1;
      }
      continue;
    }

    // 跳过普通字符串 / 字符字面量
    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < n) {
        if (codeWithStrings[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        const cur = codeWithStrings[i];
        i += 1;
        if (cur === q || cur === '\n') break;
      }
      continue;
    }

    if (braceDepth === 0) {
      if (ch === '(') {
        parenDepth += 1;
        i += 1;
        continue;
      }
      if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        i += 1;
        continue;
      }
    }

    if (ch === '{') {
      if (braceDepth === 0 && parenDepth === 0) {
        const header = codeWithStrings.slice(lastBoundary, i);
        const clsMatch = header.match(
          /(?:^|[\s;])(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*(?:class|interface|record|enum)\s+([A-Za-z_]\w*)(?:<[^>{}]*>)?(?:\s+extends\s+([A-Za-z0-9_$.]+))?/
        );
        if (clsMatch) {
          const classKwOffset = header.indexOf(clsMatch[0]);
          const annotationsZone = header.slice(0, Math.max(0, classKwOffset));
          classes.push({
            name: clsMatch[1],
            superClass: clsMatch[2] || null,
            annotationsZone,
            bodyStart: i
          });
        }
      }
      if (parenDepth === 0) {
        braceDepth += 1;
      }
      i += 1;
      continue;
    }

    if (ch === '}') {
      if (parenDepth === 0) {
        braceDepth = Math.max(0, braceDepth - 1);
        if (braceDepth === 0) {
          lastBoundary = i + 1;
        }
      }
      i += 1;
      continue;
    }

    if (braceDepth === 0 && parenDepth === 0 && ch === ';') {
      lastBoundary = i + 1;
    }

    i += 1;
  }

  return classes;
}

function hasMysqlIntegrationTag(annotationsZone) {
  if (!annotationsZone) return false;
  return /@Tag\s*\(\s*(?:value\s*=\s*)?"mysql-integration"\s*\)/.test(annotationsZone);
}

/**
 * 维度 A：测试覆盖同步校验
 */
export function checkTestCoverageClosure(rootDir) {
  const testJavaRoot = path.join(rootDir, 'src', 'test', 'java');
  const files = walkFilesSync(testJavaRoot, (name) => name.endsWith('.java'));
  const records = [];

  for (const fullPath of files) {
    const raw = readUtf8NoBom(fullPath);
    const codeWithStrings = stripJavaCommentsKeepStrings(raw);
    const codeNoStrings = stripJavaCommentsAndStrings(raw);
    const relFile = toPosixPath(path.relative(rootDir, fullPath));

    const pkgMatch = codeWithStrings.match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    const topClasses = extractTopLevelJavaClasses(codeWithStrings);
    const baseName = path.basename(fullPath, '.java');
    const primaryClass = topClasses.find((c) => c.name === baseName) || topClasses[0] || {
      name: baseName,
      superClass: null,
      annotationsZone: ''
    };

    const hasTestAnnotations = /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(codeNoStrings);
    const callsOptimizationTestDatabase = /\bOptimizationTestDatabase\s*\.\s*create\s*\(/.test(codeNoStrings);
    const callsFlywayConfigure = /\bFlyway\s*\.\s*configure\s*\(/.test(codeNoStrings);
    const hasHardcodedH2 = /["']jdbc:h2:mem:/i.test(codeWithStrings);
    const hasDirectMysqlTag = topClasses.some((c) => hasMysqlIntegrationTag(c.annotationsZone));

    records.push({
      file: relFile,
      pkg,
      className: primaryClass.name,
      fqcn: pkg ? `${pkg}.${primaryClass.name}` : primaryClass.name,
      superClass: primaryClass.superClass,
      hasTestAnnotations,
      callsOptimizationTestDatabase,
      callsFlywayConfigure,
      hasHardcodedH2,
      hasDirectMysqlTag
    });
  }

  // 解析父类的 @Tag 继承链
  const byFqcn = new Map();
  const bySimple = new Map();
  for (const rec of records) {
    byFqcn.set(rec.fqcn, rec);
    if (!bySimple.has(rec.className)) bySimple.set(rec.className, []);
    bySimple.get(rec.className).push(rec);
  }

  function resolveEffectiveMysqlTag(rec, visited = new Set()) {
    if (!rec || visited.has(rec.fqcn)) return false;
    if (rec.hasDirectMysqlTag) return true;
    if (!rec.superClass) return false;
    visited.add(rec.fqcn);

    const directFqcn = byFqcn.get(rec.superClass) || byFqcn.get(`${rec.pkg}.${rec.superClass}`);
    if (directFqcn) return resolveEffectiveMysqlTag(directFqcn, visited);
    const candidates = bySimple.get(rec.superClass) || [];
    return candidates.some((c) => resolveEffectiveMysqlTag(c, new Set(visited)));
  }

  const violations = [];
  const taggedTestClasses = [];

  for (const rec of records) {
    const effectiveTag = resolveEffectiveMysqlTag(rec);
    rec.hasEffectiveMysqlTag = effectiveTag;
    const needsMysql = rec.hasTestAnnotations && (rec.callsOptimizationTestDatabase || rec.callsFlywayConfigure);

    if (rec.hasTestAnnotations && effectiveTag) {
      taggedTestClasses.push(rec.file);
    }

    if (needsMysql && !effectiveTag) {
      violations.push({
        rule: 'missing-mysql-tag',
        file: rec.file,
        message: `测试类调用了 OptimizationTestDatabase.create 或 Flyway.configure，但未标注 @Tag("mysql-integration")`
      });
    }

    if (rec.hasTestAnnotations && (needsMysql || effectiveTag) && rec.hasHardcodedH2) {
      violations.push({
        rule: 'hardcoded-h2-jdbc',
        file: rec.file,
        message: `MySQL/Flyway 集成测试类存在硬编码 "jdbc:h2:mem:"，请统一改用 OptimizationTestDatabase.create()`
      });
    }
  }

  // 检查 .github/workflows/image.yml
  const imageYmlRel = '.github/workflows/image.yml';
  const imageYmlAbs = path.join(rootDir, '.github', 'workflows', 'image.yml');
  let imageYmlPassed = false;
  if (!fs.existsSync(imageYmlAbs)) {
    violations.push({
      rule: 'missing-ci-workflow',
      file: imageYmlRel,
      message: '缺少 .github/workflows/image.yml 门禁配置文件'
    });
  } else {
    const rawYml = readUtf8NoBom(imageYmlAbs);
    const cleanYmlLines = rawYml
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, ''));

    // 提取 mysql-integration job 区块（支持任意 YAML 缩进），若无该 job 键则退化扫描全文
    let mysqlJobBlock = cleanYmlLines.join('\n');
    const jobStartIdx = cleanYmlLines.findIndex((line) => /^\s*mysql-integration:\s*$/.test(line));
    if (jobStartIdx !== -1) {
      const baseIndent = cleanYmlLines[jobStartIdx].match(/^(\s*)/)[1].length;
      const blockLines = [cleanYmlLines[jobStartIdx]];
      for (let idx = jobStartIdx + 1; idx < cleanYmlLines.length; idx += 1) {
        const line = cleanYmlLines[idx];
        if (line.trim() !== '') {
          const curIndent = line.match(/^(\s*)/)[1].length;
          if (curIndent <= baseIndent) break;
        }
        blockLines.push(line);
      }
      mysqlJobBlock = blockLines.join('\n');
    }

    const cleanYmlText = cleanYmlLines.join('\n');
    const hasGroups = /-Dgroups=(?:"|')?mysql-integration(?:"|')?/.test(mysqlJobBlock);
    const hasStaticDtest = /-Dtest\s*=/.test(mysqlJobBlock);
    const hasClosureGate = /workflow-closure-audit\.mjs\b[^\n]*(?:--fail\b|--check\b)/.test(cleanYmlText);

    if (!hasGroups) {
      violations.push({
        rule: 'ci-missing-mysql-groups',
        file: imageYmlRel,
        message: 'image.yml 缺少 -Dgroups=mysql-integration 动态分组测试参数'
      });
    }
    if (hasStaticDtest) {
      violations.push({
        rule: 'ci-static-dtest-whitelist',
        file: imageYmlRel,
        message: 'image.yml 仍包含静态 -Dtest= 类名白名单，存在新增测试漏测风险'
      });
    }
    if (!hasClosureGate) {
      violations.push({
        rule: 'ci-missing-workflow-closure-audit',
        file: imageYmlRel,
        message: 'image.yml 未接入 node scripts/workflow-closure-audit.mjs --fail 门禁'
      });
    }
    imageYmlPassed = hasGroups && !hasStaticDtest && hasClosureGate;
  }

  // 检查 Dockerfile
  const dockerfileRel = 'Dockerfile';
  const dockerfileAbs = path.join(rootDir, 'Dockerfile');
  let dockerfilePassed = false;
  if (!fs.existsSync(dockerfileAbs)) {
    violations.push({
      rule: 'missing-dockerfile',
      file: dockerfileRel,
      message: '缺少 Dockerfile'
    });
  } else {
    const rawDocker = readUtf8NoBom(dockerfileAbs);
    const cleanDocker = rawDocker
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    const hasSyncWorker = /sync-worker\.test\.mjs/.test(cleanDocker);
    const hasArchAudit = /arch-coupling-audit\.mjs[^\n]*--fail-on-cycle/.test(cleanDocker);
    const hasWorkflowAudit = /workflow-closure-audit\.mjs[^\n]*(?:--fail\b|--check\b)/.test(cleanDocker);

    if (!hasSyncWorker) {
      violations.push({
        rule: 'dockerfile-missing-sync-worker-test',
        file: dockerfileRel,
        message: 'Dockerfile frontend-tests 阶段未执行 sync-worker.test.mjs'
      });
    }
    if (!hasArchAudit) {
      violations.push({
        rule: 'dockerfile-missing-arch-audit',
        file: dockerfileRel,
        message: 'Dockerfile frontend-tests 阶段未执行 arch-coupling-audit.mjs --fail-on-cycle'
      });
    }
    if (!hasWorkflowAudit) {
      violations.push({
        rule: 'dockerfile-missing-workflow-audit',
        file: dockerfileRel,
        message: 'Dockerfile frontend-tests 阶段未执行 workflow-closure-audit.mjs --fail'
      });
    }
    dockerfilePassed = hasSyncWorker && hasArchAudit && hasWorkflowAudit;
  }

  return {
    passed: violations.length === 0,
    scannedJavaTestFiles: records.length,
    taggedTestClassCount: taggedTestClasses.length,
    taggedTestClasses,
    imageYmlPassed,
    dockerfilePassed,
    violations
  };
}

/** 读取从 openParenIdx 开始的平衡圆括号内容（跳过 Java 字符串）。 */
function readBalancedParens(text, openParenIdx) {
  let depth = 0;
  let i = openParenIdx;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      i += 3;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
          i += 3;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        const cur = text[i];
        i += 1;
        if (cur === q || cur === '\n') break;
      }
      continue;
    }

    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(openParenIdx + 1, i),
          endIndex: i
        };
      }
    }
    i += 1;
  }
  return null;
}

/** 在顶层（括号/大括号/方括号深度 0 且不在字符串中）按逗号切分。 */
function splitTopLevelCommas(text) {
  const parts = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      i += 3;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
          i += 3;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        const cur = text[i];
        i += 1;
        if (cur === q || cur === '\n') break;
      }
      continue;
    }

    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }

    i += 1;
  }

  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function unquoteJavaStringLiteral(expr) {
  const trimmed = expr.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') && !trimmed.startsWith('"""')) {
    let inner = '';
    let i = 1;
    const end = trimmed.length - 1;
    while (i < end) {
      if (trimmed[i] === '\\' && i + 1 < end) {
        const next = trimmed[i + 1];
        if (next === 'n') inner += '\n';
        else if (next === 't') inner += '\t';
        else if (next === 'r') inner += '\r';
        else inner += next;
        i += 2;
        continue;
      }
      if (trimmed[i] === '"') {
        // 说明存在 "..." + "..." 之类的非单字符串表达式
        return null;
      }
      inner += trimmed[i];
      i += 1;
    }
    return inner;
  }
  return null;
}

function parseJavaStringOrArray(expr) {
  const trimmed = expr.trim();
  if (!trimmed) return { paths: [], unresolved: false };

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return { paths: [], unresolved: false };
    const items = splitTopLevelCommas(inner);
    const out = [];
    for (const item of items) {
      const literal = unquoteJavaStringLiteral(item);
      if (literal === null) return { paths: [], unresolved: true };
      out.push(literal);
    }
    return { paths: out, unresolved: false };
  }

  const literal = unquoteJavaStringLiteral(trimmed);
  if (literal === null) return { paths: [], unresolved: true };
  return { paths: [literal], unresolved: false };
}

function parseMappingArgs(argContent, annotationType) {
  const defaultMethodMap = {
    GetMapping: ['GET'],
    PostMapping: ['POST'],
    PutMapping: ['PUT'],
    DeleteMapping: ['DELETE'],
    PatchMapping: ['PATCH'],
    RequestMapping: ['ANY']
  };
  let methods = defaultMethodMap[annotationType] || ['ANY'];
  let paths = null;
  let unresolved = false;

  const trimmed = (argContent || '').trim();
  if (!trimmed) {
    return { methods, paths: [''], unresolved: false };
  }

  const tokens = splitTopLevelCommas(trimmed);
  for (const token of tokens) {
    if (!token) continue;
    // 判断是否为 key = value（注意不要把字符串中的 = 当作赋值）
    let eqIdx = -1;
    let inQuote = false;
    for (let i = 0; i < token.length; i += 1) {
      const ch = token[i];
      if (ch === '"' && token[i - 1] !== '\\') inQuote = !inQuote;
      else if (!inQuote && ch === '=') {
        eqIdx = i;
        break;
      }
    }

    if (eqIdx === -1) {
      // 位置参数，等价于 value = ...
      const parsed = parseJavaStringOrArray(token);
      if (parsed.unresolved) unresolved = true;
      else paths = parsed.paths;
      continue;
    }

    const key = token.slice(0, eqIdx).trim();
    const val = token.slice(eqIdx + 1).trim();
    if (key === 'value' || key === 'path') {
      const parsed = parseJavaStringOrArray(val);
      if (parsed.unresolved) unresolved = true;
      else paths = parsed.paths;
    } else if (key === 'method' && annotationType === 'RequestMapping') {
      const matchedMethods = [...val.matchAll(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map(
        (m) => m[1]
      );
      if (matchedMethods.length > 0) {
        methods = [...new Set(matchedMethods)];
      }
    }
  }

  if (paths === null && !unresolved) {
    paths = [''];
  }

  return { methods, paths: paths || [], unresolved };
}

export function normalizeHttpPath(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

export function canonicalizeHttpPath(normalizedPath) {
  return normalizedPath.replace(/\{[^}]+\}/g, '{}');
}

function extractPathParamNames(normalizedPath) {
  return [...normalizedPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1].trim());
}

/**
 * 从单份 Java Controller 源码提取类级与方法级映射端点。
 */
export function extractControllerEndpointsFromSource(rawSource, relFile = '<memory>') {
  const codeWithStrings = stripJavaCommentsKeepStrings(rawSource);
  const topClasses = extractTopLevelJavaClasses(codeWithStrings);
  const controllerClasses = topClasses.filter((c) => /@(?:RestController|Controller)\b/.test(c.annotationsZone));
  if (controllerClasses.length === 0) {
    return { isController: false, endpoints: [], unresolvedMappings: [] };
  }

  const endpoints = [];
  const unresolvedMappings = [];

  for (let idx = 0; idx < controllerClasses.length; idx += 1) {
    const cls = controllerClasses[idx];
    const nextStart = idx + 1 < controllerClasses.length ? controllerClasses[idx + 1].bodyStart : codeWithStrings.length;
    const classBody = codeWithStrings.slice(cls.bodyStart, nextStart);

    // 解析类级 @RequestMapping
    let basePaths = [''];
    const classReqRegex = /@RequestMapping\b/g;
    let cm;
    while ((cm = classReqRegex.exec(cls.annotationsZone)) !== null) {
      let pos = cm.index + cm[0].length;
      while (pos < cls.annotationsZone.length && /\s/.test(cls.annotationsZone[pos])) pos += 1;
      if (cls.annotationsZone[pos] === '(') {
        const parens = readBalancedParens(cls.annotationsZone, pos);
        if (parens) {
          const parsed = parseMappingArgs(parens.content, 'RequestMapping');
          if (parsed.unresolved) {
            unresolvedMappings.push({ file: relFile, annotation: `@RequestMapping(${parens.content})` });
          } else if (parsed.paths.length > 0) {
            basePaths = parsed.paths;
          }
        }
      }
    }

    // 解析方法级 @GetMapping / @PostMapping / @PutMapping / @DeleteMapping / @PatchMapping / @RequestMapping
    const methodMapRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/g;
    let mm;
    while ((mm = methodMapRegex.exec(classBody)) !== null) {
      const annType = mm[1];
      let pos = mm.index + mm[0].length;
      while (pos < classBody.length && /\s/.test(classBody[pos])) pos += 1;

      let parsed;
      let rawArgs = '';
      if (classBody[pos] === '(') {
        const parens = readBalancedParens(classBody, pos);
        if (!parens) {
          unresolvedMappings.push({ file: relFile, annotation: `@${annType}(<unclosed>)` });
          continue;
        }
        rawArgs = parens.content;
        parsed = parseMappingArgs(parens.content, annType);
        methodMapRegex.lastIndex = parens.endIndex + 1;
      } else {
        parsed = parseMappingArgs('', annType);
      }

      if (parsed.unresolved) {
        unresolvedMappings.push({ file: relFile, annotation: `@${annType}(${rawArgs})` });
        continue;
      }

      for (const base of basePaths) {
        for (const sub of parsed.paths) {
          const joined = base && sub ? `${base}/${sub}` : `${base}${sub}`;
          const normalized = normalizeHttpPath(joined);
          const canonicalPath = canonicalizeHttpPath(normalized);
          const paramNames = extractPathParamNames(normalized);
          for (const method of parsed.methods) {
            endpoints.push({
              file: relFile,
              method,
              path: normalized,
              canonicalPath,
              paramNames
            });
          }
        }
      }
    }
  }

  return { isController: true, endpoints, unresolvedMappings };
}

/**
 * 维度 B：接口契约同步校验
 */
export function checkApiContractClosure(rootDir, options = {}) {
  const javaMainRoot = path.join(rootDir, 'src', 'main', 'java');
  const javaFiles = walkFilesSync(javaMainRoot, (name) => name.endsWith('.java'));
  const legacyBaselineList = options.legacyBaseline || LEGACY_NON_V2_ENDPOINTS_BASELINE;
  const infraProbeList = options.infraProbes || INFRA_HEALTH_PROBE_ENDPOINTS;

  const legacyBaselineSet = new Set(
    legacyBaselineList.map((entry) => {
      const [method, rawPath] = entry.trim().split(/\s+/, 2);
      return `${method.toUpperCase()} ${canonicalizeHttpPath(normalizeHttpPath(rawPath))}`;
    })
  );
  const infraProbeSet = new Set(
    infraProbeList.map((entry) => {
      const [method, rawPath] = entry.trim().split(/\s+/, 2);
      return `${method.toUpperCase()} ${canonicalizeHttpPath(normalizeHttpPath(rawPath))}`;
    })
  );

  const allEndpoints = [];
  const unresolvedMappings = [];
  let controllerCount = 0;

  for (const fullPath of javaFiles) {
    const raw = readUtf8NoBom(fullPath);
    const relFile = toPosixPath(path.relative(rootDir, fullPath));
    const extracted = extractControllerEndpointsFromSource(raw, relFile);
    if (extracted.isController) controllerCount += 1;
    allEndpoints.push(...extracted.endpoints);
    unresolvedMappings.push(...extracted.unresolvedMappings);
  }

  const openapiRel = 'src/main/resources/static/api-v2/openapi.json';
  const openapiAbs = path.join(rootDir, 'src', 'main', 'resources', 'static', 'api-v2', 'openapi.json');
  const violations = [];

  for (const u of unresolvedMappings) {
    violations.push({
      rule: 'unresolved-controller-mapping',
      file: u.file,
      message: `无法静态解析控制器路径注解：${u.annotation}`
    });
  }

  const openapiOps = new Map();
  if (!fs.existsSync(openapiAbs)) {
    violations.push({
      rule: 'missing-openapi-spec',
      file: openapiRel,
      message: '缺少 OpenAPI 3.1 契约文件 src/main/resources/static/api-v2/openapi.json'
    });
  } else {
    const doc = JSON.parse(readUtf8NoBom(openapiAbs));
    const pathsObj = doc.paths || {};
    for (const [rawPath, pathItem] of Object.entries(pathsObj)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      const normalized = normalizeHttpPath(rawPath);
      const canonicalPath = canonicalizeHttpPath(normalized);
      const paramNames = extractPathParamNames(normalized);
      for (const methodKey of ['get', 'post', 'put', 'delete', 'patch']) {
        if (Object.prototype.hasOwnProperty.call(pathItem, methodKey)) {
          const method = methodKey.toUpperCase();
          openapiOps.set(`${method} ${canonicalPath}`, {
            method,
            path: normalized,
            canonicalPath,
            paramNames
          });
        }
      }
    }
  }

  const controllerOpKeys = new Set();
  const v2Endpoints = [];
  const infraEndpoints = [];
  const legacyEndpoints = [];

  for (const ep of allEndpoints) {
    const canonKey = `${ep.method} ${ep.canonicalPath}`;
    controllerOpKeys.add(canonKey);

    const isV2 = ep.path === '/api/v2' || ep.path.startsWith('/api/v2/');
    if (isV2) {
      v2Endpoints.push(ep);
      const specOp = openapiOps.get(canonKey);
      if (!specOp) {
        violations.push({
          rule: 'v2-missing-in-openapi',
          file: ep.file,
          message: `新增或暴露的 v2 接口未写入 openapi.json：${ep.method} ${ep.path}`
        });
      } else if (JSON.stringify(ep.paramNames) !== JSON.stringify(specOp.paramNames)) {
        violations.push({
          rule: 'openapi-param-name-mismatch',
          file: ep.file,
          message: `路径参数名不一致：控制器 ${ep.method} ${ep.path} vs OpenAPI ${specOp.path}`
        });
      }
    } else if (infraProbeSet.has(canonKey)) {
      infraEndpoints.push(ep);
      const specOp = openapiOps.get(canonKey);
      if (!specOp) {
        violations.push({
          rule: 'infra-endpoint-missing-in-openapi',
          file: ep.file,
          message: `基础设施健康探针未写入 openapi.json：${ep.method} ${ep.path}`
        });
      } else if (JSON.stringify(ep.paramNames) !== JSON.stringify(specOp.paramNames)) {
        violations.push({
          rule: 'openapi-param-name-mismatch',
          file: ep.file,
          message: `路径参数名不一致：控制器 ${ep.method} ${ep.path} vs OpenAPI ${specOp.path}`
        });
      }
    } else {
      legacyEndpoints.push(ep);
      if (!legacyBaselineSet.has(canonKey)) {
        violations.push({
          rule: 'unregistered-legacy-endpoint',
          file: ep.file,
          message: legacyBaselineList.length === 0
            ? `非 /api/v2/* 存量已清零，禁止新增非 /api/v2/* 业务接口：${ep.method} ${ep.path}`
            : `禁止新增未在存量基线登记的非 /api/v2/* 接口：${ep.method} ${ep.path}`
        });
      }
    }
  }

  // 检查 OpenAPI 孤儿接口（OpenAPI 有声明但 Controller 已删除）
  for (const [canonKey, specOp] of openapiOps.entries()) {
    if (!controllerOpKeys.has(canonKey)) {
      violations.push({
        rule: 'orphan-openapi-operation',
        file: openapiRel,
        message: `openapi.json 存在无对应 Controller 实现的孤儿端点：${specOp.method} ${specOp.path}`
      });
    }
  }

  return {
    passed: violations.length === 0,
    controllerCount,
    totalControllerEndpoints: allEndpoints.length,
    v2EndpointCount: v2Endpoints.length,
    infraEndpointCount: infraEndpoints.length,
    legacyEndpointCount: legacyEndpoints.length,
    legacyBaselineCount: legacyBaselineList.length,
    openapiOperationCount: openapiOps.size,
    resolvedLegacyCount: Math.max(0, legacyBaselineList.length - legacyEndpoints.length),
    violations
  };
}

/**
 * 维度 C：架构无环与超千行巨石文件单向递减基线校验
 */
export function checkArchAndLargeFilesClosure(rootDir, options = {}) {
  const largeBaselineList = options.largeFilesBaseline || LARGE_SOURCE_FILES_BASELINE;
  const largeBaselineSet = new Set(largeBaselineList);
  const archReport = auditRepository(rootDir, { largeFileThreshold: 1000 });
  const violations = [];

  if (archReport.summary.totalCycles > 0) {
    violations.push({
      rule: 'arch-cycle-detected',
      file: 'scripts/arch-coupling-audit.mjs',
      message: `检测到 ${archReport.summary.totalCycles} 个架构循环依赖（包环=${archReport.summary.backendPackageCycleCount}，业务类环=${archReport.summary.backendBusinessClassCycleCount}，前端环=${archReport.summary.frontendImportCycleCount}）`
    });
  }

  if (!archReport.summary.canvasBoundaryPassed) {
    violations.push({
      rule: 'canvas-boundary-violation',
      file: 'frontend/src/components/WorkbenchBoardCanvas.tsx',
      message: '通用画布 WorkbenchBoardCanvas.tsx 违反隔离边界（不得直接引用 store 或调用 API）'
    });
  }

  const currentLargeFiles = archReport.hotspots.largeFiles;
  const currentLargeSet = new Set(currentLargeFiles.map((f) => f.file));

  for (const item of currentLargeFiles) {
    if (!largeBaselineSet.has(item.file)) {
      violations.push({
        rule: 'new-large-source-file',
        file: item.file,
        message: largeBaselineList.length === 0
          ? `超千行基线已归零，严禁新增超 1000 行生产源码文件（当前 ${item.lines} 行）`
          : `严禁在存量 ${largeBaselineList.length} 个基线外新增超 1000 行生产源码文件（当前 ${item.lines} 行）`
      });
    }
  }

  const resolvedBaselineLargeFiles = largeBaselineList.filter((f) => !currentLargeSet.has(f));

  return {
    passed: violations.length === 0,
    totalCycles: archReport.summary.totalCycles,
    canvasBoundaryPassed: archReport.summary.canvasBoundaryPassed,
    currentLargeFileCount: currentLargeFiles.length,
    largeFileBaselineCount: largeBaselineList.length,
    resolvedBaselineLargeFiles,
    violations
  };
}

function parseFrontmatterRoutes(markdown) {
  const match = markdown.match(/^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { routes: [], body: markdown };

  const fm = match[1];
  const body = markdown.slice(match[0].length);
  const routes = [];
  const lines = fm.replace(/\r\n/g, '\n').split('\n');

  let inRoutes = false;
  for (const line of lines) {
    const inlineMatch = line.match(/^routes\s*:\s*\[([^\]]*)\]\s*$/);
    if (inlineMatch) {
      inRoutes = false;
      for (const item of inlineMatch[1].split(',')) {
        const cleaned = item.trim().replace(/^['"]|['"]$/g, '');
        if (cleaned) routes.push(cleaned);
      }
      continue;
    }

    if (/^routes\s*:\s*$/.test(line)) {
      inRoutes = true;
      continue;
    }

    if (inRoutes) {
      const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
      if (itemMatch) {
        const cleaned = itemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (cleaned) routes.push(cleaned);
        continue;
      }
      if (/^\S/.test(line)) {
        inRoutes = false;
      }
    }
  }

  return { routes, body };
}

function extractModernRoutesFromRouteUtils(rawSource) {
  const clean = stripJsComments(rawSource);
  const match = clean.match(/\bKNOWN_MODERN_ROUTES\b[^=]*=\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  const routes = [];
  const strRegex = /['"]([a-z0-9-]+)['"]/g;
  let m;
  while ((m = strRegex.exec(match[1])) !== null) {
    routes.push(m[1]);
  }
  return [...new Set(routes)];
}

/**
 * 维度 D：验收地图与 SKILL 脚本路径同步校验
 */
export function checkVerifyMapClosure(rootDir) {
  const violations = [];
  const routeUtilsRel = 'frontend/src/utils/routeUtils.ts';
  const routeUtilsAbs = path.join(rootDir, 'frontend', 'src', 'utils', 'routeUtils.ts');

  let knownRoutes = [];
  if (!fs.existsSync(routeUtilsAbs)) {
    violations.push({
      rule: 'missing-route-utils',
      file: routeUtilsRel,
      message: '缺少前端路由清单文件 frontend/src/utils/routeUtils.ts'
    });
  } else {
    const parsed = extractModernRoutesFromRouteUtils(readUtf8NoBom(routeUtilsAbs));
    if (!parsed || parsed.length === 0) {
      violations.push({
        rule: 'missing-known-modern-routes',
        file: routeUtilsRel,
        message: '未能在 routeUtils.ts 中解析到 KNOWN_MODERN_ROUTES'
      });
    } else {
      knownRoutes = parsed;
    }
  }

  const featuresDir = path.join(rootDir, '.agents', 'skills', 'verify-cutdemotwo', 'features');
  const featureFiles = walkFilesSync(
    featuresDir,
    (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md'
  );

  const coveredRoutesMap = new Map();
  for (const fullPath of featureFiles) {
    const relFile = toPosixPath(path.relative(rootDir, fullPath));
    const raw = readUtf8NoBom(fullPath);
    const { routes: fmRoutes, body } = parseFrontmatterRoutes(raw);

    const fileRoutes = new Set(fmRoutes);
    // 兼顾正文显式 `#/<route>` 声明
    const bodyHashRegex = /(?:^|[\s`("'(（])#\/([a-z0-9-]+)(?=[/?#`)"'）\s,，。：:]|$)/gm;
    let hm;
    while ((hm = bodyHashRegex.exec(body)) !== null) {
      fileRoutes.add(hm[1]);
    }

    for (const r of fileRoutes) {
      if (!coveredRoutesMap.has(r)) coveredRoutesMap.set(r, []);
      coveredRoutesMap.get(r).push(relFile);
    }
  }

  for (const route of knownRoutes) {
    if (!coveredRoutesMap.has(route) || coveredRoutesMap.get(route).length === 0) {
      violations.push({
        rule: 'route-missing-verify-feature',
        file: routeUtilsRel,
        message: `现代路由 "#/${route}" 未在任何 .agents/skills/verify-cutdemotwo/features/*.md（非 README.md）验收地图中覆盖`
      });
    }
  }

  // 检查 SKILL.md 中引用的脚本路径是否真实存在
  const skillRel = '.agents/skills/verify-cutdemotwo/SKILL.md';
  const skillAbs = path.join(rootDir, '.agents', 'skills', 'verify-cutdemotwo', 'SKILL.md');
  let checkedSkillPaths = 0;

  if (!fs.existsSync(skillAbs)) {
    violations.push({
      rule: 'missing-verify-skill',
      file: skillRel,
      message: '缺少 .agents/skills/verify-cutdemotwo/SKILL.md'
    });
  } else {
    const rawSkill = readUtf8NoBom(skillAbs);
    const refPaths = new Set();

    // 匹配 node 命令或反引号内的仓库脚本/测试文件引用
    const nodeCmdRegex = /\bnode\s+(?:--test\s+)?([A-Za-z0-9_.\-\/*]+\.(?:mjs|cjs))\b/g;
    let nm;
    while ((nm = nodeCmdRegex.exec(rawSkill)) !== null) {
      refPaths.add(nm[1]);
    }

    const mdLinkRegex = /\[[^\]]+\]\(\.\/([A-Za-z0-9_.\-\/]+\.(?:mjs|cjs|md))\)/g;
    let lm;
    while ((lm = mdLinkRegex.exec(rawSkill)) !== null) {
      refPaths.add(`.agents/skills/verify-cutdemotwo/${lm[1]}`);
    }

    for (const ref of refPaths) {
      checkedSkillPaths += 1;
      if (ref.includes('*')) {
        const dirRel = ref.slice(0, ref.lastIndexOf('/'));
        const ext = path.extname(ref);
        const dirAbs = path.join(rootDir, dirRel);
        const matches = walkFilesSync(dirAbs, (name) => !ext || name.endsWith(ext));
        if (!fs.existsSync(dirAbs) || matches.length === 0) {
          violations.push({
            rule: 'broken-verify-skill-path',
            file: skillRel,
            message: `SKILL.md 引用的通配脚本路径不存在或为空：${ref}`
          });
        }
      } else {
        const absRef = path.join(rootDir, ref);
        if (!fs.existsSync(absRef)) {
          violations.push({
            rule: 'broken-verify-skill-path',
            file: skillRel,
            message: `SKILL.md 引用的脚本/文档路径不存在：${ref}`
          });
        }
      }
    }
  }

  return {
    passed: violations.length === 0,
    knownModernRouteCount: knownRoutes.length,
    knownModernRoutes: knownRoutes,
    featureFileCount: featureFiles.length,
    checkedSkillPaths,
    violations
  };
}

/**
 * 执行完整 4 维度防遗漏工作流闭环门禁校验（只读）。
 */
export function auditWorkflowClosure(rootDir, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const testCoverage = checkTestCoverageClosure(resolvedRoot);
  const apiContract = checkApiContractClosure(resolvedRoot, options);
  const archAndLargeFiles = checkArchAndLargeFilesClosure(resolvedRoot, options);
  const verifyMap = checkVerifyMapClosure(resolvedRoot);

  const allViolations = [
    ...testCoverage.violations.map((v) => ({ dimension: 'A-测试覆盖同步', ...v })),
    ...apiContract.violations.map((v) => ({ dimension: 'B-接口契约同步', ...v })),
    ...archAndLargeFiles.violations.map((v) => ({ dimension: 'C-架构与巨石文件同步', ...v })),
    ...verifyMap.violations.map((v) => ({ dimension: 'D-验收地图同步', ...v }))
  ];

  return {
    schemaVersion: '1.0',
    readOnly: true,
    auditedAt: new Date().toISOString(),
    rootDir: toPosixPath(resolvedRoot),
    summary: {
      passed: allViolations.length === 0,
      verdict: allViolations.length === 0 ? 'PASS' : 'FAIL',
      violationCount: allViolations.length,
      dimensionsPassed: {
        testCoverage: testCoverage.passed,
        apiContract: apiContract.passed,
        archAndLargeFiles: archAndLargeFiles.passed,
        verifyMap: verifyMap.passed
      }
    },
    dimensions: {
      testCoverage,
      apiContract,
      archAndLargeFiles,
      verifyMap
    },
    violations: allViolations
  };
}

/** 格式化人类可读的中文 Markdown 门禁报告。 */
export function formatMarkdownReport(report) {
  const s = report.summary;
  const d = report.dimensions;
  const lines = [];

  lines.push('# 防遗漏工作流闭环门禁报告（只读）');
  lines.push('');
  lines.push(`- **总体裁决**：**${s.verdict}**（违规项：${s.violationCount}）`);
  lines.push(`- **扫描根目录**：\`${report.rootDir}\``);
  lines.push(`- **审计时间**：${report.auditedAt}`);
  lines.push('');
  lines.push('## 四维度体检摘要');
  lines.push('');
  lines.push('| 维度 | 状态 | 关键指标 |');
  lines.push('| :--- | :--- | :--- |');
  lines.push(
    `| A. 测试覆盖同步 | ${d.testCoverage.passed ? 'PASS' : 'FAIL'} | 扫描测试文件 ${d.testCoverage.scannedJavaTestFiles} 个；@Tag("mysql-integration") 测试类 ${d.testCoverage.taggedTestClassCount} 个；image.yml=${d.testCoverage.imageYmlPassed ? 'OK' : 'FAIL'}；Dockerfile=${d.testCoverage.dockerfilePassed ? 'OK' : 'FAIL'} |`
  );
  const legacySummary = d.apiContract.legacyBaselineCount === 0
    ? `非 v2 业务存量 ${d.apiContract.legacyEndpointCount}/0（已清零锁定）`
    : `非 v2 业务存量 ${d.apiContract.legacyEndpointCount}/${d.apiContract.legacyBaselineCount}（已消减 ${d.apiContract.resolvedLegacyCount}）`;
  const largeFileSummary = d.archAndLargeFiles.largeFileBaselineCount === 0
    ? `超千行文件 ${d.archAndLargeFiles.currentLargeFileCount}/0（已清零锁定）`
    : `超千行文件 ${d.archAndLargeFiles.currentLargeFileCount}/${d.archAndLargeFiles.largeFileBaselineCount}（已消减 ${d.archAndLargeFiles.resolvedBaselineLargeFiles.length}）`;
  lines.push(
    `| B. 接口契约同步 | ${d.apiContract.passed ? 'PASS' : 'FAIL'} | 控制器 ${d.apiContract.controllerCount} 个；/api/v2/* ${d.apiContract.v2EndpointCount} 条 + 基础设施探针 ${d.apiContract.infraEndpointCount ?? 0} 条 vs OpenAPI ${d.apiContract.openapiOperationCount} 操作；${legacySummary} |`
  );
  lines.push(
    `| C. 架构与巨石文件同步 | ${d.archAndLargeFiles.passed ? 'PASS' : 'FAIL'} | 循环依赖 ${d.archAndLargeFiles.totalCycles}；画布边界=${d.archAndLargeFiles.canvasBoundaryPassed ? 'PASS' : 'FAIL'}；${largeFileSummary} |`
  );
  lines.push(
    `| D. 验收地图同步 | ${d.verifyMap.passed ? 'PASS' : 'FAIL'} | 现代路由 ${d.verifyMap.knownModernRouteCount} 个；特征地图 ${d.verifyMap.featureFileCount} 份；SKILL 路径核查 ${d.verifyMap.checkedSkillPaths} 项 |`
  );
  lines.push('');

  if (report.violations.length > 0) {
    lines.push('## 阻断违规清单');
    lines.push('');
    for (const v of report.violations) {
      lines.push(`- [${v.dimension}] \`${v.rule}\` (\`${v.file}\`)：${v.message}`);
    }
    lines.push('');
  } else {
    lines.push('## 结论');
    lines.push('');
    lines.push('- 四大防遗漏工作流闭环维度全部通过，未检测到遗漏测试、契约漂移、架构越界或验收地图缺口。');
    lines.push('');
  }

  return lines.join('\n');
}

export function parseCliArgs(argv, defaultRoot) {
  const args = {
    root: defaultRoot,
    format: 'md',
    output: null,
    fail: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
    } else if (token === '--fail' || token === '--check') {
      args.fail = true;
    } else if (token === '--root') {
      if (i + 1 >= argv.length) throw new Error('参数 --root 缺少目录路径');
      args.root = path.resolve(argv[++i]);
    } else if (token.startsWith('--root=')) {
      args.root = path.resolve(token.slice('--root='.length));
    } else if (token === '--format') {
      if (i + 1 >= argv.length) throw new Error('参数 --format 缺少取值（仅支持 md 或 json）');
      args.format = argv[++i];
    } else if (token.startsWith('--format=')) {
      args.format = token.slice('--format='.length);
    } else if (token === '--output') {
      if (i + 1 >= argv.length) throw new Error('参数 --output 缺少输出文件路径');
      args.output = path.resolve(argv[++i]);
    } else if (token.startsWith('--output=')) {
      args.output = path.resolve(token.slice('--output='.length));
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }

  if (args.format !== 'md' && args.format !== 'json') {
    throw new Error(`不支持的输出格式 "${args.format}"，仅支持 md 或 json`);
  }

  return args;
}

function getHelpText() {
  return [
    '用法：node scripts/workflow-closure-audit.mjs [选项]',
    '',
    '只读防遗漏工作流闭环门禁 CLI（测试同步 / OpenAPI 契约 / 架构与大文件 / 验收地图）',
    '',
    '选项：',
    '  --root <dir>      待扫描仓库根目录（默认当前仓库根目录）',
    '  --format md|json  报告输出格式（默认 md）',
    '  --output <file>   可选，将只读报告写入指定文件',
    '  --fail, --check   存在任意闭环违规时返回退出码 1',
    '  -h, --help        显示本帮助信息'
  ].join('\n');
}

export function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let args;
  try {
    args = parseCliArgs(argv, defaultRoot);
  } catch (err) {
    io.stderr.write(`参数错误：${err.message}\n${getHelpText()}\n`);
    return 2;
  }

  if (args.help) {
    io.stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (!fs.existsSync(args.root)) {
    io.stderr.write(`扫描根目录不存在：${args.root}\n`);
    return 2;
  }

  const report = auditWorkflowClosure(args.root);
  const rendered = args.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatMarkdownReport(report);

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, rendered, 'utf8');
    io.stderr.write(`工作流闭环体检报告已写入：${toPosixPath(args.output)}\n`);
  } else {
    io.stdout.write(rendered);
  }

  if (args.fail && !report.summary.passed) {
    return 1;
  }
  return 0;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  process.exitCode = runCli(process.argv.slice(2));
}
