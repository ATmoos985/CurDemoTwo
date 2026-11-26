#!/usr/bin/env node
/**
 * 只读 MIT 公理设计架构耦合体检 CLI（零第三方依赖，纯静态只读分析，绝不修改任何业务源码）。
 *
 * 核心能力：
 * 1. 后端 2 级子包依赖图 + Tarjan SCC 全图环检测（含每条边涉及类名与精确行号）
 * 2. 后端 business.*（排除 business.model）类级依赖图 + Tarjan SCC 全图环检测
 * 3. 前端 frontend/src 全图静态 import/re-export 依赖图 + Tarjan SCC 全图环检测
 * 4. 架构膨胀与耦合热点体检：>1000 行超大源码文件、useStudioStore 直接扇入、
 *    后端 synchronized 关键字位置清单、WorkbenchBoardCanvas.tsx 通用画布边界校验
 * 5. MIT 公理设计下三角无环矩阵裁决，支持 Markdown / JSON 输出与 --fail-on-cycle 门禁退出码
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_PACKAGE = 'com.example.cutdemotwo';
const DEFAULT_LARGE_FILE_THRESHOLD = 1000;
const FRONTEND_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
const FRONTEND_RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.d.ts'];
const REGEX_PREV_KEYWORDS = new Set([
  'return', 'throw', 'case', 'in', 'of', 'typeof', 'void', 'delete', 'await', 'yield', 'new', 'else', 'do'
]);

/** 将路径分隔符统一转换为 POSIX 斜杠，确保跨平台一致。 */
export function toPosixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

/** 计算文本行数（与主流编辑器/wc -l 一致，末尾单个换行不额外计入空行）。 */
export function countLines(source) {
  if (!source) return 0;
  const normalized = source.replace(/\r\n/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.length === 0 ? 1 : trimmed.split('\n').length;
}

/** 构造每行起始字符偏移表，配合二分查找将索引映射为 1-based 行号。 */
function buildLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(offsets, index) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readUtf8NoBom(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

/** 剥离 Java 源码中的行注释、块注释、文本块（"""..."""）、双引号字符串与字符字面量。
 * 严格保留所有换行符 \n，其余被剥离字符替换为空格，确保行号 100% 不偏移。
 */
export function stripJavaCommentsAndStrings(source) {
  const n = source.length;
  const out = new Array(n);
  let i = 0;

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    // 行注释 // ...
    if (ch === '/' && next === '/') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && source[i] !== '\n') {
        out[i++] = ' ';
      }
      continue;
    }

    // 块注释 /* ... */
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

    // Java 文本块 """ ... """
    if (ch === '"' && next === '"' && source[i + 2] === '"') {
      out[i++] = ' ';
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n) {
        if (source[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          i += 1;
          out[i] = source[i] === '\n' ? '\n' : ' ';
          i += 1;
          continue;
        }
        if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
          out[i++] = ' ';
          out[i++] = ' ';
          out[i++] = ' ';
          break;
        }
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    // 普通双引号字符串 "..." 或字符字面量 '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i++] = ' ';
      while (i < n) {
        const cur = source[i];
        if (cur === '\\' && i + 1 < n) {
          out[i] = ' ';
          i += 1;
          out[i] = source[i] === '\n' ? '\n' : ' ';
          i += 1;
          continue;
        }
        if (cur === '\n') {
          out[i++] = '\n';
          break;
        }
        out[i++] = ' ';
        if (cur === quote) break;
      }
      continue;
    }

    out[i] = ch;
    i += 1;
  }

  return out.join('');
}

/**
 * 扫描 JS/TS 源码，剥离 // 与 /* *\/ 注释；当 stripStrings 为 true 时同时剥离字符串、
 * 模板静态文本与正则字面量。始终保留所有 \n 以确保行号 100% 精确。
 */
function scanJsSource(source, stripStrings) {
  const n = source.length;
  const out = new Array(n);
  let i = 0;
  // 记录模板字符串内嵌 ${ ... } 的花括号嵌套栈
  const templateBraceStack = [];
  let lastSignificantChar = '';
  let lastWord = '';

  const canStartRegex = () => {
    if (!lastSignificantChar) return true;
    if ('([{,;: =!?&|^~+-*%<>'.includes(lastSignificantChar)) return true;
    if (lastWord && REGEX_PREV_KEYWORDS.has(lastWord)) return true;
    return false;
  };

  const emitChar = (idx, ch, blank) => {
    out[idx] = blank ? (ch === '\n' ? '\n' : ' ') : ch;
  };

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    // 行注释
    if (ch === '/' && next === '/') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && source[i] !== '\n') out[i++] = ' ';
      continue;
    }

    // 块注释
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

    // 单/双引号字符串
    if (ch === '"' || ch === "'") {
      const quote = ch;
      emitChar(i, ch, stripStrings);
      i += 1;
      while (i < n) {
        const cur = source[i];
        if (cur === '\\' && i + 1 < n) {
          emitChar(i, cur, stripStrings);
          i += 1;
          emitChar(i, source[i], stripStrings);
          i += 1;
          continue;
        }
        emitChar(i, cur, stripStrings);
        i += 1;
        if (cur === quote || cur === '\n') break;
      }
      lastSignificantChar = quote;
      lastWord = '';
      continue;
    }

    // 模板字符串 `...`
    if (ch === '`') {
      emitChar(i, ch, stripStrings);
      i += 1;
      while (i < n) {
        const cur = source[i];
        if (cur === '\\' && i + 1 < n) {
          emitChar(i, cur, stripStrings);
          i += 1;
          emitChar(i, source[i], stripStrings);
          i += 1;
          continue;
        }
        if (cur === '$' && source[i + 1] === '{') {
          emitChar(i, cur, stripStrings);
          i += 1;
          emitChar(i, '{', stripStrings);
          i += 1;
          templateBraceStack.push(0);
          lastSignificantChar = '{';
          lastWord = '';
          break;
        }
        emitChar(i, cur, stripStrings);
        i += 1;
        if (cur === '`') {
          lastSignificantChar = '`';
          lastWord = '';
          break;
        }
      }
      continue;
    }

    // 模板字符串表达式结束，回到模板字面量继续扫描
    if (ch === '}' && templateBraceStack.length > 0) {
      const depth = templateBraceStack[templateBraceStack.length - 1];
      if (depth === 0) {
        templateBraceStack.pop();
        emitChar(i, ch, stripStrings);
        i += 1;
        while (i < n) {
          const cur = source[i];
          if (cur === '\\' && i + 1 < n) {
            emitChar(i, cur, stripStrings);
            i += 1;
            emitChar(i, source[i], stripStrings);
            i += 1;
            continue;
          }
          if (cur === '$' && source[i + 1] === '{') {
            emitChar(i, cur, stripStrings);
            i += 1;
            emitChar(i, '{', stripStrings);
            i += 1;
            templateBraceStack.push(0);
            lastSignificantChar = '{';
            lastWord = '';
            break;
          }
          emitChar(i, cur, stripStrings);
          i += 1;
          if (cur === '`') {
            lastSignificantChar = '`';
            lastWord = '';
            break;
          }
        }
        continue;
      } else {
        templateBraceStack[templateBraceStack.length - 1] = depth - 1;
      }
    } else if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] += 1;
    }

    // 正则字面量 /pattern/flags
    if (ch === '/' && next !== '/' && next !== '*' && canStartRegex()) {
      emitChar(i, ch, stripStrings);
      i += 1;
      let inCharClass = false;
      while (i < n) {
        const cur = source[i];
        if (cur === '\\' && i + 1 < n) {
          emitChar(i, cur, stripStrings);
          i += 1;
          emitChar(i, source[i], stripStrings);
          i += 1;
          continue;
        }
        if (cur === '\n') {
          emitChar(i, cur, false);
          i += 1;
          break;
        }
        if (cur === '[') inCharClass = true;
        else if (cur === ']') inCharClass = false;
        emitChar(i, cur, stripStrings);
        i += 1;
        if (cur === '/' && !inCharClass) {
          while (i < n && /[a-z]/i.test(source[i])) {
            emitChar(i, source[i], stripStrings);
            i += 1;
          }
          break;
        }
      }
      lastSignificantChar = '/';
      lastWord = '';
      continue;
    }

    // 标识符追踪（用于识别 return /regex/ 等关键字）
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(source[i])) {
        out[i] = source[i];
        i += 1;
      }
      lastWord = source.slice(start, i);
      lastSignificantChar = lastWord[lastWord.length - 1];
      continue;
    }

    out[i] = ch;
    if (!/\s/.test(ch)) {
      lastSignificantChar = ch;
      lastWord = '';
    }
    i += 1;
  }

  return out.join('');
}

/** 仅剥离 JS/TS 注释，保留字符串字面量与精确行号。 */
export function stripJsComments(source) {
  return scanJsSource(source, false);
}

/** 剥离 JS/TS 注释、字符串字面量、模板文本与正则字面量，保留精确行号。 */
export function stripJsCommentsAndStrings(source) {
  return scanJsSource(source, true);
}

/** 规范化邻接表（兼容 Map 或普通对象），保证确定性字典序。 */
function normalizeAdjacency(adjacency) {
  const map = new Map();
  const entries = adjacency instanceof Map ? adjacency.entries() : Object.entries(adjacency || {});

  for (const [node, neighbors] of entries) {
    if (!map.has(node)) map.set(node, new Set());
    if (!neighbors) continue;
    for (const target of neighbors) {
      map.get(node).add(target);
      if (!map.has(target)) map.set(target, new Set());
    }
  }

  const sortedNodes = [...map.keys()].sort();
  const normalized = new Map();
  for (const node of sortedNodes) {
    normalized.set(node, [...map.get(node)].sort());
  }
  return normalized;
}

/**
 * 标准 Tarjan 强连通分量（SCC）算法。
 * 返回所有强连通分量（按分量内字典序、分量间首节点字典序稳定排序）。
 */
export function findStronglyConnectedComponents(adjacency) {
  const graph = normalizeAdjacency(adjacency);
  let nextIndex = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];

  function strongConnect(v) {
    indices.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      scc.sort();
      components.push(scc);
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }

  components.sort((a, b) => a[0].localeCompare(b[0]));
  return components;
}

/**
 * 基于 Tarjan SCC 提取所有构成环的强连通分量（节点数 >= 2，或单节点存在自环）。
 * 无环 DAG 返回空数组 []。
 */
export function findCyclicSccs(adjacency) {
  const graph = normalizeAdjacency(adjacency);
  const allSccs = findStronglyConnectedComponents(graph);
  return allSccs.filter((scc) => {
    if (scc.length > 1) return true;
    const only = scc[0];
    return (graph.get(only) || []).includes(only);
  });
}

/** 在单个环 SCC 子图内通过 BFS 找到一条从最小节点出发的最短闭合环路作为示例路径。 */
function findSampleCyclePath(sccNodes, graph) {
  const nodeSet = new Set(sccNodes);
  const start = sccNodes[0];
  if (sccNodes.length === 1) return [start, start];

  const queue = [[start]];
  const visited = new Set([start]);

  while (queue.length > 0) {
    const currentPath = queue.shift();
    const last = currentPath[currentPath.length - 1];
    for (const next of graph.get(last) || []) {
      if (!nodeSet.has(next)) continue;
      if (next === start) return [...currentPath, start];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...currentPath, next]);
      }
    }
  }
  return [...sccNodes, start];
}

function buildCycleDetails(cyclicSccs, graph, edgeEvidenceMap) {
  return cyclicSccs.map((scc) => {
    const nodeSet = new Set(scc);
    const edges = [];
    for (const from of scc) {
      for (const to of graph.get(from) || []) {
        if (!nodeSet.has(to)) continue;
        const key = `${from}=>${to}`;
        const rawRefs = edgeEvidenceMap.get(key) || [];
        edges.push({
          from,
          to,
          references: rawRefs
        });
      }
    }
    return {
      nodes: scc,
      size: scc.length,
      samplePath: findSampleCyclePath(scc, graph),
      edges
    };
  });
}

function walkFilesSync(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target') continue;
      walkFilesSync(fullPath, predicate, results);
    } else if (entry.isFile()) {
      if (!predicate || predicate(entry.name, fullPath)) results.push(fullPath);
    }
  }
  return results;
}

/** 将 com.example.cutdemotwo.* 全包名折叠到 2 级子包名。 */
export function toSecondLevelPackage(fullPackage) {
  if (!fullPackage || fullPackage === BASE_PACKAGE) return '(root)';
  const prefix = `${BASE_PACKAGE}.`;
  const suffix = fullPackage.startsWith(prefix) ? fullPackage.slice(prefix.length) : fullPackage;
  const parts = suffix.split('.').filter(Boolean);
  if (parts.length === 0) return '(root)';
  return parts.slice(0, 2).join('.');
}

function extractJavaPackage(cleanCode, javaRoot, fullPath) {
  const pkgMatch = cleanCode.match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/);
  if (pkgMatch) return pkgMatch[1];
  const relDir = toPosixPath(path.relative(javaRoot, path.dirname(fullPath)));
  return relDir ? `${BASE_PACKAGE}.${relDir.replace(/\//g, '.')}` : BASE_PACKAGE;
}

function isAutoGeneratedFile(source) {
  const head = source.split(/\r?\n/, 8).join('\n');
  return /@Generated\b|DO NOT EDIT|auto-?generated/i.test(head);
}

/**
 * 1. 后端 2 级子包依赖图 + Tarjan SCC 全图环检测
 */
function analyzeBackendPackages(rootDir) {
  const javaRoot = path.join(rootDir, 'src', 'main', 'java', 'com', 'example', 'cutdemotwo');
  const files = walkFilesSync(javaRoot, (name) => name.endsWith('.java'));
  const adjacency = new Map();
  const edgeEvidence = new Map();
  const packageFiles = new Map();

  for (const fullPath of files) {
    const raw = readUtf8NoBom(fullPath);
    const clean = stripJavaCommentsAndStrings(raw);
    const offsets = buildLineOffsets(clean);
    const fullPkg = extractJavaPackage(clean, javaRoot, fullPath);
    const fromPkg = toSecondLevelPackage(fullPkg);
    const sourceClass = path.basename(fullPath, '.java');
    const relFile = toPosixPath(path.relative(rootDir, fullPath));

    if (!adjacency.has(fromPkg)) adjacency.set(fromPkg, new Set());
    if (!packageFiles.has(fromPkg)) packageFiles.set(fromPkg, 0);
    packageFiles.set(fromPkg, packageFiles.get(fromPkg) + 1);

    // 定位 package 声明区间，避免把自身 package 声明当成引用
    const pkgDecl = clean.match(/\bpackage\s+[A-Za-z0-9_.]+\s*;/);
    const pkgStart = pkgDecl ? pkgDecl.index : -1;
    const pkgEnd = pkgDecl ? pkgDecl.index + pkgDecl[0].length : -1;

    const refRegex = /\bcom\.example\.cutdemotwo\.([A-Za-z0-9_.*]+)/g;
    const seenEdgeRefs = new Set();
    let match;
    while ((match = refRegex.exec(clean)) !== null) {
      if (pkgStart >= 0 && match.index >= pkgStart && match.index < pkgEnd) continue;

      const tail = match[1];
      const segments = tail.split('.').filter(Boolean);
      const pkgSegments = [];
      let symbolStartIdx = segments.length;
      for (let idx = 0; idx < segments.length; idx += 1) {
        const seg = segments[idx];
        if (/^[a-z][a-z0-9_]*$/.test(seg)) {
          pkgSegments.push(seg);
        } else {
          symbolStartIdx = idx;
          break;
        }
      }

      const toPkg = pkgSegments.length === 0 ? '(root)' : pkgSegments.slice(0, 2).join('.');
      if (toPkg === fromPkg) continue;

      const targetSymbol = symbolStartIdx < segments.length
        ? segments.slice(symbolStartIdx).join('.')
        : '*';
      const line = offsetToLine(offsets, match.index);
      const refDedupKey = `${toPkg}|${line}|${targetSymbol}`;
      if (seenEdgeRefs.has(refDedupKey)) continue;
      seenEdgeRefs.add(refDedupKey);

      adjacency.get(fromPkg).add(toPkg);
      if (!adjacency.has(toPkg)) adjacency.set(toPkg, new Set());

      const edgeKey = `${fromPkg}=>${toPkg}`;
      if (!edgeEvidence.has(edgeKey)) edgeEvidence.set(edgeKey, []);
      edgeEvidence.get(edgeKey).push({
        sourceClass,
        file: relFile,
        line,
        targetSymbol
      });
    }
  }

  for (const list of edgeEvidence.values()) {
    list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.targetSymbol.localeCompare(b.targetSymbol));
  }

  const normalized = normalizeAdjacency(adjacency);
  const cyclicSccs = findCyclicSccs(normalized);
  const cycles = buildCycleDetails(cyclicSccs, normalized, edgeEvidence);
  let edgeCount = 0;
  for (const targets of normalized.values()) edgeCount += targets.length;

  return {
    scannedFiles: files.length,
    packageCount: normalized.size,
    edgeCount,
    packages: [...normalized.keys()],
    cycles
  };
}

/**
 * 2. 后端 business.*（排除 business.model）类级依赖图 + Tarjan SCC 全图环检测
 */
function analyzeBackendBusinessClasses(rootDir) {
  const businessRoot = path.join(rootDir, 'src', 'main', 'java', 'com', 'example', 'cutdemotwo', 'business');
  const javaRoot = path.join(rootDir, 'src', 'main', 'java', 'com', 'example', 'cutdemotwo');
  const allFiles = walkFilesSync(businessRoot, (name) => name.endsWith('.java'));

  const classMetas = [];
  const classById = new Map();
  const classesByPackage = new Map();

  for (const fullPath of allFiles) {
    const raw = readUtf8NoBom(fullPath);
    const clean = stripJavaCommentsAndStrings(raw);
    const fullPackage = extractJavaPackage(clean, javaRoot, fullPath);
    if (
      fullPackage === `${BASE_PACKAGE}.business.model` ||
      fullPackage.startsWith(`${BASE_PACKAGE}.business.model.`)
    ) {
      continue;
    }

    const simpleName = path.basename(fullPath, '.java');
    const prefix = `${BASE_PACKAGE}.`;
    const pkgRelative = fullPackage.startsWith(prefix) ? fullPackage.slice(prefix.length) : fullPackage;
    const id = `${pkgRelative}.${simpleName}`;
    const relFile = toPosixPath(path.relative(rootDir, fullPath));
    const offsets = buildLineOffsets(clean);

    const meta = { id, simpleName, fullPackage, relFile, clean, offsets };
    classMetas.push(meta);
    classById.set(id, meta);
    if (!classesByPackage.has(fullPackage)) classesByPackage.set(fullPackage, []);
    classesByPackage.get(fullPackage).push(meta);
  }

  const adjacency = new Map();
  const edgeEvidence = new Map();
  for (const meta of classMetas) adjacency.set(meta.id, new Set());

  const addDep = (fromMeta, toMeta, line, via) => {
    if (fromMeta.id === toMeta.id) return;
    adjacency.get(fromMeta.id).add(toMeta.id);
    const key = `${fromMeta.id}=>${toMeta.id}`;
    if (!edgeEvidence.has(key)) edgeEvidence.set(key, []);
    const list = edgeEvidence.get(key);
    if (!list.some((item) => item.line === line && item.via === via)) {
      list.push({
        sourceClass: fromMeta.simpleName,
        targetClass: toMeta.simpleName,
        file: fromMeta.relFile,
        line,
        via
      });
    }
  };

  for (const meta of classMetas) {
    const clean = meta.clean;
    const explicitSimpleImports = new Map();
    const wildcardPackages = new Set();

    // 收集所有 import 语句并在构建正文副本时用空格抹去 package / import（保留换行）
    const bodyChars = [...clean];
    const blankRange = (start, end) => {
      for (let i = start; i < end; i += 1) {
        if (bodyChars[i] !== '\n') bodyChars[i] = ' ';
      }
    };

    const pkgMatch = clean.match(/\bpackage\s+[A-Za-z0-9_.]+\s*;/);
    if (pkgMatch) blankRange(pkgMatch.index, pkgMatch.index + pkgMatch[0].length);

    const importRegex = /\bimport\s+(static\s+)?([A-Za-z0-9_.*]+)\s*;/g;
    let imp;
    while ((imp = importRegex.exec(clean)) !== null) {
      const isStatic = Boolean(imp[1]);
      const imported = imp[2];
      const line = offsetToLine(meta.offsets, imp.index);
      blankRange(imp.index, imp.index + imp[0].length);

      if (imported.endsWith('.*')) {
        const base = imported.slice(0, -2);
        if (isStatic) {
          // import static com.example.cutdemotwo.business.cutting.Foo.*;
          const prefix = `${BASE_PACKAGE}.`;
          if (base.startsWith(prefix)) {
            const candidateId = base.slice(prefix.length);
            if (classById.has(candidateId)) {
              addDep(meta, classById.get(candidateId), line, 'import-static');
            }
          }
        } else {
          // import com.example.cutdemotwo.business.cutting.*;
          // 或 import com.example.cutdemotwo.business.cutting.Foo.*;（嵌套类通配符）
          const prefix = `${BASE_PACKAGE}.`;
          if (base.startsWith(prefix)) {
            const candidateId = base.slice(prefix.length);
            if (classById.has(candidateId)) {
              addDep(meta, classById.get(candidateId), line, 'import-nested');
            }
          }
          wildcardPackages.add(base);
        }
        continue;
      }

      // 显式导入：解析可能指向的顶级业务类（支持静态成员与嵌套类，如 Outer.Inner）
      const segments = imported.split('.');
      const lastSeg = segments[segments.length - 1];
      if (!isStatic && /^[A-Z]/.test(lastSeg)) {
        explicitSimpleImports.set(lastSeg, imported);
      }

      const prefix = `${BASE_PACKAGE}.`;
      if (imported.startsWith(prefix)) {
        const tailSegments = imported.slice(prefix.length).split('.');
        const pkgParts = [];
        let topClassIdx = -1;
        for (let idx = 0; idx < tailSegments.length; idx += 1) {
          if (/^[a-z][a-z0-9_]*$/.test(tailSegments[idx])) {
            pkgParts.push(tailSegments[idx]);
          } else {
            topClassIdx = idx;
            break;
          }
        }
        if (topClassIdx >= 0) {
          const candidateId = `${pkgParts.join('.')}.${tailSegments[topClassIdx]}`;
          if (classById.has(candidateId)) {
            addDep(meta, classById.get(candidateId), line, isStatic ? 'import-static' : 'import');
          }
        }
      }
    }

    const body = bodyChars.join('');

    // 1. 正文中的全限定名引用 com.example.cutdemotwo.business.<subpkg>.<TopClass>
    const fqcnRegex = /\bcom\.example\.cutdemotwo\.(business\.[a-z][a-z0-9_.]*\.[A-Z][A-Za-z0-9_$]*)/g;
    let fqMatch;
    while ((fqMatch = fqcnRegex.exec(body)) !== null) {
      const candidateId = fqMatch[1];
      if (classById.has(candidateId)) {
        const line = offsetToLine(meta.offsets, fqMatch.index);
        addDep(meta, classById.get(candidateId), line, 'fqcn');
      }
    }

    // 2. 同包或通配符导入范围内的裸类名引用
    const visibleCandidates = new Map();
    for (const peer of classesByPackage.get(meta.fullPackage) || []) {
      if (peer.id !== meta.id) visibleCandidates.set(peer.simpleName, peer);
    }
    for (const wp of wildcardPackages) {
      for (const peer of classesByPackage.get(wp) || []) {
        if (peer.id !== meta.id && !visibleCandidates.has(peer.simpleName)) {
          visibleCandidates.set(peer.simpleName, peer);
        }
      }
    }

    for (const [simpleName, targetMeta] of visibleCandidates.entries()) {
      // 如果当前文件显式 import 了另一个包的同名类，则裸写该名不指向同包类
      if (explicitSimpleImports.has(simpleName)) {
        const importedFqcn = explicitSimpleImports.get(simpleName);
        if (importedFqcn !== `${BASE_PACKAGE}.${targetMeta.id}`) continue;
      }

      const idRegex = new RegExp(`(?<![A-Za-z0-9_$.])${escapeRegExp(simpleName)}(?![A-Za-z0-9_$])`, 'g');
      let refMatch;
      while ((refMatch = idRegex.exec(body)) !== null) {
        // 排除方法引用右侧 obj::SimpleName（但保留 SimpleName::new）
        const before = body.slice(Math.max(0, refMatch.index - 2), refMatch.index);
        if (before === '::') continue;
        const line = offsetToLine(meta.offsets, refMatch.index);
        addDep(meta, targetMeta, line, 'same-package-ref');
      }
    }
  }

  for (const list of edgeEvidence.values()) {
    list.sort((a, b) => a.line - b.line || a.via.localeCompare(b.via));
  }

  const normalized = normalizeAdjacency(adjacency);
  const cyclicSccs = findCyclicSccs(normalized);
  const cycles = buildCycleDetails(cyclicSccs, normalized, edgeEvidence);
  let edgeCount = 0;
  for (const targets of normalized.values()) edgeCount += targets.length;

  return {
    scannedClasses: classMetas.length,
    edgeCount,
    cycles
  };
}

/** 解析带注释和尾逗号的 tsconfig.json，提取 baseUrl 与 paths。 */
function loadTsConfigPaths(frontendRoot) {
  const tsconfigPath = path.join(frontendRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return { baseUrl: frontendRoot, paths: [] };
  try {
    const raw = readUtf8NoBom(tsconfigPath);
    const withoutComments = stripJsComments(raw);
    const cleaned = withoutComments.replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(cleaned);
    const opts = parsed?.compilerOptions || {};
    const baseUrl = opts.baseUrl ? path.resolve(frontendRoot, opts.baseUrl) : frontendRoot;
    const paths = [];
    if (opts.paths && typeof opts.paths === 'object') {
      for (const [pattern, targets] of Object.entries(opts.paths)) {
        if (!Array.isArray(targets)) continue;
        paths.push({ pattern, targets });
      }
    }
    return { baseUrl, paths };
  } catch {
    return { baseUrl: frontendRoot, paths: [] };
  }
}

/** 从已剥离注释的前端源码中提取全部静态 import / export ... from 语句与精确行号。 */
export function extractStaticFrontendImports(source) {
  const clean = stripJsComments(source);
  const offsets = buildLineOffsets(clean);
  const results = [];

  // 1. import [type] <clause> from '<spec>'
  // 2. export [type] (* [as id] | { ... }) from '<spec>'
  // 3. import '<spec>' (side-effect import)
  const stmtRegex = new RegExp(
    [
      String.raw`(?:^|[;}\n])\s*(?:import\s+(?:type\s+)?(?:(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))?)\s+from\s+|)['"]([^'"]+)['"])`,
      String.raw`(?:^|[;}\n])\s*(?:export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"])`
    ].join('|'),
    'g'
  );

  let match;
  while ((match = stmtRegex.exec(clean)) !== null) {
    const specifier = match[1] || match[2];
    if (!specifier) continue;
    const matchedText = match[0];
    const keywordOffset = matchedText.search(/\b(?:import|export)\b/);
    const stmtStart = match.index + (keywordOffset >= 0 ? keywordOffset : 0);
    const line = offsetToLine(offsets, stmtStart);
    const trimmed = matchedText.slice(keywordOffset >= 0 ? keywordOffset : 0).trimStart();
    const isExport = trimmed.startsWith('export');
    const isTypeOnly = /^(?:import|export)\s+type\b/.test(trimmed);
    results.push({
      specifier,
      line,
      kind: isExport ? 're-export' : 'import',
      isTypeOnly
    });
  }

  return results;
}

function tryResolveFileCandidate(candidatePath, existingFilesSet) {
  const normalized = path.resolve(candidatePath);
  if (existingFilesSet.has(normalized)) return normalized;

  // 兼容 TypeScript 中 import './foo.js' 指向 foo.ts / foo.tsx 的写法
  if (/\.(?:js|jsx|mjs)$/.test(normalized)) {
    const stem = normalized.replace(/\.(?:js|jsx|mjs)$/, '');
    for (const ext of ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']) {
      const mapped = `${stem}${ext}`;
      if (existingFilesSet.has(mapped)) return mapped;
    }
  }

  // 无扩展名或目录索引解析
  for (const ext of FRONTEND_RESOLVE_EXTENSIONS) {
    const withExt = `${normalized}${ext}`;
    if (existingFilesSet.has(withExt)) return withExt;
  }
  for (const ext of FRONTEND_RESOLVE_EXTENSIONS) {
    const indexFile = path.join(normalized, `index${ext}`);
    if (existingFilesSet.has(indexFile)) return indexFile;
  }

  return null;
}

function resolveFrontendSpecifier(fromFile, specifier, frontendSrc, tsconfig, existingFilesSet) {
  if (!specifier || specifier.startsWith('node:')) return null;
  // 跳过 CSS、图片、JSON 等非代码模块
  if (/\.(?:css|scss|less|svg|png|jpe?g|gif|webp|ico|json|woff2?|ttf|eot)(?:\?.*)?$/i.test(specifier)) {
    return null;
  }
  const cleanSpec = specifier.split('?')[0].split('#')[0];

  // 1. 相对路径
  if (cleanSpec.startsWith('./') || cleanSpec.startsWith('../') || cleanSpec === '.' || cleanSpec === '..') {
    const candidate = path.resolve(path.dirname(fromFile), cleanSpec);
    return tryResolveFileCandidate(candidate, existingFilesSet);
  }

  // 2. tsconfig.json paths 映射
  for (const { pattern, targets } of tsconfig.paths) {
    const starIdx = pattern.indexOf('*');
    if (starIdx === -1) {
      if (cleanSpec === pattern) {
        for (const target of targets) {
          const resolved = tryResolveFileCandidate(path.resolve(tsconfig.baseUrl, target), existingFilesSet);
          if (resolved) return resolved;
        }
      }
    } else {
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (cleanSpec.startsWith(prefix) && cleanSpec.endsWith(suffix) && cleanSpec.length >= prefix.length + suffix.length) {
        const matchedWildcard = cleanSpec.slice(prefix.length, cleanSpec.length - suffix.length);
        for (const target of targets) {
          const substituted = target.replace('*', matchedWildcard);
          const resolved = tryResolveFileCandidate(path.resolve(tsconfig.baseUrl, substituted), existingFilesSet);
          if (resolved) return resolved;
        }
      }
    }
  }

  // 3. baseUrl 直接匹配（仅命中 frontend/src 内源码时才生效，不误解析第三方 npm 包）
  const baseCandidate = path.resolve(tsconfig.baseUrl, cleanSpec);
  if (baseCandidate.startsWith(path.resolve(frontendSrc))) {
    return tryResolveFileCandidate(baseCandidate, existingFilesSet);
  }

  return null;
}

function isExcludedFrontendPath(relPosixPath) {
  const segments = relPosixPath.split('/');
  if (segments.includes('vendor') || segments.includes('__tests__') || segments.includes('node_modules')) {
    return true;
  }
  const fileName = segments[segments.length - 1];
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(fileName)) return true;
  if (/\.min\.[a-z0-9]+$/i.test(fileName)) return true;
  return false;
}

/**
 * 3. 前端 frontend/src 全图静态 import/re-export 依赖图 + Tarjan SCC + useStudioStore 扇入统计
 */
function analyzeFrontend(rootDir) {
  const frontendRoot = path.join(rootDir, 'frontend');
  const frontendSrc = path.join(frontendRoot, 'src');
  if (!fs.existsSync(frontendSrc)) {
    return {
      scannedModules: 0,
      edgeCount: 0,
      cycles: [],
      useStudioStoreFanIn: { target: 'frontend/src/store/useStudioStore.ts', count: 0, files: [] }
    };
  }

  const tsconfig = loadTsConfigPaths(frontendRoot);
  const allSrcFiles = walkFilesSync(frontendSrc, (name, fullPath) => {
    const ext = path.extname(name).toLowerCase();
    if (!FRONTEND_SOURCE_EXTENSIONS.includes(ext)) return false;
    const rel = toPosixPath(path.relative(frontendSrc, fullPath));
    return !isExcludedFrontendPath(rel);
  });

  const existingFilesSet = new Set(allSrcFiles.map((f) => path.resolve(f)));
  const adjacency = new Map();
  const edgeEvidence = new Map();
  const studioStoreFanInMap = new Map();

  for (const fullPath of allSrcFiles) {
    const fromRel = toPosixPath(path.relative(rootDir, fullPath));
    adjacency.set(fromRel, new Set());
  }

  for (const fullPath of allSrcFiles) {
    const fromRel = toPosixPath(path.relative(rootDir, fullPath));
    const source = readUtf8NoBom(fullPath);
    const imports = extractStaticFrontendImports(source);

    for (const imp of imports) {
      const resolvedAbs = resolveFrontendSpecifier(fullPath, imp.specifier, frontendSrc, tsconfig, existingFilesSet);
      if (!resolvedAbs) continue;
      const toRel = toPosixPath(path.relative(rootDir, resolvedAbs));
      if (toRel === fromRel) continue;

      adjacency.get(fromRel).add(toRel);
      const edgeKey = `${fromRel}=>${toRel}`;
      if (!edgeEvidence.has(edgeKey)) edgeEvidence.set(edgeKey, []);
      edgeEvidence.get(edgeKey).push({
        file: fromRel,
        line: imp.line,
        specifier: imp.specifier,
        kind: imp.kind,
        isTypeOnly: imp.isTypeOnly
      });

      if (/\/useStudioStore\.(?:ts|tsx|js|jsx|mts|mjs)$/.test(toRel)) {
        if (!studioStoreFanInMap.has(fromRel)) {
          studioStoreFanInMap.set(fromRel, {
            file: fromRel,
            line: imp.line,
            specifier: imp.specifier,
            typeOnly: imp.isTypeOnly
          });
        } else if (!imp.isTypeOnly) {
          studioStoreFanInMap.get(fromRel).typeOnly = false;
        }
      }
    }
  }

  const normalized = normalizeAdjacency(adjacency);
  const cyclicSccs = findCyclicSccs(normalized);
  const cycles = buildCycleDetails(cyclicSccs, normalized, edgeEvidence);
  let edgeCount = 0;
  for (const targets of normalized.values()) edgeCount += targets.length;

  const fanInFiles = [...studioStoreFanInMap.values()].sort((a, b) => a.file.localeCompare(b.file));

  return {
    scannedModules: allSrcFiles.length,
    edgeCount,
    cycles,
    useStudioStoreFanIn: {
      target: 'frontend/src/store/useStudioStore.ts',
      count: fanInFiles.length,
      files: fanInFiles
    }
  };
}

/**
 * 4.1 超过指定行数（默认 1000 行）的前后端生产源码文件清单（按行数降序）
 */
function findLargeSourceFiles(rootDir, threshold = DEFAULT_LARGE_FILE_THRESHOLD) {
  const results = [];

  const javaRoot = path.join(rootDir, 'src', 'main', 'java');
  for (const fullPath of walkFilesSync(javaRoot, (name) => name.endsWith('.java'))) {
    const raw = readUtf8NoBom(fullPath);
    if (isAutoGeneratedFile(raw)) continue;
    const lines = countLines(raw);
    if (lines > threshold) {
      results.push({
        file: toPosixPath(path.relative(rootDir, fullPath)),
        layer: 'backend',
        lines
      });
    }
  }

  const frontendSrc = path.join(rootDir, 'frontend', 'src');
  for (const fullPath of walkFilesSync(frontendSrc, (name, p) => {
    const ext = path.extname(name).toLowerCase();
    if (!FRONTEND_SOURCE_EXTENSIONS.includes(ext)) return false;
    return !isExcludedFrontendPath(toPosixPath(path.relative(frontendSrc, p)));
  })) {
    const raw = readUtf8NoBom(fullPath);
    if (isAutoGeneratedFile(raw)) continue;
    const lines = countLines(raw);
    if (lines > threshold) {
      results.push({
        file: toPosixPath(path.relative(rootDir, fullPath)),
        layer: 'frontend',
        lines
      });
    }
  }

  results.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  return results;
}

/**
 * 4.2 后端 synchronized 关键字精确位置清单（剥离注释与字符串后逐行匹配）
 */
function findBackendSynchronized(rootDir) {
  const javaRoot = path.join(rootDir, 'src', 'main', 'java');
  const files = walkFilesSync(javaRoot, (name) => name.endsWith('.java'));
  const hits = [];

  for (const fullPath of files) {
    const raw = readUtf8NoBom(fullPath);
    const clean = stripJavaCommentsAndStrings(raw);
    const rawLines = raw.replace(/\r\n/g, '\n').split('\n');
    const cleanLines = clean.replace(/\r\n/g, '\n').split('\n');
    const relFile = toPosixPath(path.relative(rootDir, fullPath));
    const scope = relFile.startsWith('src/main/java/com/example/cutdemotwo/') ? 'app' : 'changyang';

    for (let idx = 0; idx < cleanLines.length; idx += 1) {
      const cleanLine = cleanLines[idx];
      if (!/\bsynchronized\b/.test(cleanLine)) continue;
      const kind = /\bsynchronized\s*\(/.test(cleanLine) ? 'block' : 'method';
      hits.push({
        file: relFile,
        line: idx + 1,
        scope,
        kind,
        snippet: (rawLines[idx] || '').trim()
      });
    }
  }

  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return hits;
}

/**
 * 4.3 通用画布 WorkbenchBoardCanvas.tsx 边界校验（禁止直接 import store 或调用 /api/）
 */
function checkWorkbenchCanvasBoundary(rootDir) {
  const relFile = 'frontend/src/components/WorkbenchBoardCanvas.tsx';
  const fullPath = path.join(rootDir, 'frontend', 'src', 'components', 'WorkbenchBoardCanvas.tsx');
  if (!fs.existsSync(fullPath)) {
    return {
      file: relFile,
      exists: false,
      importsStore: false,
      callsApi: false,
      passed: true,
      violations: []
    };
  }

  const raw = readUtf8NoBom(fullPath);
  const rawLines = raw.replace(/\r\n/g, '\n').split('\n');
  const violations = [];
  let importsStore = false;
  let callsApi = false;

  // 检查静态 import/re-export 是否直接引用 store
  const imports = extractStaticFrontendImports(raw);
  for (const imp of imports) {
    const normalizedSpec = imp.specifier.replace(/\\/g, '/');
    const resolvedDir = toPosixPath(path.resolve(path.dirname(fullPath), normalizedSpec));
    const hitsStore =
      /(?:^|\/)store(?:\/|$)/.test(normalizedSpec) ||
      /useStudioStore/i.test(normalizedSpec) ||
      resolvedDir.includes('/frontend/src/store/');
    if (hitsStore) {
      importsStore = true;
      violations.push({
        file: relFile,
        line: imp.line,
        rule: 'canvas-no-store-import',
        snippet: (rawLines[imp.line - 1] || '').trim()
      });
    }
  }

  // 检查非注释代码中的 /api/ 字面量
  const noCommentsLines = stripJsComments(raw).replace(/\r\n/g, '\n').split('\n');
  for (let idx = 0; idx < noCommentsLines.length; idx += 1) {
    if (/\/api\//.test(noCommentsLines[idx])) {
      callsApi = true;
      violations.push({
        file: relFile,
        line: idx + 1,
        rule: 'canvas-no-api-call',
        snippet: (rawLines[idx] || '').trim()
      });
    }
  }

  // 检查非注释、非字符串代码中的直接网络调用原语 fetch / XMLHttpRequest / EventSource
  const codeOnlyLines = stripJsCommentsAndStrings(raw).replace(/\r\n/g, '\n').split('\n');
  for (let idx = 0; idx < codeOnlyLines.length; idx += 1) {
    if (/(?<![.\w$])(?:fetch\s*\(|XMLHttpRequest\b|EventSource\b)/.test(codeOnlyLines[idx])) {
      callsApi = true;
      if (!violations.some((v) => v.line === idx + 1 && v.rule === 'canvas-no-api-call')) {
        violations.push({
          file: relFile,
          line: idx + 1,
          rule: 'canvas-no-direct-network',
          snippet: (rawLines[idx] || '').trim()
        });
      }
    }
  }

  violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));

  return {
    file: relFile,
    exists: true,
    importsStore,
    callsApi,
    passed: !importsStore && !callsApi,
    violations
  };
}

/**
 * 执行完整仓库只读 MIT 公理设计架构耦合体检。
 */
export function auditRepository(rootDir, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const largeFileThreshold = Number.isFinite(options.largeFileThreshold)
    ? options.largeFileThreshold
    : DEFAULT_LARGE_FILE_THRESHOLD;

  const backendPackages = analyzeBackendPackages(resolvedRoot);
  const backendBusinessClasses = analyzeBackendBusinessClasses(resolvedRoot);
  const frontend = analyzeFrontend(resolvedRoot);
  const largeFiles = findLargeSourceFiles(resolvedRoot, largeFileThreshold);
  const backendSynchronized = findBackendSynchronized(resolvedRoot);
  const canvasBoundary = checkWorkbenchCanvasBoundary(resolvedRoot);

  const totalCycles =
    backendPackages.cycles.length +
    backendBusinessClasses.cycles.length +
    frontend.cycles.length;

  const appSyncCount = backendSynchronized.filter((item) => item.scope === 'app').length;
  const appMethodSyncCount = backendSynchronized.filter(
    (item) => item.scope === 'app' && item.kind === 'method'
  ).length;
  const changyangSyncCount = backendSynchronized.filter((item) => item.scope === 'changyang').length;

  return {
    schemaVersion: '1.0',
    readOnly: true,
    auditedAt: new Date().toISOString(),
    rootDir: toPosixPath(resolvedRoot),
    thresholds: {
      largeFileLines: largeFileThreshold
    },
    summary: {
      verdict: totalCycles === 0 ? 'PASS' : 'FAIL',
      satisfiesLowerTriangularMatrix: totalCycles === 0,
      totalCycles,
      backendPackageCycleCount: backendPackages.cycles.length,
      backendBusinessClassCycleCount: backendBusinessClasses.cycles.length,
      frontendImportCycleCount: frontend.cycles.length,
      largeFileCount: largeFiles.length,
      useStudioStoreFanInCount: frontend.useStudioStoreFanIn.count,
      backendSynchronizedCount: backendSynchronized.length,
      backendAppSynchronizedCount: appSyncCount,
      backendAppMethodSynchronizedCount: appMethodSyncCount,
      backendChangyangSynchronizedCount: changyangSyncCount,
      canvasBoundaryPassed: canvasBoundary.passed
    },
    backendPackages,
    backendBusinessClasses,
    frontend: {
      scannedModules: frontend.scannedModules,
      edgeCount: frontend.edgeCount,
      cycles: frontend.cycles
    },
    hotspots: {
      largeFiles,
      useStudioStoreFanIn: frontend.useStudioStoreFanIn,
      backendSynchronized,
      canvasBoundary
    }
  };
}

/**
 * 将结构化体检结果格式化为符合 GEMINI.md 实质审查风格的中文 Markdown 报告。
 */
export function formatMarkdownReport(report) {
  const s = report.summary;
  const lines = [];

  lines.push('# MIT 公理设计架构耦合体检报告（只读）');
  lines.push('');
  lines.push('> **安全声明**：本报告由 `scripts/arch-coupling-audit.mjs` 纯只读静态扫描生成，**仅提供只读诊断，绝不自动修改任何业务代码**。');
  lines.push(`> 扫描目录：\`${report.rootDir}\` ｜ 生成时间：\`${report.auditedAt}\``);
  lines.push('');

  // 一、一屏核心裁决
  lines.push('## 一、核心裁决（MIT 公理设计 · 独立公理）');
  lines.push('');
  if (s.satisfiesLowerTriangularMatrix) {
    lines.push('**裁决：通过（满足下三角无环设计矩阵）**。');
    lines.push(
      `后端 2 级子包（${report.backendPackages.packageCount} 个）、后端 \`business.*\` 非模型业务类（${report.backendBusinessClasses.scannedClasses} 个）与前端 \`frontend/src\` 模块（${report.frontend.scannedModules} 个）均保持 **0 循环依赖**；` +
      `当前仍需持续关注 ${s.largeFileCount} 个超过 ${report.thresholds.largeFileLines} 行源码文件、\`useStudioStore\` 直接扇入（${s.useStudioStoreFanInCount} 处）及后端 \`synchronized\` 锁点（主工程 ${s.backendAppSynchronizedCount} 处）。`
    );
  } else {
    lines.push('**裁决：不通过（未满足下三角无环设计矩阵，存在耦合矩阵环）**。');
    lines.push(
      `全仓共检出 **${s.totalCycles} 组强连通循环分量（SCC）**：` +
      `后端 2 级子包环 **${s.backendPackageCycleCount}** 组、后端 \`business.*\` 类环 **${s.backendBusinessClassCycleCount}** 组、前端静态 import 环 **${s.frontendImportCycleCount}** 组；` +
      `同时存在 ${s.largeFileCount} 个超 ${report.thresholds.largeFileLines} 行大文件、\`useStudioStore\` 直接扇入 ${s.useStudioStoreFanInCount} 处与后端 \`synchronized\` ${s.backendSynchronizedCount} 处（主工程 ${s.backendAppSynchronizedCount} 处）。`
    );
  }
  lines.push('');

  // 二、量化指标汇总表
  lines.push('## 二、量化指标汇总');
  lines.push('');
  lines.push('| 体检维度 | 当前值 | 基线说明 / 判定 |');
  lines.push('| --- | ---: | --- |');
  lines.push(`| 后端 2 级子包循环依赖（SCC） | ${s.backendPackageCycleCount} | 扫描 ${report.backendPackages.scannedFiles} 文件 / ${report.backendPackages.packageCount} 子包 / ${report.backendPackages.edgeCount} 跨包边 → ${s.backendPackageCycleCount === 0 ? '无环' : '存在耦合环'} |`);
  lines.push(`| 后端 \`business.*\` 类级环（SCC） | ${s.backendBusinessClassCycleCount} | 扫描 ${report.backendBusinessClasses.scannedClasses} 个非模型类 / ${report.backendBusinessClasses.edgeCount} 类间边 → ${s.backendBusinessClassCycleCount === 0 ? '无环' : '存在耦合环'} |`);
  lines.push(`| 前端 \`frontend/src\` 静态 import 环（SCC） | ${s.frontendImportCycleCount} | 扫描 ${report.frontend.scannedModules} 个生产模块 / ${report.frontend.edgeCount} 依赖边 → ${s.frontendImportCycleCount === 0 ? '无环' : '存在耦合环'} |`);
  lines.push(`| 超过 ${report.thresholds.largeFileLines} 行前后端生产源码文件 | ${s.largeFileCount} | 排除测试、vendor 与生成文件 |`);
  lines.push(`| \`useStudioStore\` 直接扇入文件数 | ${s.useStudioStoreFanInCount} | 仅计入 \`frontend/src\` 非测试生产模块 |`);
  lines.push(`| 后端 \`synchronized\` 位置数 | ${s.backendSynchronizedCount} | 主工程 ${s.backendAppSynchronizedCount} 处（方法级 ${s.backendAppMethodSynchronizedCount} 处），\`changyang\` 内核 ${s.backendChangyangSynchronizedCount} 处 |`);
  const canvasLabel = !report.hotspots.canvasBoundary.exists
    ? '未发现目标文件'
    : (s.canvasBoundaryPassed ? '通过（store=false, api=false）' : `违规（store=${report.hotspots.canvasBoundary.importsStore}, api=${report.hotspots.canvasBoundary.callsApi}）`);
  lines.push(`| 通用画布 \`WorkbenchBoardCanvas.tsx\` 边界 | ${s.canvasBoundaryPassed ? 'PASS' : 'FAIL'} | ${canvasLabel} |`);
  lines.push('');

  // 三、实质隐患与事实证据
  lines.push('## 三、实质隐患与事实证据');
  lines.push('');

  // 3.1 后端 2 级子包环
  lines.push('### 3.1 后端 2 级子包循环依赖');
  lines.push('');
  if (report.backendPackages.cycles.length === 0) {
    lines.push('- 无循环依赖（所有 2 级子包构成严格 DAG）。');
  } else {
    report.backendPackages.cycles.forEach((cycle, idx) => {
      lines.push(`- **包环 #${idx + 1}**（${cycle.size} 节点）：\`${cycle.nodes.join('`, `')}\``);
      lines.push(`  - 示例环路：\`${cycle.samplePath.join(' -> ')}\``);
      for (const edge of cycle.edges) {
        const refSummary = edge.references
          .map((r) => `\`${r.sourceClass}\` → \`${r.targetSymbol}\`（\`${r.file}:${r.line}\`）`)
          .join('；');
        lines.push(`  - 依赖边 \`${edge.from} -> ${edge.to}\`：${refSummary}`);
      }
    });
  }
  lines.push('');

  // 3.2 后端 business.* 类级环
  lines.push('### 3.2 后端 `business.*` 类级循环依赖（不含 `business.model`）');
  lines.push('');
  if (report.backendBusinessClasses.cycles.length === 0) {
    lines.push('- 无循环依赖（全部非模型业务类构成严格 DAG）。');
  } else {
    report.backendBusinessClasses.cycles.forEach((cycle, idx) => {
      lines.push(`- **类环 #${idx + 1}**（${cycle.size} 节点）：\`${cycle.nodes.join('`, `')}\``);
      lines.push(`  - 示例环路：\`${cycle.samplePath.join(' -> ')}\``);
      for (const edge of cycle.edges) {
        const locations = edge.references.map((r) => `\`${r.file}:${r.line}\` (${r.via})`).join('、');
        lines.push(`  - 依赖边 \`${edge.from} -> ${edge.to}\`：${locations}`);
      }
    });
  }
  lines.push('');

  // 3.3 前端循环 import
  lines.push('### 3.3 前端 `frontend/src` 静态 import 循环依赖');
  lines.push('');
  if (report.frontend.cycles.length === 0) {
    lines.push('- 无循环 import（前端生产模块依赖图构成严格 DAG）。');
  } else {
    report.frontend.cycles.forEach((cycle, idx) => {
      lines.push(`- **前端环 #${idx + 1}**（${cycle.size} 节点）：\`${cycle.nodes.join('`, `')}\``);
      lines.push(`  - 示例环路：\`${cycle.samplePath.join(' -> ')}\``);
      for (const edge of cycle.edges) {
        const locations = edge.references
          .map((r) => `\`${r.file}:${r.line}\` (\`${r.specifier}\`${r.isTypeOnly ? ', type-only' : ''})`)
          .join('、');
        lines.push(`  - 依赖边 \`${edge.from} -> ${edge.to}\`：${locations}`);
      }
    });
  }
  lines.push('');

  // 3.4 超大源码文件
  lines.push(`### 3.4 超过 ${report.thresholds.largeFileLines} 行前后端生产源码文件`);
  lines.push('');
  if (report.hotspots.largeFiles.length === 0) {
    lines.push(`- 无超过 ${report.thresholds.largeFileLines} 行的生产源码文件。`);
  } else {
    lines.push('| 排名 | 端别 | 行数 | 文件路径 |');
    lines.push('| ---: | --- | ---: | --- |');
    report.hotspots.largeFiles.forEach((item, idx) => {
      lines.push(`| ${idx + 1} | ${item.layer === 'backend' ? '后端' : '前端'} | ${item.lines} | \`${item.file}\` |`);
    });
  }
  lines.push('');

  // 3.5 useStudioStore 直接扇入
  lines.push('### 3.5 `useStudioStore` 直接扇入清单');
  lines.push('');
  const fanIn = report.hotspots.useStudioStoreFanIn;
  if (fanIn.count === 0) {
    lines.push('- 无直接扇入生产文件。');
  } else {
    lines.push(`共 **${fanIn.count}** 个生产源码文件直接导入 \`${fanIn.target}\`：`);
    lines.push('');
    for (const item of fanIn.files) {
      lines.push(`- \`${item.file}:${item.line}\`（\`${item.specifier}\`${item.typeOnly ? '，仅类型导入' : ''}）`);
    }
  }
  lines.push('');

  // 3.6 后端 synchronized 精确清单
  lines.push('### 3.6 后端 `synchronized` 关键字位置清单');
  lines.push('');
  if (report.hotspots.backendSynchronized.length === 0) {
    lines.push('- 后端源码未检出 `synchronized` 关键字。');
  } else {
    lines.push('| 归属 | 粒度 | 位置 | 代码摘要 |');
    lines.push('| --- | --- | --- | --- |');
    for (const hit of report.hotspots.backendSynchronized) {
      const safeSnippet = hit.snippet.replace(/\|/g, '\\|').replace(/`/g, "'");
      lines.push(`| ${hit.scope === 'app' ? '主工程' : 'changyang'} | ${hit.kind === 'method' ? '方法锁' : '代码块锁'} | \`${hit.file}:${hit.line}\` | \`${safeSnippet}\` |`);
    }
  }
  lines.push('');

  // 3.7 通用画布边界校验
  lines.push('### 3.7 通用画布 `WorkbenchBoardCanvas.tsx` 边界校验');
  lines.push('');
  const canvas = report.hotspots.canvasBoundary;
  if (!canvas.exists) {
    lines.push(`- 目标文件 \`${canvas.file}\` 不存在（已跳过）。`);
  } else if (canvas.passed) {
    lines.push(`- **通过**：\`${canvas.file}\` 未直接 import store（\`importsStore=false\`），未直接调用 \`/api/\` 或网络原语（\`callsApi=false\`）。`);
  } else {
    lines.push(`- **违规**：\`${canvas.file}\` 破坏通用画布边界（\`importsStore=${canvas.importsStore}\`, \`callsApi=${canvas.callsApi}\`）：`);
    for (const v of canvas.violations) {
      lines.push(`  - \`${v.file}:${v.line}\` [${v.rule}]：\`${v.snippet}\``);
    }
  }
  lines.push('');

  // 四、只读治理优先级清单
  lines.push('## 四、治理优先级建议（只读诊断，不自动改码）');
  lines.push('');
  const actions = [];
  if (s.backendPackageCycleCount > 0) {
    actions.push(`P0 · 优先解除 ${s.backendPackageCycleCount} 组后端 2 级子包环（将跨子包共享契约下沉至底层无依赖子包）。`);
  }
  if (s.backendBusinessClassCycleCount > 0) {
    actions.push(`P0 · 优先解除 ${s.backendBusinessClassCycleCount} 组后端 \`business.*\` 类级环（抽取命令接口/单向映射器或复用父类异常）。`);
  }
  if (s.frontendImportCycleCount > 0) {
    actions.push(`P0 · 优先解除 ${s.frontendImportCycleCount} 组前端循环 import（抽取纯类型模块切断互引）。`);
  }
  if (!canvas.passed) {
    actions.push(`P0 · 立即清理 \`${canvas.file}\` 中的 ${canvas.violations.length} 处越界 store/API 引用。`);
  }
  if (s.backendAppMethodSynchronizedCount > 0) {
    actions.push(`P1 · 核查主工程 ${s.backendAppMethodSynchronizedCount} 处方法级 \`synchronized\`，确认不存在多余粗粒度锁回流。`);
  }
  if (s.useStudioStoreFanInCount > 12) {
    actions.push(`P1 · \`useStudioStore\` 直接扇入达 ${s.useStudioStoreFanInCount} 个文件，建议按业务域切片降低耦合面。`);
  }
  if (s.largeFileCount > 0) {
    const top = report.hotspots.largeFiles[0];
    actions.push(`P2 · 跟踪 ${s.largeFileCount} 个超 ${report.thresholds.largeFileLines} 行热点文件（最大：\`${top.file}\` ${top.lines} 行），新增逻辑避免继续堆入巨石文件。`);
  }
  if (actions.length === 0) {
    actions.push('当前全部架构耦合红线均满足 MIT 公理设计独立公理，建议在 CI 或本地预检中持续执行 `--fail-on-cycle` 防止回归。');
  }
  for (const act of actions) {
    lines.push(`- ${act}`);
  }
  lines.push('');

  return lines.join('\n');
}

/** 解析 CLI 参数。 */
export function parseCliArgs(argv, defaultRoot) {
  const args = {
    root: defaultRoot,
    format: 'md',
    output: null,
    failOnCycle: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
    } else if (token === '--fail-on-cycle') {
      args.failOnCycle = true;
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
    '用法：node scripts/arch-coupling-audit.mjs [选项]',
    '',
    '只读 MIT 公理设计架构耦合体检 CLI（绝不修改任何业务源码）',
    '',
    '选项：',
    '  --root <dir>      待扫描仓库根目录（默认当前仓库根目录）',
    '  --format md|json  报告输出格式（默认 md）',
    '  --output <file>   可选，将只读报告写入指定文件',
    '  --fail-on-cycle   存在后端包环、业务类环或前端 import 环时返回退出码 1',
    '  -h, --help        显示本帮助信息'
  ].join('\n');
}

/** 运行 CLI 主流程，返回退出码（0 / 1 / 2）。 */
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

  const report = auditRepository(args.root);
  const rendered = args.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatMarkdownReport(report);

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, rendered, 'utf8');
    io.stderr.write(`只读架构耦合体检报告已写入：${toPosixPath(args.output)}\n`);
  } else {
    io.stdout.write(rendered);
  }

  if (args.failOnCycle && report.summary.totalCycles > 0) {
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
