#!/usr/bin/env node
/**
 * E2E-M4 路线 C（F13 生产级多格式导入导出 + F14 Benchmark 门禁与 /api/v2/* 全契约收敛）真机端到端黑盒验收脚本。
 *
 * 覆盖全部 27 项真实黑盒校验（skipped = 0）：
 *  - F13（7 正 + 7 负）：
 *    F13-T1-01..07：GB18030/分号 CSV + 多 Sheet BOM Excel、DXF($INSUNITS+LWPOLYLINE+holes) 需求与模板、
 *      批量母卷/料头导入(模板下载+预览零写+原子提交+幂等+血统)、批量瑕疵导入(0.1mm+captureId 跳过)、
 *      5 种 CAM 格式(dxf_r12/dxf_lwpolyline/dxf_aama/plt/nc)字节验证、1D 分切(JSON/CSV/XLSX)+随工单 PDF+5-Sheet 汇总报表、
 *      流式批量 ZIP + manifest.json 跨维 SKIPPED + 防 Zip Slip；
 *    F13-T2-01..07：前端错表/CIRCULAR_BOM/非法 DXF 拦截、批导混合坏行原子全回滚、幂等键缺失/409冲突/500行边界、
 *      CSV/XLSX 公式注入中和与 PDF 控制字符/代理对防护、导出越界/跨维错配/404/日期倒挂/51方案上限、
 *      --auth 导出与批导 RBAC/Agent 防火墙(401/403+UI告警)、SCRAPPED/RESERVED 母卷保护与 >2MB 413 拦截；
 *  - F14（5 正 + 5 负）：
 *    T1-F14-01..05：benchmark/gate.mjs (--base + 动态空闲端口 --auth) 8/8 PASS、benchmark单测(27/27)+闭环/架构门禁 0 违规、
 *      OpenAPI 3.1.0 104/116 一致、/api/v2/* 关键端点联通与无死链浏览、MCP 25/25 契约全绿；
 *    T2-F14-01..05：人工 99.9% 红线触发退出码 1、不可达/8080 护栏触发退出码 2、--auth 无令牌拦截(退出码 2 + 401)、
 *      已下线 /api/* 与 /api/v1/* 返回 404、防遗漏闭环沙盒捕获 v2-missing-in-openapi/unregistered-legacy-endpoint/new-large-source-file；
 *  - Tier 3（3 组）：
 *    T3-F13×F14-01、T3-F07×F13-01、T3-F14×F11-01。
 *
 * 严禁连接正式 8080 端口或修改正式 data/cutdemo-state.json。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROD_STATE_FILE = path.join(REPO_ROOT, 'data', 'cutdemo-state.json');
const PROD_DRAFTS_DIR = path.join(REPO_ROOT, 'data', 'cutdemo-state.json.drafts');
const DEFAULT_JAR = path.join(REPO_ROOT, 'target', 'CutDemoTwo-0.0.1-SNAPSHOT.jar');
const STATIC_OPENAPI_FILE = path.join(REPO_ROOT, 'src', 'main', 'resources', 'static', 'api-v2', 'openapi.json');
const AUDIT_CLI = path.join(REPO_ROOT, 'scripts', 'workflow-closure-audit.mjs');
const ARCH_CLI = path.join(REPO_ROOT, 'scripts', 'arch-coupling-audit.mjs');
const BENCH_GATE_CLI = path.join(REPO_ROOT, 'benchmark', 'gate.mjs');
const BENCH_RUN_CLI = path.join(REPO_ROOT, 'benchmark', 'run.mjs');
const SHEETJS_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'vendor', 'sheetjs', 'xlsx.mini.min.js');

const require = createRequire(import.meta.url);
const XLSX = require(SHEETJS_PATH);

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 2) {
      out[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function validateBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    throw new Error('必须提供非 8080 隔离实例 --base-url 或环境变量 BASE_URL');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`非法 BASE_URL: ${trimmed}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`仅允许 http/https 协议: ${trimmed}`);
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`严禁连接非本机地址（仅允许 127.0.0.1 或 localhost）: ${trimmed}`);
  }
  if (!parsed.port || parsed.port === '8080') {
    throw new Error(`严禁连接默认或正式 8080 端口: ${trimmed}`);
  }
  return trimmed;
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fingerprintDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return 'ABSENT';
  const hash = createHash('sha256');
  const entries = fs.readdirSync(dirPath).sort();
  for (const name of entries) {
    const full = path.join(dirPath, name);
    const stat = fs.statSync(full);
    hash.update(`${name}|${stat.isDirectory() ? 'D' : 'F'}|${stat.size}|${Math.round(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex');
}

function resolvePlaywrightPath() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require.resolve(name, { paths: [REPO_ROOT, path.join(REPO_ROOT, 'frontend')] });
    } catch {}
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'),
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright-core'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'node_modules', 'playwright-core'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright-core')
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      try {
        return require.resolve(cand);
      } catch {
        return cand;
      }
    }
  }
  throw new Error('未探测到 playwright / playwright-core 模块，请设置环境变量 PLAYWRIGHT_MODULE');
}

function resolveBrowserExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function killPidTree(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isPidAlive(pid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

async function findFreeLoopbackPort(forbiddenSet) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const chosen = typeof addr === 'object' && addr ? addr.port : 0;
        server.close((err) => (err ? reject(err) : resolve(chosen)));
      });
    });
    if (port > 1024 && !forbiddenSet.has(port)) {
      return port;
    }
  }
  throw new Error('未能探测到可用的非冲突回环端口');
}

async function startIsolatedJava({ jarPath, port, statePath, logFile, authEnabled = true }) {
  const javaArgs = [
    '-Xms64m',
    '-Xmx256m',
    '-jar',
    jarPath,
    `--server.port=${port}`,
    '--server.address=127.0.0.1',
    `--cutdemo.state.path=${statePath}`,
    `--cutdemo.jobs.path=${statePath}.jobs`,
    `--cutdemo.integration.path=${statePath}.integrations`,
    `--cutdemo.workbench.drafts.path=${statePath}.drafts`,
    `--cutdemo.security.path=${statePath}.security`,
    `--cutdemo.audit.path=${statePath}.audit`,
    '--cutdemo.seed-demo-data=true',
    `--cutdemo.auth.enabled=${authEnabled ? 'true' : 'false'}`,
    ...(authEnabled ? ['--cutdemo.auth.secret=verify-m4-aux-isolated-secret-32bytes'] : [])
  ];
  const outFd = fs.openSync(logFile, 'w');
  let child;
  try {
    child = spawn('java', javaArgs, {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(outFd);
  }
  child.unref();

  const childBaseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
      throw new Error(`辅助隔离实例提前退出（pid=${child.pid}）:\n${tail}`);
    }
    try {
      const [hRes, meRes] = await Promise.all([
        fetch(`${childBaseUrl}/api/v2/health`),
        fetch(`${childBaseUrl}/api/v2/auth/me`)
      ]);
      if (hRes.ok && meRes.ok) {
        const h = await hRes.json();
        const me = await meRes.json();
        if (h?.status === 'UP' && h?.storageStatus === 'UP' && Boolean(me?.enabled) === authEnabled) {
          return { pid: child.pid, baseUrl: childBaseUrl };
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
  killPidTree(child.pid);
  throw new Error(`辅助隔离实例 45s 内未就绪:\n${tail}`);
}

async function stopIsolatedJava(pid) {
  if (!pid) return;
  killPidTree(pid);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function apiJsonOn(targetBaseUrl, reqPath, init = {}, token = null) {
  const method = (init.method || 'GET').toUpperCase();
  const autoIdem =
    method === 'POST' &&
    (reqPath.includes('/api/v2/optimization-jobs') ||
      reqPath.includes('/api/v2/schemes/confirm') ||
      reqPath.includes('/api/v2/inventory-receipts'))
      ? { 'Idempotency-Key': `e2e-m4-${randomUUID().slice(0, 12)}` }
      : {};
  const headers = {
    Accept: 'application/json',
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...autoIdem,
    ...(init.headers || {})
  };
  const res = await fetch(`${targetBaseUrl}${reqPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data, raw: text };
}

async function fetchBinaryOn(targetBaseUrl, reqPath, init = {}, token = null) {
  const headers = {
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers || {})
  };
  const res = await fetch(`${targetBaseUrl}${reqPath}`, { ...init, headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, headers: res.headers, buf };
}

async function loginAs(targetBaseUrl, username, password) {
  const res = await apiJsonOn(targetBaseUrl, '/api/v2/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  assert.equal(res.status, 200, `登录 ${username} 必须成功: ${res.raw}`);
  assert.ok(res.data?.token, `登录 ${username} 未返回 token`);
  return res.data;
}

// ==================== 纯 Node ZIP / XLSX / PDF 字节解析器 ====================

/**
 * 使用纯 Node Buffer + zlib 解析 ZIP 文件：
 * - 验证 PK\x03\x04 与 End of Central Directory (PK\x05\x06)
 * - 读取 Central Directory 条目与 Local File Header，校验无 Zip Slip 路径穿越
 * - 支持 Stored (0) 与 Deflate (8) 解压并校验未压缩长度
 */
function parseZipArchive(buf) {
  assert.ok(Buffer.isBuffer(buf) && buf.length >= 22, 'ZIP 字节长度不合法');
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP 必须以 PK\\x03\\x04 魔数开头');

  // 搜索 EOCD (0x06054b50)
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let pos = buf.length - 22; pos >= minOffset; pos -= 1) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'ZIP 缺少 End of Central Directory (PK\\x05\\x06)');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  assert.ok(cdOffset + cdSize <= eocdOffset, 'ZIP Central Directory 偏移越界');

  const entries = new Map();
  const entryMeta = [];
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, `Central Directory 第 ${i} 项签名无效`);
    const flags = buf.readUInt16LE(ptr + 8);
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const nameBuf = buf.subarray(ptr + 46, ptr + 46 + nameLen);
    const entryName = nameBuf.toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    // 防 Zip Slip 校验
    assert.ok(!entryName.includes('\0'), `ZipEntry 含空字节: ${entryName}`);
    assert.ok(!entryName.startsWith('/') && !entryName.startsWith('\\'), `ZipEntry 不得以根路径开头: ${entryName}`);
    assert.ok(!entryName.includes('..'), `ZipEntry 含目录穿越 .. : ${entryName}`);

    // 验证对应 Local File Header
    assert.equal(buf.readUInt32LE(localHeaderOffset), 0x04034b50, `Local File Header 签名无效: ${entryName}`);
    const lfNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;

    let compSize = compressedSize;
    let uncompSize = uncompressedSize;
    // 若使用 Data Descriptor (bit 3) 且 CD 有记录，以 CD 为准
    const hasDataDescriptor = (flags & 0x0008) !== 0;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (method === 0) {
      content = Buffer.from(compData);
    } else if (method === 8) {
      content = zlib.inflateRawSync(compData);
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 ${method}: ${entryName}`);
    }
    if (!hasDataDescriptor || uncompSize > 0) {
      assert.equal(content.length, uncompSize, `ZIP 条目解压长度不匹配: ${entryName}`);
    }

    entries.set(entryName, content);
    entryMeta.push({ name: entryName, method, compressedSize: compSize, uncompressedSize: content.length });
  }

  return { entries, entryMeta };
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function extractXmlTagTexts(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities(m[1]));
  }
  return out;
}

/**
 * 纯 Node 解析 .xlsx（基于 parseZipArchive + XML 提取）：
 * 返回 { sheetNames: string[], sheets: Record<string, string[][]> }
 */
function parseXlsxSheets(buf) {
  const { entries } = parseZipArchive(buf);
  const workbookBuf = entries.get('xl/workbook.xml');
  assert.ok(workbookBuf, 'XLSX 缺少 xl/workbook.xml');
  const workbookXml = workbookBuf.toString('utf8');

  const relsBuf = entries.get('xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  if (relsBuf) {
    const relsXml = relsBuf.toString('utf8');
    const relRe = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
    let rm;
    while ((rm = relRe.exec(relsXml)) !== null) {
      let target = rm[2].replace(/^\/+/, '');
      if (!target.startsWith('xl/')) target = `xl/${target}`;
      relMap.set(rm[1], target);
    }
  }

  const sharedStrings = [];
  const sstBuf = entries.get('xl/sharedStrings.xml');
  if (sstBuf) {
    const sstXml = sstBuf.toString('utf8');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let sm;
    while ((sm = siRe.exec(sstXml)) !== null) {
      const parts = extractXmlTagTexts(sm[1], 't');
      sharedStrings.push(parts.join(''));
    }
  }

  const sheetDefs = [];
  const sheetRe = /<sheet\b([^>]+)\/?>/g;
  let shm;
  while ((shm = sheetRe.exec(workbookXml)) !== null) {
    const attrs = shm[1];
    const nameMatch = attrs.match(/\bname="([^"]+)"/);
    const ridMatch = attrs.match(/\br:id="([^"]+)"/);
    const sheetIdMatch = attrs.match(/\bsheetId="(\d+)"/);
    if (nameMatch) {
      const sheetName = decodeXmlEntities(nameMatch[1]);
      const rId = ridMatch ? ridMatch[1] : null;
      const targetPath =
        (rId && relMap.get(rId)) ||
        (sheetIdMatch ? `xl/worksheets/sheet${sheetIdMatch[1]}.xml` : `xl/worksheets/sheet${sheetDefs.length + 1}.xml`);
      sheetDefs.push({ sheetName, targetPath });
    }
  }

  const sheets = {};
  for (const def of sheetDefs) {
    const wsBuf = entries.get(def.targetPath);
    assert.ok(wsBuf, `XLSX 缺少工作表 XML: ${def.targetPath}`);
    const wsXml = wsBuf.toString('utf8');
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rwm;
    while ((rwm = rowRe.exec(wsXml)) !== null) {
      const rowCells = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRe.exec(rwm[1])) !== null) {
        const cAttrs = cm[1];
        const cBody = cm[2];
        const typeMatch = cAttrs.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : 'n';
        let value = '';
        if (cellType === 'inlineStr') {
          value = extractXmlTagTexts(cBody, 't').join('');
        } else if (cellType === 's') {
          const vList = extractXmlTagTexts(cBody, 'v');
          const idx = vList.length ? Number(vList[0]) : -1;
          value = idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
        } else {
          const vList = extractXmlTagTexts(cBody, 'v');
          value = vList.length ? vList[0] : '';
        }
        rowCells.push(value);
      }
      rows.push(rowCells);
    }
    sheets[def.sheetName] = rows;
  }

  return { sheetNames: sheetDefs.map((d) => d.sheetName), sheets };
}

/**
 * 纯 Node 解析纯 Java PDF 1.4 文档与 FlateDecode 内容流：
 * - 验证 %PDF-1.4\n 魔数、%%EOF、/STSong-Light、/UniGB-UTF16-H
 * - 解压全部 FlateDecode 流并提取 ASCII 文本与 UTF-16BE HEX 码元
 */
function parsePdfDocument(buf) {
  assert.ok(Buffer.isBuffer(buf) && buf.length > 64, 'PDF 字节长度不合法');
  const latin1 = buf.toString('latin1');
  assert.ok(latin1.startsWith('%PDF-1.4\n'), 'PDF 必须以 %PDF-1.4\\n 开头');
  assert.ok(latin1.trimEnd().endsWith('%%EOF'), 'PDF 必须以 %%EOF 结尾');
  assert.ok(latin1.includes('/STSong-Light'), 'PDF 必须内嵌 /STSong-Light 字体');
  assert.ok(latin1.includes('/UniGB-UTF16-H'), 'PDF 必须内嵌 /UniGB-UTF16-H 编码');

  const decompressedStreams = [];
  let cursor = 0;
  while (true) {
    const streamKw = buf.indexOf('stream\n', cursor, 'latin1');
    if (streamKw < 0) break;
    const dataStart = streamKw + 'stream\n'.length;
    const endKw = buf.indexOf('\nendstream', dataStart, 'latin1');
    if (endKw < 0) break;
    const rawStream = buf.subarray(dataStart, endKw);
    const inflated = zlib.inflateSync(rawStream).toString('utf8');
    decompressedStreams.push(inflated);
    cursor = endKw + '\nendstream'.length;
  }
  assert.ok(decompressedStreams.length >= 1, 'PDF 应包含至少 1 个 FlateDecode 内容流');

  const fullStream = decompressedStreams.join('\n');
  const decodedStrings = [];
  const hexCodeUnits = [];

  // ASCII: (...) Tj
  const asciiRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
  let am;
  while ((am = asciiRe.exec(fullStream)) !== null) {
    decodedStrings.push(am[1].replace(/\\([()\\])/g, '$1'));
  }

  // UTF-16BE: <HEX> Tj
  const hexRe = /<([0-9A-Fa-f]+)>\s*Tj/g;
  let hm;
  while ((hm = hexRe.exec(fullStream)) !== null) {
    const hex = hm[1];
    const bytes = Buffer.from(hex, 'hex');
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      hexCodeUnits.push(hex.slice(i, i + 4).toUpperCase());
    }
    // UTF-16BE -> UTF-16LE for Node utf16le decoder
    const le = Buffer.allocUnsafe(bytes.length);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      le[i] = bytes[i + 1];
      le[i + 1] = bytes[i];
    }
    decodedStrings.push(le.toString('utf16le'));
  }

  return {
    streamCount: decompressedStreams.length,
    fullStream,
    decodedText: decodedStrings.join('\n'),
    hexCodeUnits
  };
}

// ==================== 测试输入样本构造 ====================

/**
 * 构造真实 GB18030 + 分号 `;` 分隔的 CSV 字节流（无 BOM，触发 gb18030 自动识别）
 * 列：材料型号;裁片名称;宽度(cm);长度(m);数量
 * 行：棉布A;前片;50;1.2;2
 */
function createGb18030SemicolonCsvBuffer() {
  return Buffer.from([
    // 材料型号;裁片名称;宽度(cm);长度(m);数量\n
    0xb2, 0xc4, 0xc1, 0xcf, 0xd0, 0xcd, 0xba, 0xc5, 0x3b,
    0xb2, 0xc3, 0xc6, 0xac, 0xc3, 0xfb, 0xb3, 0xc6, 0x3b,
    0xbf, 0xed, 0xb6, 0xc8, 0x28, 0x63, 0x6d, 0x29, 0x3b,
    0xb3, 0xa4, 0xb6, 0xc8, 0x28, 0x6d, 0x29, 0x3b,
    0xca, 0xfd, 0xc1, 0xbf, 0x0a,
    // 棉布A;前片;50;1.2;2\n
    0xc3, 0xde, 0xb2, 0xbc, 0x41, 0x3b,
    0xc7, 0xb0, 0xc6, 0xac, 0x3b,
    0x35, 0x30, 0x3b,
    0x31, 0x2e, 0x32, 0x3b,
    0x32, 0x0a
  ]);
}

function createXlsxBuffer(sheetSpecs) {
  const wb = XLSX.utils.book_new();
  for (const { name, aoa } of sheetSpecs) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(out);
}

/**
 * 生成带 $INSUNITS=5 (cm)、LWPOLYLINE 闭合外框 (80x60 cm = 800x600 mm)
 * 与 24 顶点 HOLE 圆内孔 (圆心 40,30 cm, 半径 1.0 cm -> 直径 20 mm <= 30 mm 触发 SP2 与 T12+G02/G03) 的 DXF 文本
 */
function createDxfWithInsUnitsAndCircleHole({ material = 'MAT-DXF-HOLE', pieceName = 'PIECE-CIRCLE-HOLE' } = {}) {
  const lines = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1015',
    '9', '$INSUNITS', '70', '5', // 5 = cm (x10 mm)
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    // 外框 LWPOLYLINE (80 x 60 cm = 800 x 600 mm)
    '0', 'LWPOLYLINE', '8', 'OUTLINE', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', '80', '20', '0',
    '10', '80', '20', '60',
    '10', '0', '20', '60',
    // 24 顶点圆形内孔 (圆心 40,30 cm, 半径 1.0 cm -> 直径 20 mm)
    '0', 'LWPOLYLINE', '8', 'HOLE', '90', '24', '70', '1'
  ];
  const cx = 40;
  const cy = 30;
  const r = 1.0;
  for (let i = 0; i < 24; i += 1) {
    const theta = (2 * Math.PI * i) / 24;
    lines.push('10', (cx + r * Math.cos(theta)).toFixed(4));
    lines.push('20', (cy + r * Math.sin(theta)).toFixed(4));
  }
  // 附带文字标签与层提示
  lines.push('0', 'TEXT', '8', 'TEXT', '10', '10', '20', '10', '40', '2', '1', `${pieceName}`);
  lines.push('0', 'TEXT', '8', 'TEXT', '10', '10', '20', '20', '40', '2', '1', `MATERIAL:${material}`);
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

function createBrokenOpenDxf() {
  return [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0',
    '0', 'LINE', '8', '0', '10', '250', '20', '250', '11', '400', '21', '250',
    '0', 'ENDSEC', '0', 'EOF'
  ].join('\n');
}

function parseTapOutput(stdout) {
  const tests = stdout.match(/^# tests (\d+)/m);
  const pass = stdout.match(/^# pass (\d+)/m);
  const fail = stdout.match(/^# fail (\d+)/m);
  const skipped = stdout.match(/^# skipped (\d+)/m);
  return {
    tests: tests ? Number(tests[1]) : null,
    pass: pass ? Number(pass[1]) : null,
    fail: fail ? Number(fail[1]) : null,
    skipped: skipped ? Number(skipped[1]) : null
  };
}

function createSandboxBaselineFiles(overrides = {}) {
  const base = {
    'src/test/java/com/example/cutdemotwo/persistence/OptimizationTestDatabase.java': [
      'package com.example.cutdemotwo.persistence;',
      'public final class OptimizationTestDatabase {',
      '  public static Object create() { return "jdbc:h2:mem:helper"; }',
      '}'
    ].join('\n'),
    'src/test/java/com/example/cutdemotwo/SampleJdbcTests.java': [
      'package com.example.cutdemotwo;',
      'import org.junit.jupiter.api.Tag;',
      'import org.junit.jupiter.api.Test;',
      '@Tag("mysql-integration")',
      'class SampleJdbcTests {',
      '  @Test void works() { OptimizationTestDatabase.create(); }',
      '}'
    ].join('\n'),
    '.github/workflows/image.yml': [
      'name: Verify',
      'jobs:',
      '  mysql-integration:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - run: ./mvnw -B test -Dgroups=mysql-integration',
      '  image:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - run: |',
      '          node --test integrations/inventory/test/sync-worker.test.mjs',
      '          node --test scripts/arch-coupling-audit.test.mjs',
      '          node scripts/arch-coupling-audit.mjs --fail-on-cycle',
      '          node --test scripts/workflow-closure-audit.test.mjs',
      '          node scripts/workflow-closure-audit.mjs --fail'
    ].join('\n'),
    Dockerfile: [
      'FROM node:22-bookworm-slim AS frontend-tests',
      'RUN node --test integrations/inventory/test/sync-worker.test.mjs \\',
      '    && node --test scripts/arch-coupling-audit.test.mjs \\',
      '    && node scripts/arch-coupling-audit.mjs --fail-on-cycle \\',
      '    && node --test scripts/workflow-closure-audit.test.mjs \\',
      '    && node scripts/workflow-closure-audit.mjs --fail'
    ].join('\n'),
    'src/main/java/com/example/cutdemotwo/controller/SampleV2Controller.java': [
      'package com.example.cutdemotwo.controller;',
      'import org.springframework.web.bind.annotation.*;',
      '@RestController',
      '@RequestMapping("/api/v2")',
      'class SampleV2Controller {',
      '  @GetMapping("/capabilities") public Object caps() { return null; }',
      '}'
    ].join('\n'),
    'src/main/resources/static/api-v2/openapi.json': JSON.stringify(
      {
        openapi: '3.1.0',
        paths: {
          '/api/v2/capabilities': { get: { summary: 'caps' } }
        }
      },
      null,
      2
    ),
    'frontend/tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'frontend/src/utils/routeUtils.ts': [
      'export const KNOWN_MODERN_ROUTES: readonly string[] = [',
      "  'workbench'",
      '];'
    ].join('\n'),
    '.agents/skills/verify-cutdemotwo/SKILL.md': [
      '# Verify',
      '| Audit | `node scripts/workflow-closure-audit.mjs --fail` |'
    ].join('\n'),
    'scripts/workflow-closure-audit.mjs': '// placeholder\n',
    '.agents/skills/verify-cutdemotwo/features/README.md': '# Index\n- #/workbench\n',
    '.agents/skills/verify-cutdemotwo/features/core-flow.md': [
      '---',
      'routes:',
      '  - workbench',
      '---',
      '# Core Flow'
    ].join('\n')
  };
  for (const [k, v] of Object.entries(overrides)) {
    base[k] = v;
  }
  return base;
}

// ==================== 主验收流程 ====================

const cli = parseCliArgs(process.argv.slice(2));
const baseUrl = validateBaseUrl(cli['base-url'] || process.env.BASE_URL);
const resultFile = String(cli['result-file'] || process.env.RESULT_FILE || '').trim();
const authAdminUser = String(process.env.AUTH_ADMIN_USER || 'admin').trim();
const authAdminPass = String(process.env.AUTH_ADMIN_PASS || 'admin123');
const jarPath = path.resolve(process.env.JAR_PATH || DEFAULT_JAR);
const mainPort = Number(new URL(baseUrl).port);

const prodStateBefore = sha256File(PROD_STATE_FILE);
const prodDraftsBefore = fingerprintDir(PROD_DRAFTS_DIR);

const { chromium } = require(resolvePlaywrightPath());
const executablePath = resolveBrowserExecutable();

const tag = randomUUID().slice(0, 8).toLowerCase();
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), `cutdemo-m4-e2e-${tag}-`));

const checks = [];
const pageErrors = [];
const nativeDialogs = [];
const contextsToClose = [];
const auxChildPids = [];

async function runCheck(id, tier, feature, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({
      id,
      tier,
      feature,
      status: 'PASS',
      durationMs: Date.now() - started,
      detail
    });
  } catch (err) {
    checks.push({
      id,
      tier,
      feature,
      status: 'FAIL',
      durationMs: Date.now() - started,
      detail: String(err?.stack || err)
    });
    throw err;
  }
}

async function createTrackedContext(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1680, height: 960 },
    acceptDownloads: true
  });
  contextsToClose.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => {
    nativeDialogs.push(d.message());
    await d.dismiss();
  });
  return { ctx, page };
}

async function setTokenAndGoto(page, targetBaseUrl, token, hashPath) {
  const normalizedHash = hashPath.startsWith('#') ? hashPath : `#/${hashPath.replace(/^\/+/, '')}`;
  if (!page.url().startsWith(targetBaseUrl)) {
    await page.goto(`${targetBaseUrl}/app/#/login`, { waitUntil: 'networkidle' });
  }
  await page.evaluate((tk) => {
    if (tk) {
      localStorage.setItem('cutplan.auth.token', tk);
    } else {
      localStorage.removeItem('cutplan.auth.token');
    }
  }, token || '');
  await page.goto(`${targetBaseUrl}/app/?v=${Date.now()}${normalizedHash}`, { waitUntil: 'networkidle' });
  if (token) {
    await page.locator('.mp-auth-foot-card').waitFor({ state: 'visible', timeout: 15000 });
  }
}

async function loginViaUi(page, targetBaseUrl, username, password, targetHash = '#/workbench') {
  await page.goto(`${targetBaseUrl}/app/#/login`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('cutplan.auth.token'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#login-username').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: '登录并进入系统', exact: true }).click();
  await page.locator('.mp-auth-foot-card').waitFor({ state: 'visible', timeout: 15000 });
  if (targetHash) {
    await page.goto(`${targetBaseUrl}/app/${targetHash}`, { waitUntil: 'networkidle' });
  }
}

async function readDownloadBuffer(download) {
  const dlPath = await download.path();
  assert.ok(dlPath && fs.existsSync(dlPath), `下载临时文件路径不存在: ${download.suggestedFilename()}`);
  return {
    fileName: download.suggestedFilename(),
    buf: fs.readFileSync(dlPath)
  };
}

let browser;
let failedError = null;
let failureScreenshot = null;

// 共享上下文变量
let authEnabled = false;
let adminToken = null;
let roleCreds = {};
let restrictedAgentToken = null;
let noInvAgentToken = null;
let batchRollIdOk = `R-BATCH-OK-${tag.toUpperCase()}`;
let batchRollIdScrap = `R-BATCH-SCR-${tag.toUpperCase()}`;
let batchRemnantId = `REM-BATCH-${tag.toUpperCase()}`;
let reservedRollId = `R-RESV-${tag.toUpperCase()}`;
let scheme2DHoleId = null;
let scheme1DId = null;
let schemeInjection2DId = null;
let schemeInjection1DId = null;

try {
  // 探测主隔离实例认证状态
  const meProbe = await apiJsonOn(baseUrl, '/api/v2/auth/me');
  assert.equal(meProbe.status, 200, `GET /api/v2/auth/me 失败: ${meProbe.raw}`);
  authEnabled = Boolean(meProbe.data?.enabled);
  if (authEnabled) {
    const adminLogin = await loginAs(baseUrl, authAdminUser, authAdminPass);
    adminToken = adminLogin.token;

    // 创建本次测试所需多角色用户与 Agent 凭证
    const rolesToCreate = [
      { role: 'WAREHOUSE', username: `wh_m4_${tag}`, pass: 'WhM4!2026' },
      { role: 'INSPECTOR', username: `insp_m4_${tag}`, pass: 'InspM4!2026' },
      { role: 'OPERATOR', username: `op_m4_${tag}`, pass: 'OpM4!2026' },
      { role: 'PLANNER', username: `pl_m4_${tag}`, pass: 'PlM4!2026' }
    ];
    for (const u of rolesToCreate) {
      const createRes = await apiJsonOn(
        baseUrl,
        '/api/v2/users',
        {
          method: 'POST',
          body: JSON.stringify({
            username: u.username,
            displayName: `M4测试_${u.role}`,
            role: u.role,
            password: u.pass
          })
        },
        adminToken
      );
      assert.ok(createRes.status === 200 || createRes.status === 201, `创建用户 ${u.username} 失败: ${createRes.raw}`);
      const logged = await loginAs(baseUrl, u.username, u.pass);
      roleCreds[u.role] = { ...u, token: logged.token };
    }

    const ag1 = await apiJsonOn(
      baseUrl,
      '/api/v2/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `M4受限导出Agent_${tag}`,
          scopes: ['DEMAND_READ', 'INVENTORY_READ', 'PLAN_COMPUTE', 'DRAFT_WRITE'],
          expiresInDays: 7
        })
      },
      adminToken
    );
    assert.ok(ag1.status === 200 || ag1.status === 201, `签发 Agent1 失败: ${ag1.raw}`);
    restrictedAgentToken = ag1.data?.token;
    assert.ok(restrictedAgentToken, 'Agent1 未返回明文 token');

    const ag2 = await apiJsonOn(
      baseUrl,
      '/api/v2/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `M4无库存读Agent_${tag}`,
          scopes: ['DEMAND_READ'],
          expiresInDays: 7
        })
      },
      adminToken
    );
    assert.ok(ag2.status === 200 || ag2.status === 201, `签发 Agent2 失败: ${ag2.raw}`);
    noInvAgentToken = ag2.data?.token;
    assert.ok(noInvAgentToken, 'Agent2 未返回明文 token');
  }

  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
  const { page: mainPage } = await createTrackedContext(browser);
  if (authEnabled) {
    await setTokenAndGoto(mainPage, baseUrl, adminToken, '#/demands');
  }

  // ==================== F13 正向 7 项 ====================

  await runCheck('F13-T1-01', 'Tier 1', 'F13', async () => {
    const plannerOrAdminToken = authEnabled ? roleCreds.PLANNER.token : null;
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, plannerOrAdminToken, '#/demands');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/demands`, { waitUntil: 'networkidle' });
    }

    // 1) GB18030 + 分号 CSV 上传到向导
    const gbCsvPath = path.join(tmpWorkDir, `gb18030-${tag}.csv`);
    fs.writeFileSync(gbCsvPath, createGb18030SemicolonCsvBuffer());

    await mainPage.locator('[data-testid="demand-import-wizard-btn"]').click();
    const modal = mainPage.locator('[data-testid="demand-import-modal"]');
    await modal.waitFor({ state: 'visible', timeout: 10000 });

    await modal.locator('[data-testid="demand-import-file-input"]').setInputFiles(gbCsvPath);
    await modal.locator('[data-testid="demand-import-confirm-btn"]').waitFor({ state: 'visible', timeout: 10000 });
    await mainPage.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="demand-import-modal"]');
        return el && el.textContent.includes('gb18030') && el.textContent.includes('棉布A');
      },
      null,
      { timeout: 10000 }
    );
    const csvSummaryText = await modal.innerText();
    assert.ok(csvSummaryText.includes('gb18030'), `应识别 gb18030 编码，实际: ${csvSummaryText}`);
    assert.ok(csvSummaryText.includes('";"'), `应识别分号分隔符，实际: ${csvSummaryText}`);

    await modal.locator('[data-testid="demand-import-confirm-btn"]').click();
    await modal.waitFor({ state: 'hidden', timeout: 10000 });

    // 核对页面表格宽长已自动换算为 500 mm x 1200 mm
    const widthVal = await mainPage.locator('.dc-table-wrap tbody tr').first().locator('input.num-in').nth(0).inputValue();
    const lengthVal = await mainPage.locator('.dc-table-wrap tbody tr').first().locator('input.num-in').nth(1).inputValue();
    assert.equal(Number(widthVal), 500, `50 cm 应换算为 500 mm，实际 ${widthVal}`);
    assert.equal(Number(lengthVal), 1200, `1.2 m 应换算为 1200 mm，实际 ${lengthVal}`);

    // 2) 多 Sheet BOM .xlsx 上传
    const bomXlsxPath = path.join(tmpWorkDir, `multi-sheet-bom-${tag}.xlsx`);
    fs.writeFileSync(
      bomXlsxPath,
      createXlsxBuffer([
        { name: '填表说明', aoa: [['说明文档'], ['本页仅为说明，不应被选为主表']] },
        {
          name: '生产BOM清单',
          aoa: [
            ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)'],
            ['SOFA-SET', 'FRAME-ASM', 2, '', '', '', ''],
            ['FRAME-ASM', 'LEG-01', 4, `BOM-MAT-${tag}`, '实木支腿', 80, 350],
            ['SOFA-SET', 'CUSHION', 3, `BOM-MAT-${tag}`, '座垫主布', 600, 650]
          ]
        }
      ])
    );

    await mainPage.locator('[data-testid="demand-import-wizard-btn"]').click();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    await modal.locator('[data-testid="demand-import-file-input"]').setInputFiles(bomXlsxPath);

    const sheetSelect = modal.locator('[data-testid="demand-import-sheet-select"]');
    await sheetSelect.waitFor({ state: 'visible', timeout: 10000 });
    const selectedSheet = await sheetSelect.inputValue();
    assert.equal(selectedSheet, '生产BOM清单', `多 Sheet 应自动推荐 生产BOM清单，实际 ${selectedSheet}`);

    const rootQtyInput = modal.locator('[data-testid="demand-import-bom-root-qty"]');
    await rootQtyInput.waitFor({ state: 'visible', timeout: 10000 });
    await rootQtyInput.fill('2');

    await modal.locator('[data-testid="demand-import-confirm-btn"]').click();
    await modal.waitFor({ state: 'hidden', timeout: 10000 });

    // 保存到需求库并校验数量展开（2*2*4=16, 2*3=6 -> 共 22）
    const [poolResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/demand-pool') && r.request().method() === 'POST'),
      mainPage.getByRole('button', { name: '仅保存至需求库', exact: true }).click()
    ]);
    assert.ok(poolResp.status() === 200 || poolResp.status() === 201, `BOM 需求保存失败: ${poolResp.status()}`);
    const savedFam = await poolResp.json();
    assert.equal(savedFam.orderedTotal, 22, `BOM 根套件=2 展开总数应为 16+6=22，实际 ${savedFam.orderedTotal}`);
    return {
      csvWidthMm: 500,
      csvLengthMm: 1200,
      recommendedSheet: selectedSheet,
      savedTaskId: savedFam.id,
      orderedTotal: savedFam.orderedTotal
    };
  });

  await runCheck('F13-T1-02', 'Tier 1', 'F13', async () => {
    const dxfPath = path.join(tmpWorkDir, `circle-hole-${tag}.dxf`);
    fs.writeFileSync(dxfPath, createDxfWithInsUnitsAndCircleHole({ material: `DXF-MAT-${tag}`, pieceName: `DXF-PIECE-${tag}` }), 'utf8');

    // 1) #/demands DXF 向导导入 (cm -> mm, 180° 对倒, 1 内孔)
    await mainPage.goto(`${baseUrl}/app/#/demands`, { waitUntil: 'networkidle' });
    await mainPage.locator('[data-testid="demand-dxf-wizard-btn"]').click();
    const dxfModal = mainPage.locator('[data-testid="dxf-import-modal"]');
    await dxfModal.waitFor({ state: 'visible', timeout: 10000 });

    await dxfModal.locator('[data-testid="dxf-import-file-input"]').setInputFiles(dxfPath);
    await dxfModal.locator('[data-testid="dxf-pieces-preview"] svg path').first().waitFor({ state: 'visible', timeout: 10000 });
    const modalText = await dxfModal.innerText();
    assert.ok(modalText.includes('cm') && modalText.includes('×10 mm'), `应识别 $INSUNITS=5 (cm ×10 mm): ${modalText}`);
    assert.ok(modalText.includes('800.0×600.0 mm') || modalText.includes('600.0×800.0 mm'), `应缩放至 800×600 mm: ${modalText}`);
    assert.ok(modalText.includes('1 内孔'), `应标注 1 内孔: ${modalText}`);

    await dxfModal.locator('[data-testid="dxf-rotation-mode-select"]').selectOption('HALF_TURN_180');
    await dxfModal.locator('[data-testid="dxf-import-confirm-btn"]').click();
    await dxfModal.waitFor({ state: 'hidden', timeout: 10000 });

    const [dxfDemandResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/demand-pool') && r.request().method() === 'POST'),
      mainPage.getByRole('button', { name: '仅保存至需求库', exact: true }).click()
    ]);
    assert.ok(dxfDemandResp.status() === 200 || dxfDemandResp.status() === 201, `DXF 需求保存失败: ${dxfDemandResp.status()}`);
    const savedDxfTask = await dxfDemandResp.json();
    const savedPiece = savedDxfTask?.lines?.[0] || savedDxfTask?.demands?.[0];
    assert.ok(savedPiece?.shape?.holes?.length === 1, `持久化裁片应含 1 个内孔，实际 ${savedPiece?.shape?.holes?.length}`);
    assert.equal(savedPiece.allowHalfTurn, true, '应保留 HALF_TURN_180 -> allowHalfTurn=true');

    // 2) #/clusters DXF 导入模板
    await mainPage.goto(`${baseUrl}/app/#/clusters`, { waitUntil: 'networkidle' });
    await mainPage.locator('[data-testid="cluster-open-dxf-import-btn"]').click();
    await dxfModal.waitFor({ state: 'visible', timeout: 10000 });
    await dxfModal.locator('[data-testid="dxf-import-file-input"]').setInputFiles(dxfPath);
    await dxfModal.locator('[data-testid="dxf-pieces-preview"] svg path').first().waitFor({ state: 'visible', timeout: 10000 });

    const [tplResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/demand-templates') && r.request().method() === 'POST'),
      dxfModal.locator('[data-testid="dxf-import-confirm-btn"]').click()
    ]);
    assert.ok(tplResp.status() === 200 || tplResp.status() === 201, `DXF 模板保存失败: ${tplResp.status()}`);
    await dxfModal.waitFor({ state: 'hidden', timeout: 10000 });
    const savedTpl = await tplResp.json();
    const tplSizes = savedTpl?.pieces?.[0]?.sizes || {};
    const firstSizeSpec = Object.values(tplSizes)[0];
    assert.ok(firstSizeSpec && firstSizeSpec.w === 800 && firstSizeSpec.h === 600, `模板裁片尺寸应为 800x600 mm，实际 ${JSON.stringify(firstSizeSpec)}`);
    assert.ok(Array.isArray(firstSizeSpec.v) && firstSizeSpec.v.length >= 4, '模板裁片应保留外轮廓顶点集合 v');
    assert.equal(savedTpl?.dimension, 'CONTOUR_2D', 'DXF 模板维度应为 CONTOUR_2D');

    return {
      dxfTaskId: savedDxfTask.id,
      holeVertices: savedPiece.shape.holes[0].length,
      templateId: savedTpl.id
    };
  });

  await runCheck('F13-T1-03', 'Tier 1', 'F13', async () => {
    const whToken = authEnabled ? roleCreds.WAREHOUSE.token : null;
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, whToken, '#/inventory');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/inventory`, { waitUntil: 'networkidle' });
    }

    await mainPage.locator('[data-testid="inv-open-batch-import-btn"]').click();
    await mainPage.locator('[data-testid="inv-receive-tab-batch-rolls"]').waitFor({ state: 'visible', timeout: 10000 });
    await mainPage.locator('[data-testid="inv-receive-tab-batch-rolls"]').click();

    // 1) 验证模板下载 (.xlsx 与 .csv)
    const [dlXlsx] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 15000 }),
      mainPage.locator('[data-testid="inv-import-template-xlsx-btn"]').click()
    ]);
    const tplXlsx = await readDownloadBuffer(dlXlsx);
    assert.equal(tplXlsx.buf.readUInt32LE(0), 0x04034b50, '母卷 Excel 模板须为有效 XLSX ZIP');

    const [dlCsv] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 15000 }),
      mainPage.locator('[data-testid="inv-import-template-csv-btn"]').click()
    ]);
    const tplCsv = await readDownloadBuffer(dlCsv);
    assert.deepEqual([...tplCsv.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '母卷 CSV 模板须含 UTF-8 BOM');

    // 2) 上传 2 条合法母卷（PASSED + SCRAPPED），先预检零写，再提交入库
    const rollsCsvPath = path.join(tmpWorkDir, `rolls-ok-${tag}.csv`);
    fs.writeFileSync(
      rollsCsvPath,
      [
        '\ufeff母卷号,材料型号,缸号,颜色,有效幅宽(mm),整卷总长(mm),已用长度(mm),剩余长度(mm),报废长度(mm),库位,质检状态,供应商',
        `${batchRollIdOk},M4-FABRIC-${tag},LOT-M4-${tag},云白,2000,60000,0,60000,0,A-01-01,PASSED,M4示范织造`,
        `${batchRollIdScrap},M4-FABRIC-${tag},LOT-M4-${tag},云白,2000,30000,5000,0,25000,A-01-02,SCRAPPED,M4示范织造`
      ].join('\r\n'),
      'utf8'
    );

    await mainPage.locator('[data-testid="inv-import-file-input"]').setInputFiles(rollsCsvPath);
    await mainPage.locator('[data-testid="inv-batch-preview-table"]').waitFor({ state: 'visible', timeout: 10000 });
    const idempKey = await mainPage.locator('[data-testid="inv-import-idempotency-key"]').inputValue();

    const rollsBeforePreview = await apiJsonOn(baseUrl, '/api/v2/rolls', {}, whToken);
    const [previewResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/inventory/import/rolls/preview') && r.request().method() === 'POST'),
      mainPage.locator('[data-testid="inv-import-preview-btn"]').click()
    ]);
    assert.equal(previewResp.status(), 200);
    const previewJson = await previewResp.json();
    assert.equal(previewJson.dryRun, true);
    assert.equal(previewJson.valid, true);

    const rollsAfterPreview = await apiJsonOn(baseUrl, '/api/v2/rolls', {}, whToken);
    assert.equal(rollsAfterPreview.data.length, rollsBeforePreview.data.length, 'Preview 阶段绝不能写入母卷');

    const [commitResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().endsWith('/api/v2/inventory/import/rolls') && r.request().method() === 'POST'),
      mainPage.locator('[data-testid="inv-import-commit-btn"]').click()
    ]);
    assert.equal(commitResp.status(), 200, '母卷批量原子提交应返回 200');
    const commitJson = await commitResp.json();
    assert.equal(commitJson.importedCount, 2);
    assert.equal(commitJson.idempotentReplay, false);

    // 3) 用同 Idempotency-Key + 同载荷调 API 验证幂等重放
    const replayPayload = {
      idempotencyKey: idempKey,
      operator: authEnabled ? roleCreds.WAREHOUSE.username : 'warehouse',
      rows: [
        {
          rollId: batchRollIdOk,
          rollModel: `M4-FABRIC-${tag}`,
          batchNo: `LOT-M4-${tag}`,
          color: '云白',
          width: 2000,
          totalLength: 60000,
          usedLength: 0,
          currentRemainingLength: 60000,
          scrappedLengthMm: 0,
          storageLocation: 'A-01-01',
          inspectionStatus: 'PASSED',
          supplier: 'M4示范织造'
        },
        {
          rollId: batchRollIdScrap,
          rollModel: `M4-FABRIC-${tag}`,
          batchNo: `LOT-M4-${tag}`,
          color: '云白',
          width: 2000,
          totalLength: 30000,
          usedLength: 5000,
          currentRemainingLength: 0,
          scrappedLengthMm: 25000,
          storageLocation: 'A-01-02',
          inspectionStatus: 'SCRAPPED',
          supplier: 'M4示范织造'
        }
      ]
    };
    const replayRes = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls',
      { method: 'POST', headers: { 'Idempotency-Key': idempKey }, body: JSON.stringify(replayPayload) },
      whToken
    );
    assert.equal(replayRes.status, 200, `幂等重放应返回 200: ${replayRes.raw}`);
    assert.equal(replayRes.data?.idempotentReplay, true, '同 Key 同载荷应返回 idempotentReplay=true');

    // 4) 切换料头 Tab 导入引用 batchRollIdOk 的料头，校验血统继承
    await mainPage.locator('[data-testid="inv-receive-tab-batch-remnants"]').click();
    const remCsvPath = path.join(tmpWorkDir, `remnants-ok-${tag}.csv`);
    fs.writeFileSync(
      remCsvPath,
      [
        '\ufeff料头号,来源母卷号,代次,幅宽(mm),长度(mm),库位,状态,质量等级',
        `${batchRemnantId},${batchRollIdOk},1,1800,4500,R-02-01,AVAILABLE,GRADE_A`
      ].join('\r\n'),
      'utf8'
    );
    await mainPage.locator('[data-testid="inv-import-file-input"]').setInputFiles(remCsvPath);
    await mainPage.locator('[data-testid="inv-batch-preview-table"]').waitFor({ state: 'visible', timeout: 10000 });
    const [remCommitResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().endsWith('/api/v2/inventory/import/remnants') && r.request().method() === 'POST'),
      mainPage.locator('[data-testid="inv-import-commit-btn"]').click()
    ]);
    assert.equal(remCommitResp.status(), 200);
    const remCommitJson = await remCommitResp.json();
    assert.equal(remCommitJson.importedCount, 1);

    // 校验血统继承 & 总账平衡
    const remsRes = await apiJsonOn(baseUrl, '/api/v2/remnants', {}, whToken);
    const createdRem = (remsRes.data || []).find((x) => x.id === batchRemnantId);
    assert.ok(createdRem, '应能在 /api/v2/remnants 查到导入料头');
    assert.equal(createdRem.materialBatch, `M4-FABRIC-${tag}`, '料头应自动从来源母卷继承 materialBatch');

    const reconRes = await apiJsonOn(baseUrl, '/api/v2/inventory-ledger/reconciliation', {}, authEnabled ? adminToken : null);
    assert.equal(reconRes.data?.status, 'BALANCED', '批量入库后总账必须保持 BALANCED');

    await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();
    return {
      rollOk: batchRollIdOk,
      rollScrap: batchRollIdScrap,
      remnantId: batchRemnantId,
      inheritedMaterial: createdRem.materialBatch
    };
  });

  await runCheck('F13-T1-04', 'Tier 1', 'F13', async () => {
    const inspToken = authEnabled ? roleCreds.INSPECTOR.token : null;
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, inspToken, '#/inspection');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/inspection`, { waitUntil: 'networkidle' });
    }

    await mainPage.locator('[data-testid="insp-open-batch-defects-btn"]').click();
    const modal = mainPage.locator('[data-testid="insp-batch-defects-modal"]');
    await modal.waitFor({ state: 'visible', timeout: 10000 });

    const capId1 = `CAP-${tag}-01`;
    const capId2 = `CAP-${tag}-02`;
    const capId3 = `CAP-${tag}-03`;

    const defCsv1 = path.join(tmpWorkDir, `defects-1-${tag}.csv`);
    fs.writeFileSync(
      defCsv1,
      [
        '\ufeff母卷号,captureId,x(mm),y(mm),宽度(mm),高度(mm),安全边距(mm),瑕疵类型,类型名称,严重度,描述',
        `${batchRollIdOk},${capId1},100.5,200.0,30.0,40.0,20.0,STAIN,油污,2,批量导入0.1mm测试1`,
        `${batchRollIdOk},${capId2},300.0,500.5,25.0,35.0,20.0,HOLE,破洞,3,批量导入0.1mm测试2`
      ].join('\r\n'),
      'utf8'
    );

    await modal.locator('[data-testid="insp-import-file-input"]').setInputFiles(defCsv1);
    await modal.locator('[data-testid="insp-import-preview-btn"]').waitFor({ state: 'visible', timeout: 10000 });
    const [preResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/inventory/import/defects/preview') && r.request().method() === 'POST'),
      modal.locator('[data-testid="insp-import-preview-btn"]').click()
    ]);
    assert.equal(preResp.status(), 200);
    assert.equal((await preResp.json()).valid, true);

    const [comResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().endsWith('/api/v2/inventory/import/defects') && r.request().method() === 'POST'),
      modal.locator('[data-testid="insp-import-commit-btn"]').click()
    ]);
    assert.equal(comResp.status(), 200);
    const comJson1 = await comResp.json();
    assert.equal(comJson1.importedCount, 2);
    assert.equal(comJson1.skippedCount, 0);

    // 换新 Idempotency-Key 再提交：1 条同 captureId 同内容 + 1 条新瑕疵 -> imported=1, skipped=1
    const secondRes = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/defects',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `DEF-DEDUP-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `DEF-DEDUP-${tag}`,
          rows: [
            {
              rollId: batchRollIdOk,
              captureId: capId1,
              x: 100.5,
              y: 200.0,
              w: 30.0,
              h: 40.0,
              margin: 20.0,
              defectType: 'STAIN',
              typeName: '油污',
              severity: 2,
              points: 2,
              detectionSource: 'BATCH_IMPORT',
              avoidanceStrategy: 'MUST_AVOID',
              description: '批量导入0.1mm测试1'
            },
            {
              rollId: batchRollIdOk,
              captureId: capId3,
              x: 450.0,
              y: 800.0,
              w: 20.0,
              h: 20.0,
              margin: 20.0,
              defectType: 'TEAR',
              typeName: '撕裂',
              severity: 2,
              points: 2,
              description: '新瑕疵3'
            }
          ]
        })
      },
      inspToken
    );
    assert.equal(secondRes.status, 200, `瑕疵 captureId 去重提交失败: ${secondRes.raw}`);
    assert.equal(secondRes.data?.importedCount, 1);
    assert.equal(secondRes.data?.skippedCount, 1);

    const rollDetail = await apiJsonOn(baseUrl, `/api/v2/rolls/${encodeURIComponent(batchRollIdOk)}`, {}, inspToken);
    assert.equal(rollDetail.data?.defects?.length, 3, `母卷瑕疵总数应恰好为 3，实际 ${rollDetail.data?.defects?.length}`);

    if (authEnabled) {
      const auditRes = await apiJsonOn(baseUrl, '/api/v2/audit-logs?action=INVENTORY_IMPORT_DEFECTS&limit=10', {}, adminToken);
      assert.equal(auditRes.status, 200);
      assert.ok((auditRes.data?.items || []).length >= 1, '应落库 INVENTORY_IMPORT_DEFECTS 审计记录');
    }

    await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();
    return { importedFirst: 2, skippedSecond: 1, totalDefectsOnRoll: 3 };
  });

  // 准备用于 F13-T1-05/06/07 的 2D 带孔圆孔方案 & 1D 分切方案
  await runCheck('F13-T1-05', 'Tier 1', 'F13', async () => {
    const actorToken = authEnabled ? adminToken : null;
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, adminToken, '#/results');
    }

    // 构造带 24 顶点圆孔（半径 12mm -> 直径 24mm <= 30mm，0.1mm 量化后圆弧拟合误差 <= 0.02mm < 0.05mm）与外轮廓的 2D 异形排程方案
    const holePts = [];
    for (let i = 0; i < 24; i += 1) {
      const th = (2 * Math.PI * i) / 24;
      holePts.push({
        x: Math.round((400 + 12 * Math.cos(th)) * 10) / 10,
        y: Math.round((300 + 12 * Math.sin(th)) * 10) / 10
      });
    }
    const outerPts = [
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { x: 800, y: 600 },
      { x: 0, y: 600 }
    ];
    const polyShape = { type: 'POLYGON', width: 800, height: 600, vertices: outerPts, holes: [holePts] };

    // 同时创建一个被锁定的实卷 reservedRollId，供 F13-T2-07 测试 ROLL_RESERVED
    const createResv = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `RESV-ROLL-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `RESV-ROLL-${tag}`,
          rows: [
            {
              rollId: reservedRollId,
              rollModel: `M4-HOLE-${tag}`,
              width: 2000,
              totalLength: 40000,
              usedLength: 0,
              currentRemainingLength: 40000,
              scrappedLengthMm: 0,
              inspectionStatus: 'PASSED'
            }
          ]
        })
      },
      actorToken
    );
    assert.equal(createResv.status, 200, `创建预占测试卷失败: ${createResv.raw}`);

    const holeDemandsInput = [
      {
        id: 1,
        name: 'CircleHolePanel',
        width: 800,
        length: 600,
        quantity: 1,
        allowRotation: false,
        shape: polyShape
      }
    ];
    const taskRes = await apiJsonOn(
      baseUrl,
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `M4带圆孔CAM导出任务-${tag}`,
          materialModel: `M4-HOLE-${tag}`,
          dimension: 'CONTOUR_2D',
          bedLengthMm: 2000,
          maxWidthMm: 2000,
          demands: holeDemandsInput
        })
      },
      actorToken
    );
    assert.ok(taskRes.status === 200 || taskRes.status === 201, `创建带孔任务失败: ${taskRes.raw}`);
    const holeTask = taskRes.data;
    const normalizedHoleShape = holeTask?.lines?.[0]?.shape || polyShape;
    const normalizedHoleDemands = [
      {
        id: 1,
        name: 'CircleHolePanel',
        width: normalizedHoleShape.width || 800,
        length: normalizedHoleShape.height || 600,
        quantity: 1,
        allowRotation: false,
        shape: normalizedHoleShape
      }
    ];

    const confirmRes = await apiJsonOn(
      baseUrl,
      '/api/v2/schemes/confirm',
      {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: `CFM-2D-HOLE-${tag}`,
          title: `2D带圆孔CAM测试方案-${tag}`,
          dimension: 'CONTOUR_2D',
          scenarioId: 'SHORTEN_KIT',
          strategyId: 'CONT-01',
          strategyName: '异形带孔排料',
          taskId: holeTask.id,
          taskName: holeTask.name,
          materialMode: 'STOCK_ROLL',
          rollId: reservedRollId,
          materialModel: `M4-HOLE-${tag}`,
          widthMm: 2000,
          canvasLengthMm: 2000,
          windowStartY: 0,
          occupiedLengthMm: 620,
          utilizationPct: 24.0,
          pieceAreaM2: 0.48,
          avoidDefects: true,
          demands: normalizedHoleDemands,
          layout2D: {
            placements: [
              {
                id: 1,
                demandId: 1,
                name: 'CircleHolePanel',
                x: 20,
                y: 20,
                w: 800,
                l: 600,
                rotationDegrees: 0,
                rotated: false,
                shape: normalizedHoleShape
              }
            ],
            leftovers: [],
            cutSteps: []
          }
        })
      },
      actorToken
    );
    assert.equal(confirmRes.status, 200, `确认 2D 带孔方案失败: ${confirmRes.raw}`);
    scheme2DHoleId = confirmRes.data?.scheme?.id || confirmRes.data?.id;
    assert.ok(scheme2DHoleId, '未返回 scheme2DHoleId');

    // 在 #/results/<schemeId> 通过 UI 打开 CAM 弹窗依次导出 5 种工业格式
    await mainPage.goto(`${baseUrl}/app/#/results/${encodeURIComponent(scheme2DHoleId)}`, { waitUntil: 'networkidle' });
    const camBtn = mainPage.locator('[data-testid="res-open-cam-export-modal-btn"]');
    await camBtn.waitFor({ state: 'visible', timeout: 10000 });

    const downloadedFormats = {};
    for (const fmt of ['dxf_r12', 'dxf_lwpolyline', 'dxf_aama', 'plt', 'nc']) {
      await camBtn.click();
      const camModal = mainPage.locator('[data-testid="res-cam-export-modal"]');
      await camModal.waitFor({ state: 'visible', timeout: 10000 });
      await camModal.locator('[data-testid="res-cam-format-select"]').selectOption(fmt);
      if (fmt === 'nc') {
        await camModal.locator('[data-testid="res-cam-overcut-input"]').fill('2');
        await camModal.locator('[data-testid="res-cam-leadin-input"]').fill('4');
        await camModal.locator('[data-testid="res-cam-microjoint-input"]').fill('1.5');
        const dedupCb = camModal.locator('[data-testid="res-cam-dedup-checkbox"]');
        if (!(await dedupCb.isChecked())) await dedupCb.check();
        await camModal.locator('[data-testid="res-cam-cut-tool-input"]').fill('T11');
        await camModal.locator('[data-testid="res-cam-punch-tool-input"]').fill('T12');
      }
      const [dl] = await Promise.all([
        mainPage.waitForEvent('download', { timeout: 15000 }),
        camModal.locator('[data-testid="res-cam-export-submit-btn"]').click()
      ]);
      const { fileName, buf } = await readDownloadBuffer(dl);
      downloadedFormats[fmt] = { fileName, text: buf.toString('utf8') };
      await camModal.waitFor({ state: 'hidden', timeout: 10000 });
    }

    // 验证 5 种工业格式几何与工艺关键字
    const r12 = downloadedFormats.dxf_r12.text;
    assert.ok(r12.includes('AC1009') && r12.includes('$INSUNITS') && r12.includes('1_PIECES_HOLES'), 'dxf_r12 格式校验失败');

    const lwp = downloadedFormats.dxf_lwpolyline.text;
    assert.ok(lwp.includes('AC1015') && lwp.includes('LWPOLYLINE') && lwp.includes('\n70\n1\n') && lwp.includes('1_PIECES_HOLES'), 'dxf_lwpolyline 格式校验失败');

    const aama = downloadedFormats.dxf_aama.text;
    assert.ok(aama.includes('SECTION\n2\nBLOCKS') && aama.includes('\nBLOCK\n') && aama.includes('\nINSERT\n') && aama.includes('\n11\n'), 'dxf_aama 格式校验失败');

    const plt = downloadedFormats.plt.text;
    assert.ok(plt.startsWith('IN;PA;') && plt.includes('SP3;') && plt.includes('SP2;') && plt.includes('SP1;') && plt.trimEnd().endsWith('PU0,0;SP0;'), 'HPGL .plt 格式校验失败');

    const nc = downloadedFormats.nc.text;
    assert.ok(nc.includes('G21') && nc.includes('G90'), 'G-Code 应含 G21 G90');
    assert.ok(nc.includes('M06 T11') && nc.includes('M06 T12'), 'G-Code 应含自定义刀头 M06 T11 与 M06 T12');
    assert.ok(nc.includes('G02') || nc.includes('G03'), '24 顶点圆孔应拟合输出 G02 或 G03');
    assert.ok(nc.includes('Overcut') && nc.includes('Lead-In'), 'G-Code 应含 Overcut 与 Lead-In 工艺指令');
    const holeIdx = nc.indexOf('[INNER HOLE');
    const outerIdx = nc.includes('[OUTER CONTOUR')
      ? nc.indexOf('[OUTER CONTOUR')
      : nc.indexOf('Deduplicated Outer Contour Cut');
    assert.ok(holeIdx >= 0 && outerIdx > holeIdx, 'G-Code 必须严格先切内孔 [INNER HOLE 再切外轮廓');
    assert.ok(nc.includes('M30'), 'G-Code 应以 M30 结束');

    return { scheme2DHoleId, exportedFormats: Object.keys(downloadedFormats) };
  });

  await runCheck('F13-T1-06', 'Tier 1', 'F13', async () => {
    const actorToken = authEnabled ? adminToken : null;

    const slitDemandsInput = [{ id: 1, name: '790窄条', width: 790, length: 1000, quantity: 6, allowRotation: false }];
    // 确认一个标准 1D 分切方案用于测试 1D JSON/CSV/XLSX 导出
    const slitTaskRes = await apiJsonOn(
      baseUrl,
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `M4分切导出任务-${tag}`,
          materialModel: `M4-SLIT-${tag}`,
          dimension: 'SLITTING_1D',
          bedLengthMm: 1000,
          maxWidthMm: 1600,
          demands: slitDemandsInput
        })
      },
      actorToken
    );
    assert.ok(slitTaskRes.status === 200 || slitTaskRes.status === 201);
    const slitTask = slitTaskRes.data;

    const slitConfirmRes = await apiJsonOn(
      baseUrl,
      '/api/v2/schemes/confirm',
      {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: `CFM-1D-${tag}`,
          title: `1D分切导出方案-${tag}`,
          dimension: 'SLITTING_1D',
          scenarioId: 'MIN_CARS',
          strategyId: 'SLIT-01',
          strategyName: '一维分切',
          taskId: slitTask.id,
          taskName: slitTask.name,
          materialMode: 'VIRTUAL_ROLL',
          materialModel: `M4-SLIT-${tag}`,
          widthMm: 1600,
          canvasLengthMm: 3000,
          occupiedLengthMm: 3000,
          utilizationPct: 97.5,
          pieceAreaM2: 4.74,
          demands: slitDemandsInput,
          slitting1D: {
            leftTrimMm: 10,
            rightTrimMm: 10,
            widthStepMm: 10,
            motherWidthMm: 1600,
            minWidthMm: 1580,
            maxWidthMm: 1600,
            fixedLengthMm: 1000,
            totalCars: 3,
            missingRolls: 0,
            overproducedRolls: 0,
            patterns: [
              {
                id: 'PAT-1',
                lengthMm: 1000,
                repetitions: 3,
                usedWidthMm: 1580,
                spareWidthMm: 20,
                stations: [{ widthMm: 790, countPerRepetition: 2 }],
                surfaceTreatment: '标准拉丝',
                allocations: [{ orderId: 'ORD-SLIT-1', quantity: 6 }]
              }
            ],
            fulfillment: [{ orderId: 'ORD-SLIT-1', name: '790窄条', widthMm: 790, requested: 6, produced: 6, missing: 0, overproduced: 0 }]
          }
        })
      },
      actorToken
    );
    assert.equal(slitConfirmRes.status, 200, `确认 1D 方案失败: ${slitConfirmRes.raw}`);
    scheme1DId = slitConfirmRes.data?.scheme?.id || slitConfirmRes.data?.id;

    // 1) 在 #/results/<scheme1DId> 导出 json / csv / xlsx
    await setTokenAndGoto(mainPage, baseUrl, authEnabled ? adminToken : '', `#/results/${encodeURIComponent(scheme1DId)}`);
    const fmtSelect = mainPage.locator('[data-testid="res-slitting-export-format-select"]');
    const slitBtn = mainPage.locator('[data-testid="res-slitting-export-btn"]');
    await fmtSelect.waitFor({ state: 'visible', timeout: 10000 });

    await fmtSelect.selectOption('json');
    const [dlJson] = await Promise.all([mainPage.waitForEvent('download', { timeout: 15000 }), slitBtn.click()]);
    const slitJsonData = JSON.parse((await readDownloadBuffer(dlJson)).buf.toString('utf8'));
    assert.ok(Array.isArray(slitJsonData.patterns) && slitJsonData.patterns.length >= 1, '1D JSON 应包含 patterns');
    assert.ok(Array.isArray(slitJsonData.fulfillment), '1D JSON 应包含 fulfillment');

    await fmtSelect.selectOption('csv');
    const [dlCsv] = await Promise.all([mainPage.waitForEvent('download', { timeout: 15000 }), slitBtn.click()]);
    const slitCsvBuf = (await readDownloadBuffer(dlCsv)).buf;
    assert.deepEqual([...slitCsvBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '1D CSV 必须含 UTF-8 BOM');
    assert.ok(slitCsvBuf.toString('utf8').includes('PAT-1'));

    await fmtSelect.selectOption('xlsx');
    const [dlXlsx] = await Promise.all([mainPage.waitForEvent('download', { timeout: 15000 }), slitBtn.click()]);
    const slitXlsxParsed = parseXlsxSheets((await readDownloadBuffer(dlXlsx)).buf);
    assert.deepEqual(slitXlsxParsed.sheetNames, ['1D分切刀组配方', '订单履约汇总'], '1D XLSX 应精确包含 2 个 Sheet');

    // 2) 在 2D 方案下载随工单 PDF + #/results 弹窗导出汇总 PDF/XLSX
    await setTokenAndGoto(mainPage, baseUrl, authEnabled ? adminToken : '', `#/results/${encodeURIComponent(scheme2DHoleId)}`);
    await mainPage.locator('[data-testid="res-ticket-pdf-download-btn"]').waitFor({ state: 'visible', timeout: 10000 });
    const [dlTicketPdf] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 15000 }),
      mainPage.locator('[data-testid="res-ticket-pdf-download-btn"]').click()
    ]);
    const ticketPdfBuf = (await readDownloadBuffer(dlTicketPdf)).buf;
    const ticketPdfParsed = parsePdfDocument(ticketPdfBuf);
    assert.ok(ticketPdfParsed.decodedText.includes(scheme2DHoleId), '随工单 PDF 内容流应包含方案 ID');

    // 3) #/results 汇总弹窗、#/reconciliation、#/cost-analytics 导出汇总 PDF 与 5-Sheet XLSX
    await mainPage.locator('[data-testid="res-open-summary-export-modal-btn"]').click();
    const sumModal = mainPage.locator('[data-testid="res-summary-export-modal"]');
    await sumModal.waitFor({ state: 'visible', timeout: 10000 });
    await sumModal.locator('[data-testid="res-summary-format-select"]').selectOption('xlsx');
    const [dlSumXlsx] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 15000 }),
      sumModal.locator('[data-testid="res-summary-export-submit-btn"]').click()
    ]);
    const sumXlsxParsed = parseXlsxSheets((await readDownloadBuffer(dlSumXlsx)).buf);
    assert.deepEqual(sumXlsxParsed.sheetNames, [
      '1_总览指标',
      '2_方案台账',
      '3_裁片与分切明细',
      '4_实绩消耗与复检对账',
      '5_成本核算摘要'
    ]);

    await mainPage.goto(`${baseUrl}/app/#/reconciliation`, { waitUntil: 'networkidle' });
    const [dlReconPdf] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 15000 }),
      mainPage.locator('[data-testid="recon-export-summary-pdf-btn"]').click()
    ]);
    parsePdfDocument((await readDownloadBuffer(dlReconPdf)).buf);

    await mainPage.goto(`${baseUrl}/app/#/cost-analytics`, { waitUntil: 'networkidle' });
    const [dlCostXlsx] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 15000 }),
      mainPage.locator('[data-testid="cost-export-summary-xlsx-btn"]').click()
    ]);
    const costXlsxParsed = parseXlsxSheets((await readDownloadBuffer(dlCostXlsx)).buf);
    assert.equal(costXlsxParsed.sheetNames.length, 5);

    return { scheme1DId, slittingSheets: slitXlsxParsed.sheetNames, summarySheets: sumXlsxParsed.sheetNames };
  });

  await runCheck('F13-T1-07', 'Tier 1', 'F13', async () => {
    await mainPage.goto(`${baseUrl}/app/#/results`, { waitUntil: 'networkidle' });
    const cb2d = mainPage.locator(`[data-testid="res-scheme-checkbox-${scheme2DHoleId}"]`);
    const cb1d = mainPage.locator(`[data-testid="res-scheme-checkbox-${scheme1DId}"]`);
    await cb2d.waitFor({ state: 'visible', timeout: 10000 });
    await cb2d.check();
    await cb1d.check();

    await mainPage.locator('[data-testid="res-open-batch-zip-modal-btn"]').click();
    const zipModal = mainPage.locator('[data-testid="res-batch-zip-modal"]');
    await zipModal.waitFor({ state: 'visible', timeout: 10000 });

    // 勾选 slitting_csv（默认已勾选 dxf_lwpolyline, nc, ticket_pdf）
    const slitCsvCheckbox = zipModal.locator('label', { hasText: '1D 分切配方 CSV' }).locator('input[type="checkbox"]');
    if (!(await slitCsvCheckbox.isChecked())) await slitCsvCheckbox.check();

    const [dlZip] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 20000 }),
      zipModal.locator('[data-testid="res-batch-zip-submit-btn"]').click()
    ]);
    const { buf: zipBuf } = await readDownloadBuffer(dlZip);
    const { entries } = parseZipArchive(zipBuf);

    assert.ok(entries.has('manifest.json'), '批量 ZIP 必须包含 manifest.json');
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    assert.equal(manifest.schemeCount, 2);

    const entryKeys = [...entries.keys()];
    assert.ok(entryKeys.some((k) => k.startsWith(`${scheme2DHoleId}/`) && k.endsWith('.dxf')), 'ZIP 应含 2D 方案 DXF');
    assert.ok(entryKeys.some((k) => k.startsWith(`${scheme2DHoleId}/`) && k.endsWith('.pdf')), 'ZIP 应含 2D 方案随工单 PDF');
    assert.ok(entryKeys.some((k) => k.startsWith(`${scheme1DId}/`) && k.endsWith('-slitting.csv')), 'ZIP 应含 1D 方案分切 CSV');

    const skipped2dSlit = manifest.files.find((f) => f.schemeId === scheme2DHoleId && f.format === 'slitting_csv');
    assert.equal(skipped2dSlit?.status, 'SKIPPED', '2D 方案的 slitting_csv 在 manifest 中应标记为 SKIPPED');

    if (authEnabled) {
      const auditRes = await apiJsonOn(baseUrl, '/api/v2/audit-logs?action=EXPORT_BATCH_ZIP&limit=10', {}, adminToken);
      assert.equal(auditRes.status, 200);
      assert.ok((auditRes.data?.items || []).length >= 1, '应落库 EXPORT_BATCH_ZIP 审计');
    }

    return { totalEntries: entries.size, skippedEntry: skipped2dSlit };
  });

  // ==================== F13 负向 7 项 ====================

  await runCheck('F13-T2-01', 'Tier 2', 'F13', async () => {
    await mainPage.goto(`${baseUrl}/app/#/demands`, { waitUntil: 'networkidle' });

    // 1) 表格 / BOM 错误拦截 + 禁用确认 + 下载错误 CSV
    const badBomXlsx = path.join(tmpWorkDir, `bad-bom-${tag}.xlsx`);
    fs.writeFileSync(
      badBomXlsx,
      createXlsxBuffer([
        {
          name: '坏BOM',
          aoa: [
            ['Parent', 'Child', 'QtyPer', 'Material', 'PartName', 'Width(mm)', 'Length(mm)'],
            ['A', 'B', 1, '', '', '', ''],
            ['B', 'A', 1, '', '', '', ''],
            ['D', 'E', 0, 'M-BAD', '零单耗', -100, 0]
          ]
        }
      ])
    );

    await mainPage.locator('[data-testid="demand-import-wizard-btn"]').click();
    const importModal = mainPage.locator('[data-testid="demand-import-modal"]');
    await importModal.waitFor({ state: 'visible', timeout: 10000 });
    await importModal.locator('[data-testid="demand-import-file-input"]').setInputFiles(badBomXlsx);

    const issuesTable = importModal.locator('[data-testid="demand-import-issues-table"]');
    await issuesTable.waitFor({ state: 'visible', timeout: 10000 });
    const issueText = await issuesTable.innerText();
    assert.ok(issueText.includes('CIRCULAR_BOM'), `报错表应含 CIRCULAR_BOM，实际: ${issueText}`);
    assert.equal(await importModal.locator('[data-testid="demand-import-confirm-btn"]').isDisabled(), true, '无有效分组时确认按钮应禁用');

    const [dlErrCsv] = await Promise.all([
      mainPage.waitForEvent('download', { timeout: 10000 }),
      importModal.locator('[data-testid="demand-import-download-errors-btn"]').click()
    ]);
    const errCsvText = (await readDownloadBuffer(dlErrCsv)).buf.toString('utf8');
    assert.ok(errCsvText.includes('CIRCULAR_BOM'), '下载的错误明细 CSV 应包含 CIRCULAR_BOM');
    await importModal.getByRole('button', { name: '取消', exact: true }).click();

    // 2) 未闭合孤立 LINE DXF 拦截
    const brokenDxfPath = path.join(tmpWorkDir, `broken-${tag}.dxf`);
    fs.writeFileSync(brokenDxfPath, createBrokenOpenDxf(), 'utf8');
    await mainPage.locator('[data-testid="demand-dxf-wizard-btn"]').click();
    const dxfModal = mainPage.locator('[data-testid="dxf-import-modal"]');
    await dxfModal.waitFor({ state: 'visible', timeout: 10000 });
    await dxfModal.locator('[data-testid="dxf-import-file-input"]').setInputFiles(brokenDxfPath);
    await dxfModal.locator('.sec-feedback.is-err, [role="alert"]').first().waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await dxfModal.locator('[data-testid="dxf-import-confirm-btn"]').isDisabled(), true, '非法 DXF 确认按钮必须禁用');
    await dxfModal.getByRole('button', { name: '取消', exact: true }).click();

    return { circularBomCaptured: true, brokenDxfDisabled: true };
  });

  await runCheck('F13-T2-02', 'Tier 2', 'F13', async () => {
    const whToken = authEnabled ? roleCreds.WAREHOUSE.token : null;
    const inspToken = authEnabled ? roleCreds.INSPECTOR.token : null;
    const atomicRoll0 = `R-ATOMIC-0-${tag.toUpperCase()}`;
    const atomicRollBad = `R-ATOMIC-BAD-${tag.toUpperCase()}`;

    // 1) UI 预检母卷混合坏行
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, whToken, '#/inventory');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/inventory`, { waitUntil: 'networkidle' });
    }
    await mainPage.locator('[data-testid="inv-open-batch-import-btn"]').click();
    await mainPage.locator('[data-testid="inv-receive-tab-batch-rolls"]').click();

    const badRollsCsv = path.join(tmpWorkDir, `rolls-bad-${tag}.csv`);
    fs.writeFileSync(
      badRollsCsv,
      [
        '\ufeff母卷号,材料型号,有效幅宽(mm),整卷总长(mm),已用长度(mm),剩余长度(mm),报废长度(mm),质检状态',
        `${atomicRoll0},M4-BAD-${tag},2000,10000,0,10000,0,PASSED`,
        `${atomicRollBad},M4-BAD-${tag},2000,10000,1000,5000,0,PASSED`
      ].join('\r\n'),
      'utf8'
    );
    await mainPage.locator('[data-testid="inv-import-file-input"]').setInputFiles(badRollsCsv);
    await mainPage.locator('[data-testid="inv-import-preview-btn"]').click();
    await mainPage.locator('[data-testid="inv-import-errors-table"]').waitFor({ state: 'visible', timeout: 10000 });
    const rollErrTableText = await mainPage.locator('[data-testid="inv-import-errors-table"]').innerText();
    assert.ok(rollErrTableText.includes('ROLL_LENGTH_MISMATCH'), `UI 错表应含 ROLL_LENGTH_MISMATCH: ${rollErrTableText}`);
    await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();

    // 直接 POST 验证原子全回滚（第 0 行也不得入库）
    const atomicRollPost = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `ATOMIC-ROLL-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `ATOMIC-ROLL-${tag}`,
          rows: [
            { rollId: atomicRoll0, rollModel: `M4-BAD-${tag}`, width: 2000, totalLength: 10000, usedLength: 0, currentRemainingLength: 10000, scrappedLengthMm: 0, inspectionStatus: 'PASSED' },
            { rollId: atomicRollBad, rollModel: `M4-BAD-${tag}`, width: 2000, totalLength: 10000, usedLength: 1000, currentRemainingLength: 5000, scrappedLengthMm: 0, inspectionStatus: 'PASSED' }
          ]
        })
      },
      whToken
    );
    assert.equal(atomicRollPost.status, 400);
    assert.equal(atomicRollPost.data?.code, 'BATCH_IMPORT_VALIDATION_FAILED');
    const rollsAfter = await apiJsonOn(baseUrl, '/api/v2/rolls', {}, whToken);
    assert.equal((rollsAfter.data || []).some((r) => r.rollId === atomicRoll0), false, '第 0 行合法母卷必须已原子回滚');

    // 2) 瑕疵混合坏行（第 0 行合法，第 1 行 x=10.05 违反 0.1 mm + 越界）
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, inspToken, '#/inspection');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/inspection`, { waitUntil: 'networkidle' });
    }
    await mainPage.locator('[data-testid="insp-open-batch-defects-btn"]').click();
    const badDefCsv = path.join(tmpWorkDir, `defects-bad-${tag}.csv`);
    fs.writeFileSync(
      badDefCsv,
      [
        '\ufeff母卷号,captureId,x(mm),y(mm),宽度(mm),高度(mm),安全边距(mm)',
        `${batchRollIdOk},CAP-ATOMIC-0-${tag},50.0,50.0,10.0,10.0,20.0`,
        `${batchRollIdOk},CAP-ATOMIC-1-${tag},10.05,50.0,3000.0,10.0,20.0`
      ].join('\r\n'),
      'utf8'
    );
    await mainPage.locator('[data-testid="insp-import-file-input"]').setInputFiles(badDefCsv);
    await mainPage.locator('[data-testid="insp-import-preview-btn"]').click();
    await mainPage.locator('[data-testid="insp-import-errors-table"]').waitFor({ state: 'visible', timeout: 10000 });
    const defErrText = await mainPage.locator('[data-testid="insp-import-errors-table"]').innerText();
    assert.ok(defErrText.includes('PRECISION_VIOLATION') || defErrText.includes('OUT_OF_ROLL_BOUNDS'), `瑕疵错表应精准报错: ${defErrText}`);
    await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();

    const atomicDefPost = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/defects',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `ATOMIC-DEF-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `ATOMIC-DEF-${tag}`,
          rows: [
            { rollId: batchRollIdOk, captureId: `CAP-ATOMIC-0-${tag}`, x: 50.0, y: 50.0, w: 10.0, h: 10.0, margin: 20.0 },
            { rollId: batchRollIdOk, captureId: `CAP-ATOMIC-1-${tag}`, x: 10.05, y: 50.0, w: 3000.0, h: 10.0, margin: 20.0 }
          ]
        })
      },
      inspToken
    );
    assert.equal(atomicDefPost.status, 400);
    assert.equal(atomicDefPost.data?.code, 'BATCH_IMPORT_VALIDATION_FAILED');
    const rollNow = await apiJsonOn(baseUrl, `/api/v2/rolls/${encodeURIComponent(batchRollIdOk)}`, {}, inspToken);
    assert.equal(rollNow.data?.defects?.length, 3, '瑕疵第 0 行必须已原子回滚，数量仍为 3');

    return { rollRollbackVerified: true, defectRollbackVerified: true };
  });

  await runCheck('F13-T2-03', 'Tier 2', 'F13', async () => {
    const whToken = authEnabled ? roleCreds.WAREHOUSE.token : null;

    // 1) 缺幂等键 -> 400 INVALID_INPUT
    const missingKeyRes = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls',
      {
        method: 'POST',
        body: JSON.stringify({
          rows: [{ rollId: `R-NOKEY-${tag}`, rollModel: 'M1', width: 1500, totalLength: 10000 }]
        })
      },
      whToken
    );
    assert.equal(missingKeyRes.status, 400, `缺 Idempotency-Key 应返回 400: ${missingKeyRes.raw}`);

    // 2) 同 Key 异载荷 -> 409 INVENTORY_CONFLICT (且在 UI 验证 409 横幅)
    const conflictKey = `K-DUP-${tag}`;
    const okRowA = { rollId: `R-KDUP-A-${tag}`, rollModel: 'M1', width: 1500, totalLength: 10000, inspectionStatus: 'PASSED' };
    const firstCommit = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls',
      { method: 'POST', headers: { 'Idempotency-Key': conflictKey }, body: JSON.stringify({ idempotencyKey: conflictKey, rows: [okRowA] }) },
      whToken
    );
    assert.equal(firstCommit.status, 200);

    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, whToken, '#/inventory');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/inventory`, { waitUntil: 'networkidle' });
    }
    await mainPage.locator('[data-testid="inv-open-batch-import-btn"]').click();
    await mainPage.locator('[data-testid="inv-receive-tab-batch-rolls"]').click();
    const diffCsvPath = path.join(tmpWorkDir, `rolls-diff-${tag}.csv`);
    fs.writeFileSync(
      diffCsvPath,
      `\ufeff母卷号,材料型号,有效幅宽(mm),整卷总长(mm),质检状态\r\nR-KDUP-B-${tag},M1,1600,20000,PASSED\r\n`,
      'utf8'
    );
    await mainPage.locator('[data-testid="inv-import-file-input"]').setInputFiles(diffCsvPath);
    await mainPage.locator('[data-testid="inv-batch-preview-table"]').waitFor({ state: 'visible', timeout: 10000 });
    await mainPage.locator('[data-testid="inv-import-idempotency-key"]').fill(conflictKey);
    const [conflictResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().endsWith('/api/v2/inventory/import/rolls') && r.request().method() === 'POST'),
      mainPage.locator('[data-testid="inv-import-commit-btn"]').click()
    ]);
    assert.equal(conflictResp.status(), 409, '同 Key 异载荷应返回 409');
    await mainPage.locator('[data-testid="inv-batch-error-banner"]').waitFor({ state: 'visible', timeout: 10000 });
    const bannerText = await mainPage.locator('[data-testid="inv-batch-error-banner"]').innerText();
    assert.ok(bannerText.includes('409'), `UI 横幅应提示 409 冲突: ${bannerText}`);
    await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();

    // 3) 501 行上限拦截 -> 400 INVALID_INPUT
    const rows501 = Array.from({ length: 501 }, (_, idx) => ({
      rollId: `R-501-${tag}-${idx}`,
      rollModel: 'M1',
      width: 1500,
      totalLength: 10000
    }));
    const over500Res = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls/preview',
      { method: 'POST', body: JSON.stringify({ rows: rows501 }) },
      whToken
    );
    assert.equal(over500Res.status, 400, `501 行超限应返回 400: ${over500Res.raw}`);
    assert.equal(over500Res.data?.code, 'INVALID_INPUT');

    return { missingKeyStatus: 400, conflictStatus: 409, over500Status: 400 };
  });

  await runCheck('F13-T2-04', 'Tier 2', 'F13', async () => {
    const actorToken = authEnabled ? adminToken : null;

    // 先创建真实的 1D 与 2D 需求族，再确认含公式注入与控制符/代理对的方案
    const inj1DTask = await apiJsonOn(
      baseUrl,
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `=CMD|'/C calc'!A0`,
          materialModel: 'TC-INJ',
          dimension: 'SLITTING_1D',
          bedLengthMm: 1000,
          maxWidthMm: 1600,
          demands: [{ id: 1, name: '-2+3', width: 790, length: 1000, quantity: 2, allowRotation: false }]
        })
      },
      actorToken
    );
    assert.ok(inj1DTask.status === 200 || inj1DTask.status === 201, `创建防注入 1D 需求失败: ${inj1DTask.raw}`);

    const inj1DRes = await apiJsonOn(
      baseUrl,
      '/api/v2/schemes/confirm',
      {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: `INJ-1D-${tag}`,
          title: "+1+1",
          dimension: 'SLITTING_1D',
          scenarioId: 'MIN_CARS',
          strategyId: 'SLIT-INJ',
          strategyName: '防注入测试',
          taskId: inj1DTask.data.id,
          taskName: `=CMD|'/C calc'!A0`,
          materialMode: 'VIRTUAL_ROLL',
          materialModel: 'TC-INJ',
          widthMm: 1600,
          canvasLengthMm: 1000,
          occupiedLengthMm: 1000,
          utilizationPct: 90.0,
          pieceAreaM2: 1.44,
          demands: [{ id: 1, name: '-2+3', width: 790, length: 1000, quantity: 2, allowRotation: false }],
          slitting1D: {
            leftTrimMm: 10,
            rightTrimMm: 10,
            widthStepMm: 10,
            motherWidthMm: 1600,
            minWidthMm: 1580,
            maxWidthMm: 1600,
            fixedLengthMm: 1000,
            totalCars: 1,
            missingRolls: 0,
            overproducedRolls: 0,
            patterns: [
              {
                id: 'PAT-1',
                lengthMm: 1000,
                repetitions: 1,
                usedWidthMm: 1580,
                spareWidthMm: 20,
                stations: [{ widthMm: 790, countPerRepetition: 2 }],
                surfaceTreatment: '\u200B=1+1',
                allocations: [{ orderId: '=ORD-INJ', quantity: 2 }]
              }
            ],
            fulfillment: [{ orderId: '-2+3', name: '@SUM(A1:A2)', widthMm: 790, requested: 2, produced: 2, missing: 0, overproduced: 0 }]
          }
        })
      },
      actorToken
    );
    assert.equal(inj1DRes.status, 200, `创建防注入 1D 方案失败: ${inj1DRes.raw}`);
    schemeInjection1DId = inj1DRes.data?.scheme?.id || inj1DRes.data?.id;

    const inj2DTask = await apiJsonOn(
      baseUrl,
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: '控制符\u0000\u0007测试',
          materialModel: 'TC-INJ',
          dimension: 'RECT_2D',
          bedLengthMm: 1200,
          maxWidthMm: 1500,
          demands: [{ id: 1, name: 'ABCDEFGHIJKLMNOPQRSTU\uD840\uDC00VWXYZ', width: 600, length: 400, quantity: 1, allowRotation: false }]
        })
      },
      actorToken
    );
    assert.ok(inj2DTask.status === 200 || inj2DTask.status === 201, `创建防注入 2D 需求失败: ${inj2DTask.raw}`);

    const inj2DRes = await apiJsonOn(
      baseUrl,
      '/api/v2/schemes/confirm',
      {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: `INJ-2D-${tag}`,
          title: `=CMD|'/C calc'!A0`,
          dimension: 'RECT_2D',
          scenarioId: 'SHORTEN_KIT',
          strategyId: 'STR-INJ',
          strategyName: 'UnicodePDF测试',
          taskId: inj2DTask.data.id,
          taskName: '控制符\u0000\u0007测试',
          materialMode: 'VIRTUAL_ROLL',
          materialModel: 'TC-INJ',
          widthMm: 1500,
          canvasLengthMm: 1200,
          occupiedLengthMm: 600,
          utilizationPct: 80.0,
          pieceAreaM2: 0.48,
          demands: [{ id: 1, name: 'ABCDEFGHIJKLMNOPQRSTU\uD840\uDC00VWXYZ', width: 600, length: 400, quantity: 1, allowRotation: false }],
          layout2D: {
            placements: [{ id: 1, demandId: 1, name: 'ABCDEFGHIJKLMNOPQRSTU\uD840\uDC00VWXYZ', x: 0, y: 0, w: 600, l: 400, rotationDegrees: 0, rotated: false }],
            leftovers: [],
            cutSteps: []
          }
        })
      },
      actorToken
    );
    assert.equal(inj2DRes.status, 200, `创建防注入 2D 方案失败: ${inj2DRes.raw}`);
    schemeInjection2DId = inj2DRes.data?.scheme?.id || inj2DRes.data?.id;

    // 1) CSV 公式注入清洗 + PAT-1 零误伤
    const csvRes = await fetchBinaryOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(schemeInjection1DId)}/slitting?format=csv`, {}, actorToken);
    assert.equal(csvRes.status, 200);
    const csvText = csvRes.buf.toString('utf8');
    assert.ok(csvText.includes("'\u200B=1+1"), '零宽空格前导公式注入必须被前置单引号');
    assert.ok(csvText.includes("'=ORD-INJ:2"), '订单号 = 前缀必须被前置单引号');
    assert.ok(csvText.includes('"PAT-1"'), '正常带连字符 PAT-1 不应被误加单引号');

    // 2) 1D XLSX 公式注入清洗
    const slitXlsxRes = await fetchBinaryOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(schemeInjection1DId)}/slitting?format=xlsx`, {}, actorToken);
    assert.equal(slitXlsxRes.status, 200);
    const slitParsed = parseXlsxSheets(slitXlsxRes.buf);
    const s1Row1 = slitParsed.sheets['1D分切刀组配方'][1];
    const s2Row1 = slitParsed.sheets['订单履约汇总'][1];
    assert.equal(s1Row1[3], 'PAT-1', 'XLSX 中 PAT-1 不得被误加单引号');
    assert.ok(s1Row1[11].startsWith("'"), `1D XLSX 表面工艺公式应被前置单引号，实际: ${s1Row1[11]}`);
    assert.ok(s2Row1[0].startsWith("'-2+3") && s2Row1[1].startsWith("'@SUM"), `1D XLSX 订单与规格公式应被前置单引号: ${JSON.stringify(s2Row1)}`);

    // 3) 生产汇总 XLSX 公式注入清洗
    const sumXlsxRes = await fetchBinaryOn(
      baseUrl,
      `/api/v2/exports/production-summary?format=xlsx&taskId=${encodeURIComponent(inj2DTask.data.id)}`,
      {},
      actorToken
    );
    assert.equal(sumXlsxRes.status, 200);
    const sumParsed = parseXlsxSheets(sumXlsxRes.buf);
    const ledgerRow1 = sumParsed.sheets['2_方案台账'][1];
    assert.ok(ledgerRow1[1].startsWith("'=CMD"), `汇总台账标题公式注入应被前置单引号，实际: ${ledgerRow1[1]}`);

    // 4) ticket.pdf 控制字符与代理对保护
    const pdfRes = await fetchBinaryOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(schemeInjection2DId)}/ticket.pdf`, {}, actorToken);
    assert.equal(pdfRes.status, 200);
    const pdfParsed = parsePdfDocument(pdfRes.buf);
    assert.equal(pdfParsed.hexCodeUnits.includes('0000'), false, 'PDF 内容流不得包含 \\u0000');
    assert.equal(pdfParsed.hexCodeUnits.includes('0007'), false, 'PDF 内容流不得包含 \\u0007');
    assert.equal(pdfParsed.hexCodeUnits.includes('FFFD'), false, 'PDF 截断代理对不得产生 U+FFFD');
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(pdfParsed.decodedText), 'PDF 解码文本不得包含控制字符');

    return { csvSanitized: true, xlsxSanitized: true, pdfUnicodeSafe: true };
  });

  await runCheck('F13-T2-05', 'Tier 2', 'F13', async () => {
    const actorToken = authEnabled ? adminToken : null;

    const badOvercut = await apiJsonOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(scheme2DHoleId)}/cam?overcutMm=20.1`, {}, actorToken);
    assert.equal(badOvercut.status, 400);

    const badTool = await apiJsonOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(scheme2DHoleId)}/cam?cutTool=BAD`, {}, actorToken);
    assert.equal(badTool.status, 400);

    const mismatch1DToCam = await apiJsonOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(scheme1DId)}/cam`, {}, actorToken);
    assert.equal(mismatch1DToCam.status, 400);

    const mismatch2DToSlit = await apiJsonOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(scheme2DHoleId)}/slitting`, {}, actorToken);
    assert.equal(mismatch2DToSlit.status, 400);

    const notFoundCam = await apiJsonOn(baseUrl, '/api/v2/exports/schemes/NO-SUCH-SCHEME-404/cam', {}, actorToken);
    assert.equal(notFoundCam.status, 404);

    const notFoundPdf = await apiJsonOn(baseUrl, '/api/v2/exports/schemes/NO-SUCH-SCHEME-404/ticket.pdf', {}, actorToken);
    assert.equal(notFoundPdf.status, 404);

    const notFoundZip = await apiJsonOn(
      baseUrl,
      '/api/v2/exports/batch-zip',
      { method: 'POST', body: JSON.stringify({ schemeIds: [scheme2DHoleId, 'NO-SUCH-SCHEME-404'], formats: ['ticket_pdf'] }) },
      actorToken
    );
    assert.equal(notFoundZip.status, 404);

    const badDates = await apiJsonOn(baseUrl, '/api/v2/exports/production-summary?from=2026-11-28&to=2026-11-25', {}, actorToken);
    assert.equal(badDates.status, 400);

    const tooManyIds = Array.from({ length: 51 }, (_, idx) => `FAKE-${idx}`);
    const zip51 = await apiJsonOn(
      baseUrl,
      '/api/v2/exports/batch-zip',
      { method: 'POST', body: JSON.stringify({ schemeIds: tooManyIds, formats: ['ticket_pdf'] }) },
      actorToken
    );
    assert.equal(zip51.status, 400);

    const zipEmpty = await apiJsonOn(
      baseUrl,
      '/api/v2/exports/batch-zip',
      { method: 'POST', body: JSON.stringify({ schemeIds: [], formats: ['ticket_pdf'] }) },
      actorToken
    );
    assert.equal(zipEmpty.status, 400);

    return { allValidationErrorsCaptured: true };
  });

  await runCheck('F13-T2-06', 'Tier 2', 'F13', async () => {
    // 若主实例未开启 --auth，则临时起一个 --auth 实例完成 RBAC 与 Agent 测试
    let targetUrl = baseUrl;
    let tAdmin = adminToken;
    let tWh = roleCreds.WAREHOUSE?.token;
    let tOp = roleCreds.OPERATOR?.token;
    let tPl = roleCreds.PLANNER?.token;
    let tAgInv = restrictedAgentToken;
    let tAgNoInv = noInvAgentToken;
    let targetScheme2d = scheme2DHoleId;
    let auxPid = null;
    let auxDir = null;

    try {
      if (!authEnabled) {
        const freePort = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, 18391, mainPort]));
        auxDir = fs.mkdtempSync(path.join(os.tmpdir(), `cutdemo-f13-auth-${tag}-`));
        const started = await startIsolatedJava({
          jarPath,
          port: freePort,
          statePath: path.join(auxDir, 'cutdemo-state.json'),
          logFile: path.join(auxDir, 'auth.log'),
          authEnabled: true
        });
        auxPid = started.pid;
        auxChildPids.push(auxPid);
        targetUrl = started.baseUrl;
        tAdmin = (await loginAs(targetUrl, authAdminUser, authAdminPass)).token;
        const auxTask = await apiJsonOn(
          targetUrl,
          '/api/v2/demand-pool',
          {
            method: 'POST',
            body: JSON.stringify({
              name: '权限任务',
              materialModel: 'TC-01',
              dimension: 'RECT_2D',
              bedLengthMm: 1200,
              maxWidthMm: 1500,
              demands: [{ id: 1, name: 'P1', width: 500, length: 500, quantity: 1, allowRotation: false }]
            })
          },
          tAdmin
        );
        const seedScheme = await apiJsonOn(
          targetUrl,
          '/api/v2/schemes/confirm',
          {
            method: 'POST',
            body: JSON.stringify({
              idempotencyKey: `AUX-2D-${tag}`,
              title: 'AUX权限测试方案',
              dimension: 'RECT_2D',
              scenarioId: 'SHORTEN_KIT',
              strategyId: 'S1',
              strategyName: '标准',
              taskId: auxTask.data.id,
              taskName: '权限任务',
              materialMode: 'VIRTUAL_ROLL',
              materialModel: 'TC-01',
              widthMm: 1500,
              canvasLengthMm: 1200,
              occupiedLengthMm: 500,
              utilizationPct: 70,
              pieceAreaM2: 0.5,
              demands: [{ id: 1, name: 'P1', width: 500, length: 500, quantity: 1, allowRotation: false }],
              layout2D: { placements: [{ id: 1, demandId: 1, name: 'P1', x: 0, y: 0, w: 500, l: 500, rotationDegrees: 0, rotated: false }], leftovers: [], cutSteps: [] }
            })
          },
          tAdmin
        );
        targetScheme2d = seedScheme.data?.scheme?.id || seedScheme.data?.id;

        for (const r of ['WAREHOUSE', 'OPERATOR', 'PLANNER']) {
          const uname = `${r.toLowerCase()}_aux_${tag}`;
          const upass = 'AuxPass!2026';
          await apiJsonOn(targetUrl, '/api/v2/users', { method: 'POST', body: JSON.stringify({ username: uname, displayName: r, role: r, password: upass }) }, tAdmin);
          const tk = (await loginAs(targetUrl, uname, upass)).token;
          if (r === 'WAREHOUSE') tWh = tk;
          if (r === 'OPERATOR') tOp = tk;
          if (r === 'PLANNER') tPl = tk;
        }
        tAgInv = (await apiJsonOn(targetUrl, '/api/v2/agents', { method: 'POST', body: JSON.stringify({ name: 'AuxInvAgent', scopes: ['DEMAND_READ', 'INVENTORY_READ', 'PLAN_COMPUTE', 'DRAFT_WRITE'], expiresInDays: 7 }) }, tAdmin)).data.token;
        tAgNoInv = (await apiJsonOn(targetUrl, '/api/v2/agents', { method: 'POST', body: JSON.stringify({ name: 'AuxNoInvAgent', scopes: ['DEMAND_READ'], expiresInDays: 7 }) }, tAdmin)).data.token;
      }

      // 1) 未登录 401
      const noAuthExport = await apiJsonOn(targetUrl, `/api/v2/exports/schemes/${encodeURIComponent(targetScheme2d)}/cam`);
      assert.equal(noAuthExport.status, 401);
      const noAuthImport = await apiJsonOn(targetUrl, '/api/v2/inventory/import/rolls/preview', { method: 'POST', body: JSON.stringify({ rows: [] }) });
      assert.equal(noAuthImport.status, 401);

      // 2) OPERATOR / PLANNER 调 rolls/remnants/defects 均 403；WAREHOUSE 调 defects 403
      for (const tk of [tOp, tPl]) {
        assert.equal((await apiJsonOn(targetUrl, '/api/v2/inventory/import/rolls/preview', { method: 'POST', body: JSON.stringify({ rows: [{ rollId: 'X', rollModel: 'M', width: 1000, totalLength: 5000 }] }) }, tk)).status, 403);
        assert.equal((await apiJsonOn(targetUrl, '/api/v2/inventory/import/defects/preview', { method: 'POST', body: JSON.stringify({ rows: [{ rollId: 'X', x: 0, y: 0, w: 10, h: 10 }] }) }, tk)).status, 403);
      }
      assert.equal((await apiJsonOn(targetUrl, '/api/v2/inventory/import/defects/preview', { method: 'POST', body: JSON.stringify({ rows: [{ rollId: 'X', x: 0, y: 0, w: 10, h: 10 }] }) }, tWh)).status, 403);

      // 3) 仅 DEMAND_READ Agent 调导出 -> 403
      assert.equal((await apiJsonOn(targetUrl, `/api/v2/exports/schemes/${encodeURIComponent(targetScheme2d)}/cam`, {}, tAgNoInv)).status, 403);

      // 4) 含 INVENTORY_READ Agent 调 /cam -> 200，但调 /batch-zip 与 /inventory/import/* -> 403
      assert.equal((await apiJsonOn(targetUrl, `/api/v2/exports/schemes/${encodeURIComponent(targetScheme2d)}/cam`, {}, tAgInv)).status, 200);
      assert.equal((await apiJsonOn(targetUrl, '/api/v2/exports/batch-zip', { method: 'POST', body: JSON.stringify({ schemeIds: [targetScheme2d], formats: ['ticket_pdf'] }) }, tAgInv)).status, 403);
      assert.equal((await apiJsonOn(targetUrl, '/api/v2/inventory/import/rolls/preview', { method: 'POST', body: JSON.stringify({ rows: [{ rollId: 'X', rollModel: 'M', width: 1000, totalLength: 5000 }] }) }, tAgInv)).status, 403);

      // 5) UI 登录 OPERATOR 核实库存与瑕疵弹窗权限告警及禁用按钮；注入 Agent Token 核实 batch-zip 弹窗告警
      await setTokenAndGoto(mainPage, targetUrl, tOp, '#/inventory');
      await mainPage.locator('[data-testid="inv-open-batch-import-btn"]').click();
      await mainPage.locator('[data-testid="inv-receive-tab-batch-rolls"]').click();
      await mainPage.locator('[data-testid="inv-import-permission-alert"]').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await mainPage.locator('[data-testid="inv-import-commit-btn"]').isDisabled(), true);
      await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();

      await setTokenAndGoto(mainPage, targetUrl, tOp, '#/inspection');
      await mainPage.locator('[data-testid="insp-open-batch-defects-btn"]').click();
      await mainPage.locator('[data-testid="insp-import-permission-alert"]').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await mainPage.locator('[data-testid="insp-import-commit-btn"]').isDisabled(), true);
      await mainPage.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click();

      await setTokenAndGoto(mainPage, targetUrl, tAgInv, '#/results');
      await mainPage.locator(`[data-testid="res-scheme-checkbox-${targetScheme2d}"]`).check();
      const batchZipBtn = mainPage.locator('[data-testid="res-open-batch-zip-modal-btn"]');
      await batchZipBtn.waitFor({ state: 'visible', timeout: 10000 });
      await batchZipBtn.click();
      await mainPage.locator('[data-testid="res-batch-zip-permission-alert"]').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await mainPage.locator('[data-testid="res-batch-zip-submit-btn"]').isDisabled(), true);
      await mainPage.locator('[data-testid="res-batch-zip-modal"]').getByRole('button', { name: '取消', exact: true }).click();

      // 6) 审计表记录 ACCESS_DENIED
      const auditDenied = await apiJsonOn(targetUrl, '/api/v2/audit-logs?action=ACCESS_DENIED&limit=20', {}, tAdmin);
      assert.equal(auditDenied.status, 200);
      assert.ok((auditDenied.data?.items || []).some((it) => it.outcome === 'DENIED' || it.httpStatus === 403), '应落库 403 ACCESS_DENIED 审计');
    } finally {
      if (auxPid) await stopIsolatedJava(auxPid);
      if (auxDir && fs.existsSync(auxDir)) fs.rmSync(auxDir, { recursive: true, force: true });
    }

    // 切回 admin token 供后续检查
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, adminToken, '#/results');
    }
    return { rbacAndAgentFirewallVerified: true };
  });

  await runCheck('F13-T2-07', 'Tier 2', 'F13', async () => {
    const inspToken = authEnabled ? roleCreds.INSPECTOR.token : null;
    const whToken = authEnabled ? roleCreds.WAREHOUSE.token : null;

    // 1) 向 SCRAPPED 母卷导入瑕疵 -> ROLL_SCRAPPED
    const scrapDefRes = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/defects',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `DEF-SCR-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `DEF-SCR-${tag}`,
          rows: [{ rollId: batchRollIdScrap, x: 100.0, y: 100.0, w: 20.0, h: 20.0, margin: 20.0 }]
        })
      },
      inspToken
    );
    assert.equal(scrapDefRes.status, 400);
    assert.equal(scrapDefRes.data?.code, 'BATCH_IMPORT_VALIDATION_FAILED');
    assert.equal(scrapDefRes.data?.errors?.[0]?.code, 'ROLL_SCRAPPED');

    // 2) 向已锁入活跃方案的 reservedRollId 导入瑕疵 -> ROLL_RESERVED
    const resvDefRes = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/defects',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `DEF-RESV-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `DEF-RESV-${tag}`,
          rows: [{ rollId: reservedRollId, x: 100.0, y: 100.0, w: 20.0, h: 20.0, margin: 20.0 }]
        })
      },
      inspToken
    );
    assert.equal(resvDefRes.status, 400);
    assert.equal(resvDefRes.data?.errors?.[0]?.code, 'ROLL_RESERVED');

    // 3) 超过 2MB JSON 导入请求体 -> 413 PAYLOAD_TOO_LARGE
    const hugeDesc = 'X'.repeat(2_200_000);
    const hugeBody = JSON.stringify({
      rows: [{ rollId: `R-HUGE-${tag}`, rollModel: 'M1', width: 1500, totalLength: 10000, supplier: hugeDesc }]
    });
    const over2MbRes = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls/preview',
      { method: 'POST', body: hugeBody },
      whToken
    );
    assert.equal(over2MbRes.status, 413, `超 2MB 载荷应返回 413，实际 ${over2MbRes.status}: ${over2MbRes.raw}`);
    assert.equal(over2MbRes.data?.code, 'PAYLOAD_TOO_LARGE');

    return { rollScrappedBlocked: true, rollReservedBlocked: true, over2MbStatus: 413 };
  });

  // ==================== F14 正向 5 项 ====================

  await runCheck('T1-F14-01', 'Tier 1', 'F14', async () => {
    // 1) --base 连接当前主隔离实例运行 v2-gate
    const baseArgs = [
      BENCH_GATE_CLI,
      '--base',
      baseUrl,
      '--set',
      'v2-gate',
      ...(authEnabled ? ['--auth', '--username', authAdminUser, '--password', authAdminPass] : [])
    ];
    const baseOutJson = path.join(tmpWorkDir, `gate-base-${tag}.json`);
    baseArgs.push('--out', baseOutJson);
    const resBase = spawnSync(process.execPath, baseArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
    assert.equal(resBase.status, 0, `benchmark/gate.mjs --base 应返回 0，实际 ${resBase.status}:\n${resBase.stderr}\n${resBase.stdout}`);
    const baseRecord = JSON.parse(fs.readFileSync(baseOutJson, 'utf8'));
    assert.equal(baseRecord.thresholdEvaluation?.passed, true, 'v2-gate 全部质量红线必须通过');
    assert.equal(baseRecord.rows?.length, 8, `v2-gate 应运行 8 题，实际 ${baseRecord.rows?.length}`);
    assert.ok(baseRecord.rows.every((r) => r.ok), 'v2-gate 8 题全部运行有效');

    // 2) 在动态空闲隔离端口自启 --auth 运行 v2-gate
    const freeBenchPort = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, 18391, mainPort]));
    const selfOutJson = path.join(tmpWorkDir, `gate-self-${tag}.json`);
    const resSelf = spawnSync(
      process.execPath,
      [
        BENCH_GATE_CLI,
        '--set',
        'v2-gate',
        '--auth',
        '--port',
        String(freeBenchPort),
        '--jar',
        jarPath,
        '--out',
        selfOutJson
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
      }
    );
    assert.equal(resSelf.status, 0, `benchmark/gate.mjs 自启 --auth 应返回 0，实际 ${resSelf.status}:\n${resSelf.stderr}\n${resSelf.stdout}`);
    const selfRecord = JSON.parse(fs.readFileSync(selfOutJson, 'utf8'));
    assert.equal(selfRecord.thresholdEvaluation?.passed, true);
    assert.equal(selfRecord.rows?.length, 8);

    return { baseProblemsPassed: 8, selfAuthPort: freeBenchPort, selfProblemsPassed: 8 };
  });

  await runCheck('T1-F14-02', 'Tier 1', 'F14', async () => {
    const benchTests = fs
      .readdirSync(path.join(REPO_ROOT, 'benchmark'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => path.join('benchmark', f));
    const resBenchTest = spawnSync(process.execPath, ['--test', ...benchTests], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    assert.equal(resBenchTest.status, 0, `benchmark 单测失败:\n${resBenchTest.stdout}\n${resBenchTest.stderr}`);
    const tap = parseTapOutput(resBenchTest.stdout);
    assert.equal(tap.tests, 27, `benchmark 单测总数应为 27，实际 ${tap.tests}`);
    assert.equal(tap.pass, 27);
    assert.equal(tap.fail, 0);
    assert.equal(tap.skipped, 0);

    const resClosure = spawnSync(process.execPath, [AUDIT_CLI, '--fail', '--format', 'json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    assert.equal(resClosure.status, 0, `workflow-closure-audit 应通过，实际 ${resClosure.status}:\n${resClosure.stdout}`);
    const closureJson = JSON.parse(resClosure.stdout);
    assert.equal(closureJson.summary.violationCount, 0);
    assert.equal(closureJson.dimensions.apiContract.legacyEndpointCount, 0);
    assert.equal(closureJson.dimensions.archAndLargeFiles.currentLargeFileCount, 0);

    const resArch = spawnSync(process.execPath, [ARCH_CLI, '--fail-on-cycle', '--format', 'json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    assert.equal(resArch.status, 0, `arch-coupling-audit 应通过，实际 ${resArch.status}:\n${resArch.stdout}`);
    const archJson = JSON.parse(resArch.stdout);
    assert.equal(archJson.summary.totalCycles, 0);

    return {
      benchmarkTests: tap,
      closureViolations: closureJson.summary.violationCount,
      archCycles: archJson.summary.totalCycles
    };
  });

  await runCheck('T1-F14-03', 'Tier 1', 'F14', async () => {
    const onlineRes = await apiJsonOn(baseUrl, '/api-v2/openapi.json', {}, authEnabled ? adminToken : null);
    assert.equal(onlineRes.status, 200, `在线 openapi.json 应返回 200，实际 ${onlineRes.status}`);
    const onlineSpec = onlineRes.data;
    const diskSpec = JSON.parse(fs.readFileSync(STATIC_OPENAPI_FILE, 'utf8'));

    assert.equal(onlineSpec.openapi, '3.1.0');
    assert.deepEqual(Object.keys(onlineSpec.paths || {}).sort(), Object.keys(diskSpec.paths || {}).sort(), '在线与磁盘 OpenAPI 路径必须 100% 一致');

    const paths = Object.keys(onlineSpec.paths || {});
    assert.equal(paths.length, 104, `OpenAPI 路径数应为 104，实际 ${paths.length}`);
    let opCount = 0;
    for (const p of paths) {
      assert.ok(p === '/api/health' || p.startsWith('/api/v2/'), `发现未收敛非 v2 路径: ${p}`);
      for (const method of Object.keys(onlineSpec.paths[p])) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) opCount += 1;
      }
    }
    assert.equal(opCount, 116, `OpenAPI 操作数应为 116，实际 ${opCount}`);

    return { openapi: onlineSpec.openapi, pathCount: paths.length, operationCount: opCount };
  });

  await runCheck('T1-F14-04', 'Tier 1', 'F14', async () => {
    const actorToken = authEnabled ? adminToken : null;
    for (const ep of [
      '/api/v2/health',
      '/api/v2/capabilities',
      '/api/v2/nesting/engines',
      '/api/v2/rolls',
      '/api/v2/remnants',
      `/api/v2/rolls/${encodeURIComponent(batchRollIdOk)}/spatial-map`
    ]) {
      const r = await apiJsonOn(baseUrl, ep, {}, actorToken);
      assert.equal(r.status, 200, `${ep} 应返回 200，实际 ${r.status}: ${r.raw}`);
    }

    // 浏览核心业务页监听 API 响应无 404/410 死链
    const deadLinks = [];
    const onResp = (resp) => {
      const url = resp.url();
      if (url.includes('/api/') && (resp.status() === 404 || resp.status() === 410)) {
        deadLinks.push(`${resp.status()} ${url}`);
      }
    };
    mainPage.on('response', onResp);
    try {
      for (const route of ['#/demands', '#/demand-library', '#/clusters', '#/workbench', '#/slitting', '#/results', '#/reconciliation', '#/cost-analytics', '#/inventory', '#/inspection', '#/documents']) {
        await mainPage.goto(`${baseUrl}/app/${route}`, { waitUntil: 'networkidle' });
      }
    } finally {
      mainPage.off('response', onResp);
    }
    assert.equal(deadLinks.length, 0, `页面浏览中出现 API 404/410 死链: ${deadLinks.join(' | ')}`);

    return { endpointsChecked: 6, routesNavigated: 11, deadLinksCount: 0 };
  });

  await runCheck('T1-F14-05', 'Tier 1', 'F14', async () => {
    const mcpTests = fs
      .readdirSync(path.join(REPO_ROOT, 'integrations', 'mcp', 'test'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => path.join('integrations', 'mcp', 'test', f));
    const resMcp = spawnSync(process.execPath, ['--test', ...mcpTests], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    assert.equal(resMcp.status, 0, `MCP 单测失败:\n${resMcp.stdout}\n${resMcp.stderr}`);
    const tap = parseTapOutput(resMcp.stdout);
    assert.equal(tap.tests, 25, `MCP 测试总数应为 25，实际 ${tap.tests}`);
    assert.equal(tap.pass, 25);
    assert.equal(tap.fail, 0);
    assert.equal(tap.skipped, 0);
    return tap;
  });

  // ==================== F14 负向 5 项 ====================

  await runCheck('T2-F14-01', 'Tier 2', 'F14', async () => {
    const badThresholds = path.join(tmpWorkDir, `bad-thresholds-${tag}.json`);
    fs.writeFileSync(
      badThresholds,
      JSON.stringify({
        schemaVersion: 1,
        problems: {
          'guillotine-java': { minUtilization: 99.9, maxElapsedMs: 1, minPlacedRatio: 1.0 }
        }
      })
    );
    const res = spawnSync(
      process.execPath,
      [
        BENCH_GATE_CLI,
        '--base',
        baseUrl,
        '--problems',
        'guillotine-java',
        '--thresholds',
        badThresholds,
        ...(authEnabled ? ['--auth', '--username', authAdminUser, '--password', authAdminPass] : [])
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    assert.equal(res.status, 1, `超标红线应返回退出码 1，实际 ${res.status}:\n${res.stdout}\n${res.stderr}`);
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.ok(combined.includes('质量红线：未通过'), `输出应包含质量红线未通过提示:\n${combined}`);
    return { exitCode: res.status };
  });

  await runCheck('T2-F14-02', 'Tier 2', 'F14', async () => {
    const unusedPort = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, 18391, mainPort]));
    const resUnreach = spawnSync(
      process.execPath,
      [BENCH_GATE_CLI, '--base', `http://127.0.0.1:${unusedPort}`, '--problems', 'guillotine-java'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    assert.equal(resUnreach.status, 2, `服务不可达应返回退出码 2，实际 ${resUnreach.status}`);

    const res8080 = spawnSync(process.execPath, [BENCH_GATE_CLI, '--port', '8080'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    assert.equal(res8080.status, 2, `指定 8080 端口应返回退出码 2，实际 ${res8080.status}`);
    assert.ok(res8080.stderr.includes('严禁使用 8080 端口'), `stderr 应含 8080 护栏提示: ${res8080.stderr}`);

    return { unreachableExit: resUnreach.status, port8080Exit: res8080.status };
  });

  await runCheck('T2-F14-03', 'Tier 2', 'F14', async () => {
    let authTarget = baseUrl;
    let auxPid = null;
    let auxDir = null;
    try {
      if (!authEnabled) {
        const freePort = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, 18391, mainPort]));
        auxDir = fs.mkdtempSync(path.join(os.tmpdir(), `cutdemo-f14-auth-${tag}-`));
        const started = await startIsolatedJava({
          jarPath,
          port: freePort,
          statePath: path.join(auxDir, 'cutdemo-state.json'),
          logFile: path.join(auxDir, 'auth.log'),
          authEnabled: true
        });
        auxPid = started.pid;
        auxChildPids.push(auxPid);
        authTarget = started.baseUrl;
      }

      const outRun = path.join(tmpWorkDir, `unauth-run-${tag}.json`);
      const resRun = spawnSync(
        process.execPath,
        [BENCH_RUN_CLI, '--problems', 'guillotine-java', '--rounds', '1', '--warmup', '0', '--out', outRun, authTarget],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
      assert.equal(resRun.status, 2, `--auth 无令牌运行 benchmark/run.mjs 应返回退出码 2，实际 ${resRun.status}`);
      assert.ok(`${resRun.stdout}\n${resRun.stderr}`.includes('已开启企业认证'), '应提示已开启企业认证');

      const unauthRolls = await apiJsonOn(authTarget, '/api/v2/rolls');
      assert.equal(unauthRolls.status, 401);
      const unauthExport = await apiJsonOn(authTarget, '/api/v2/exports/production-summary?format=xlsx');
      assert.equal(unauthExport.status, 401);
    } finally {
      if (auxPid) await stopIsolatedJava(auxPid);
      if (auxDir && fs.existsSync(auxDir)) fs.rmSync(auxDir, { recursive: true, force: true });
    }
    return { benchExitCode: 2, apiRollsStatus: 401, apiExportStatus: 401 };
  });

  await runCheck('T2-F14-04', 'Tier 2', 'F14', async () => {
    const actorToken = authEnabled ? adminToken : null;
    const legacyEndpoints = [
      { method: 'GET', path: '/api/rolls' },
      { method: 'GET', path: '/api/cutting/tasks' },
      { method: 'POST', path: '/api/v1/nesting/solve', body: '{}' },
      { method: 'POST', path: '/api/remnants/scan', body: '{}' }
    ];
    for (const ep of legacyEndpoints) {
      const r = await apiJsonOn(baseUrl, ep.path, { method: ep.method, ...(ep.body ? { body: ep.body } : {}) }, actorToken);
      assert.equal(r.status, 404, `已下线旧接口 ${ep.method} ${ep.path} 必须返回 404，实际 ${r.status}`);
    }
    return { legacy404Verified: legacyEndpoints.map((e) => `${e.method} ${e.path}`) };
  });

  await runCheck('T2-F14-05', 'Tier 2', 'F14', async () => {
    const bigLines = Array.from({ length: 1005 }, (_, i) => `export const big${i} = ${i};`).join('\n');
    const sandboxFiles = createSandboxBaselineFiles({
      'src/main/java/com/example/cutdemotwo/controller/SampleV2Controller.java': [
        'package com.example.cutdemotwo.controller;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        '@RequestMapping("/api/v2")',
        'class SampleV2Controller {',
        '  @GetMapping("/capabilities") public Object caps() { return null; }',
        '  @GetMapping("/unregistered-probe") public Object probe() { return null; }',
        '}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/controller/LegacyProbeController.java': [
        'package com.example.cutdemotwo.controller;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        '@RequestMapping("/api")',
        'class LegacyProbeController {',
        '  @GetMapping("/legacy-probe") public Object legacy() { return null; }',
        '}'
      ].join('\n'),
      'frontend/src/pages/HugeProbePage.tsx': bigLines
    });

    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `cutdemo-m4-sandbox-${tag}-`));
    try {
      for (const [rel, content] of Object.entries(sandboxFiles)) {
        const abs = path.join(sandboxDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }
      const res = spawnSync(
        process.execPath,
        [AUDIT_CLI, '--root', sandboxDir, '--format', 'json', '--fail'],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      assert.equal(res.status, 1, `沙盒闭环审计应拦截违规并返回 1，实际 ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set((report.violations || []).map((v) => v.rule));
      for (const expectedRule of ['v2-missing-in-openapi', 'unregistered-legacy-endpoint', 'new-large-source-file']) {
        assert.ok(rules.has(expectedRule), `缺少预期沙盒规则 ${expectedRule}，实际: ${[...rules].join(', ')}`);
      }
      return { capturedRules: ['v2-missing-in-openapi', 'unregistered-legacy-endpoint', 'new-large-source-file'] };
    } finally {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  // ==================== Tier 3 跨特性成对组合 3 组 ====================

  await runCheck('T3-F13×F14-01', 'Tier3', 'F13×F14', async () => {
    const actorToken = authEnabled ? adminToken : null;
    const t3RollId = `R-T3-F1314-${tag.toUpperCase()}`;

    // 1) 批量导入隔离母卷
    const rollImp = await apiJsonOn(
      baseUrl,
      '/api/v2/inventory/import/rolls',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `T3-ROLL-${tag}` },
        body: JSON.stringify({
          idempotencyKey: `T3-ROLL-${tag}`,
          rows: [{ rollId: t3RollId, rollModel: 'M4-T3', width: 2000, totalLength: 50000, usedLength: 0, currentRemainingLength: 50000, scrappedLengthMm: 0, inspectionStatus: 'PASSED' }]
        })
      },
      actorToken
    );
    assert.equal(rollImp.status, 200);

    // 2) 多格式 DXF 导出 (已在 F13-T1-05 验证 5 种 CAM + PDF + XLSX + ZIP)，此处对绑定方案调生产级导出与 benchmark 联合校验
    const camNc = await fetchBinaryOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(scheme2DHoleId)}/cam?format=nc`, {}, actorToken);
    assert.equal(camNc.status, 200);
    assert.ok(camNc.buf.toString('utf8').includes('M30'));

    const outT3 = path.join(tmpWorkDir, `gate-t3-${tag}.json`);
    const gateRes = spawnSync(
      process.execPath,
      [
        BENCH_GATE_CLI,
        '--base',
        baseUrl,
        '--problems',
        'guillotine-java,contour-holes-16',
        '--out',
        outT3,
        ...(authEnabled ? ['--auth', '--username', authAdminUser, '--password', authAdminPass] : [])
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    assert.equal(gateRes.status, 0, `T3 benchmark 联动门禁失败:\n${gateRes.stderr}`);

    const recon = await apiJsonOn(baseUrl, '/api/v2/inventory-ledger/reconciliation', {}, actorToken);
    assert.equal(recon.data?.status, 'BALANCED');
    assert.equal(sha256File(PROD_STATE_FILE), prodStateBefore);

    return { importedRoll: t3RollId, gateExit: 0, ledgerStatus: recon.data?.status };
  });

  await runCheck('T3-F07×F13-01', 'Tier3', 'F07×F13', async () => {
    const actorToken = authEnabled ? adminToken : null;
    if (authEnabled) {
      await setTokenAndGoto(mainPage, baseUrl, adminToken, '#/demands');
    } else {
      await mainPage.goto(`${baseUrl}/app/#/demands`, { waitUntil: 'networkidle' });
    }

    // 1) 通过需求向导导入 1D 订单表格（1100mm x 8 卷 -> 4*1100=4400mm 精确匹配默认 4600-100-100=4400mm 2 车满刀）
    const csv1dPath = path.join(tmpWorkDir, `order-1d-${tag}.csv`);
    fs.writeFileSync(
      csv1dPath,
      `\ufeff材料型号,产品类型,宽度(mm),长度(mm),数量,表面处理\r\nM4-1D-T3-${tag},1D,1100,1000,8,阳极氧化\r\n`,
      'utf8'
    );

    await mainPage.locator('[data-testid="demand-import-wizard-btn"]').click();
    const modal = mainPage.locator('[data-testid="demand-import-modal"]');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    await modal.locator('[data-testid="demand-import-file-input"]').setInputFiles(csv1dPath);
    await modal.locator('[data-testid="demand-import-confirm-btn"]').click();
    await modal.waitFor({ state: 'hidden', timeout: 10000 });

    const [saveResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/demand-pool') && r.request().method() === 'POST'),
      mainPage.getByRole('button', { name: '保存并去搭切排程 →', exact: true }).click()
    ]);
    assert.ok(saveResp.status() === 200 || saveResp.status() === 201);
    const saved1DTask = await saveResp.json();
    assert.equal(saved1DTask.dimension, 'SLITTING_1D');

    // 2) 进入 #/workbench (1D 模式) 求解并选定方案，再调服务端导出分切 CSV/XLSX 与汇总 PDF
    await mainPage.waitForFunction(() => location.hash.includes('#/workbench'), null, { timeout: 10000 });
    await mainPage.locator('.studio-right-foot button.studio-solve-btn').click();
    const fastCard = mainPage.locator('.slit-scheme-card', { hasText: '快捷解' });
    await mainPage.waitForFunction(
      () => {
        const cards = Array.from(document.querySelectorAll('.slit-scheme-card'));
        const fast = cards.find((c) => c.textContent?.includes('快捷解'));
        return Boolean(fast && !fast.classList.contains('is-running') && fast.textContent?.includes('车'));
      },
      null,
      { timeout: 25000 }
    );
    await fastCard.click();

    const [cfmResp] = await Promise.all([
      mainPage.waitForResponse((r) => r.url().includes('/api/v2/schemes/confirm') && r.request().method() === 'POST'),
      mainPage.locator('.value-actions button.value-primary-cta').click()
    ]);
    const cfmText = await cfmResp.text();
    assert.equal(cfmResp.status(), 200, `1D 方案确认失败 (${cfmResp.status()}): ${cfmText}`);
    const cfmData = JSON.parse(cfmText);
    const t3SlitSchemeId = cfmData?.scheme?.id || cfmData?.id;

    const slitCsv = await fetchBinaryOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(t3SlitSchemeId)}/slitting?format=csv`, {}, actorToken);
    assert.equal(slitCsv.status, 200);
    assert.deepEqual([...slitCsv.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const slitXlsx = await fetchBinaryOn(baseUrl, `/api/v2/exports/schemes/${encodeURIComponent(t3SlitSchemeId)}/slitting?format=xlsx`, {}, actorToken);
    assert.equal(slitXlsx.status, 200);
    const parsedXlsx = parseXlsxSheets(slitXlsx.buf);
    assert.equal(parsedXlsx.sheetNames.length, 2);

    const sumPdf = await fetchBinaryOn(baseUrl, `/api/v2/exports/production-summary?format=pdf&taskId=${encodeURIComponent(saved1DTask.id)}`, {}, actorToken);
    assert.equal(sumPdf.status, 200);
    const parsedPdf = parsePdfDocument(sumPdf.buf);
    assert.ok(parsedPdf.decodedText.includes(t3SlitSchemeId));

    return { saved1DTaskId: saved1DTask.id, t3SlitSchemeId };
  });

  await runCheck('T3-F14×F11-01', 'Tier3', 'F14×F11', async () => {
    let targetUrl = baseUrl;
    let tAdmin = adminToken;
    let tAgent = restrictedAgentToken;
    let tSchemeId = scheme2DHoleId;
    let auxPid = null;
    let auxDir = null;

    try {
      if (!authEnabled) {
        const freePort = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, 18391, mainPort]));
        auxDir = fs.mkdtempSync(path.join(os.tmpdir(), `cutdemo-t3-auth-${tag}-`));
        const started = await startIsolatedJava({
          jarPath,
          port: freePort,
          statePath: path.join(auxDir, 'cutdemo-state.json'),
          logFile: path.join(auxDir, 'auth.log'),
          authEnabled: true
        });
        auxPid = started.pid;
        auxChildPids.push(auxPid);
        targetUrl = started.baseUrl;
        tAdmin = (await loginAs(targetUrl, authAdminUser, authAdminPass)).token;
        const auxT3Task = await apiJsonOn(
          targetUrl,
          '/api/v2/demand-pool',
          {
            method: 'POST',
            body: JSON.stringify({
              name: 'T3任务',
              materialModel: 'TC-01',
              dimension: 'RECT_2D',
              bedLengthMm: 1200,
              maxWidthMm: 1500,
              demands: [{ id: 1, name: 'P1', width: 500, length: 500, quantity: 1, allowRotation: false }]
            })
          },
          tAdmin
        );
        const cfm = await apiJsonOn(
          targetUrl,
          '/api/v2/schemes/confirm',
          {
            method: 'POST',
            body: JSON.stringify({
              idempotencyKey: `T3-AUX-${tag}`,
              title: 'T3辅助方案',
              dimension: 'RECT_2D',
              scenarioId: 'SHORTEN_KIT',
              strategyId: 'S1',
              strategyName: '标准',
              taskId: auxT3Task.data.id,
              taskName: 'T3任务',
              materialMode: 'VIRTUAL_ROLL',
              materialModel: 'TC-01',
              widthMm: 1500,
              canvasLengthMm: 1200,
              occupiedLengthMm: 500,
              utilizationPct: 70,
              pieceAreaM2: 0.5,
              demands: [{ id: 1, name: 'P1', width: 500, length: 500, quantity: 1, allowRotation: false }],
              layout2D: { placements: [{ id: 1, demandId: 1, name: 'P1', x: 0, y: 0, w: 500, l: 500, rotationDegrees: 0, rotated: false }], leftovers: [], cutSteps: [] }
            })
          },
          tAdmin
        );
        tSchemeId = cfm.data?.scheme?.id || cfm.data?.id;
        tAgent = (
          await apiJsonOn(
            targetUrl,
            '/api/v2/agents',
            { method: 'POST', body: JSON.stringify({ name: `T3Agent_${tag}`, scopes: ['DEMAND_READ', 'INVENTORY_READ', 'PLAN_COMPUTE', 'DRAFT_WRITE'], expiresInDays: 7 }) },
            tAdmin
          )
        ).data.token;
      }

      const zipDenied = await apiJsonOn(
        targetUrl,
        '/api/v2/exports/batch-zip',
        { method: 'POST', body: JSON.stringify({ schemeIds: [tSchemeId], formats: ['ticket_pdf'] }) },
        tAgent
      );
      assert.equal(zipDenied.status, 403);

      const rollDenied = await apiJsonOn(
        targetUrl,
        '/api/v2/inventory/import/rolls',
        { method: 'POST', headers: { 'Idempotency-Key': `T3-DENY-${tag}` }, body: JSON.stringify({ idempotencyKey: `T3-DENY-${tag}`, rows: [{ rollId: 'X', rollModel: 'M', width: 1000, totalLength: 5000 }] }) },
        tAgent
      );
      assert.equal(rollDenied.status, 403);

      const auditCheck = await apiJsonOn(targetUrl, '/api/v2/audit-logs?action=ACCESS_DENIED&limit=10', {}, tAdmin);
      assert.equal(auditCheck.status, 200);
      assert.ok(
        (auditCheck.data?.items || []).some(
          (x) =>
            x.outcome === 'DENIED' &&
            x.httpStatus === 403 &&
            ((x.requestPath || x.targetId || '').includes('/api/v2/exports/batch-zip') ||
              (x.requestPath || x.targetId || '').includes('/api/v2/inventory/import/rolls'))
        ),
        `应记录 403 ACCESS_DENIED 审计: ${auditCheck.raw}`
      );

      const outT3Auth = path.join(tmpWorkDir, `gate-t3-auth-${tag}.json`);
      const gateAuthRes = spawnSync(
        process.execPath,
        [
          BENCH_GATE_CLI,
          '--base',
          targetUrl,
          '--auth',
          '--username',
          authAdminUser,
          '--password',
          authAdminPass,
          '--problems',
          'guillotine-java',
          '--out',
          outT3Auth
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      assert.equal(gateAuthRes.status, 0, `ADMIN --auth 运行 benchmark/gate.mjs 应返回 0:\n${gateAuthRes.stderr}`);

      return { agentZipDenied: 403, agentImportDenied: 403, adminBenchExit: 0 };
    } finally {
      if (auxPid) await stopIsolatedJava(auxPid);
      if (auxDir && fs.existsSync(auxDir)) fs.rmSync(auxDir, { recursive: true, force: true });
    }
  });
} catch (err) {
  failedError = err;
  try {
    const firstCtx = contextsToClose[0];
    const firstPage = firstCtx?.pages?.()[0];
    if (firstPage && !firstPage.isClosed()) {
      const ssPath = resultFile
        ? resultFile.replace(/\.result\.json$/i, '.fail.png')
        : path.join(os.tmpdir(), `import-export-bench-fail-${tag}.png`);
      await firstPage.screenshot({ path: ssPath, fullPage: true });
      failureScreenshot = ssPath;
    }
  } catch {}
} finally {
  for (const ctx of contextsToClose) {
    await ctx.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
  for (const pid of auxChildPids) {
    await stopIsolatedJava(pid);
  }
  if (fs.existsSync(tmpWorkDir)) {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  }
}

const prodStateAfter = sha256File(PROD_STATE_FILE);
const prodDraftsAfter = fingerprintDir(PROD_DRAFTS_DIR);
const prodInventoryUntouched = prodStateAfter === prodStateBefore;
const prodDraftsUntouched = prodDraftsAfter === prodDraftsBefore;

assert.equal(pageErrors.length, 0, `发生未捕获前端 pageerror: ${pageErrors.join(' | ')}`);
assert.equal(nativeDialogs.length, 0, `禁止使用原生 alert/confirm/prompt: ${nativeDialogs.join(' | ')}`);
assert.equal(prodInventoryUntouched, true, '正式 data/cutdemo-state.json SHA-256 发生变更！');
assert.equal(prodDraftsUntouched, true, '正式 data/cutdemo-state.json.drafts 指纹发生变更！');

const passedCount = checks.filter((c) => c.status === 'PASS').length;
const failedCount = checks.filter((c) => c.status === 'FAIL').length;

const summary = {
  script: 'import-export-and-benchmark',
  baseUrl,
  executed: checks.length,
  passed: passedCount,
  failed: failedCount,
  skipped: 0,
  checks,
  pageErrors,
  nativeDialogs,
  failureScreenshot,
  prodInventoryUntouched,
  prodDraftsUntouched
};

if (resultFile) {
  fs.mkdirSync(path.dirname(path.resolve(resultFile)), { recursive: true });
  fs.writeFileSync(path.resolve(resultFile), JSON.stringify(summary, null, 2), 'utf8');
}

console.log(JSON.stringify(summary, null, 2));

if (failedError || failedCount > 0 || checks.length !== 27) {
  if (failedError) {
    console.error(failedError);
  }
  process.exitCode = 1;
}
