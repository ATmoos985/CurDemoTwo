// 面向当前 React 主路由的现代端到端验收与四层 Konva 画布性能基线脚本。
// 强制运行于独立隔离服务（BASE_URL 必须为 localhost/127.0.0.1 且端口严禁为 8080），严禁污染正式 8080 库存。
// 覆盖三大核心现代验收闭环：
//   1. 加工正确性闭环：带孔异形裁片 + 边界 20mm 安全边距疵点 -> React #/workbench 选卷求解 -> 确认落库 HTTP 200 -> G-Code 内孔先切且无干涉校验；
//   2. 跨任务复检一致性闭环：双任务合排完工报工 -> 单片复检判废（原母卷消耗不变）-> #/workbench / #/quality / #/cost-analytics 三处净良品与余量一致；
//   3. React 四层 Konva 画布（WorkbenchBoardCanvas）交互帧耗时基线采样：真实滚轮缩放与拖拽平移 P50/P95 帧耗时统计，替代旧 DOM canvas-performance.cjs。
//
// 用法示例：
//   BASE_URL=http://127.0.0.1:18095 [RESULT_FILE=...] [PERF_P95_BUDGET_MS=120] node src/test/browser/app-react-closure-and-perf.cjs

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');

const base = process.env.BASE_URL;
assert.ok(base, '必须提供环境变量 BASE_URL（隔离测试服务地址）');
const parsedBase = new URL(base);
assert.ok(
  ['localhost', '127.0.0.1'].includes(parsedBase.hostname),
  `BASE_URL 主机名仅允许 localhost 或 127.0.0.1，当前为: ${parsedBase.hostname}`
);
assert.ok(
  parsedBase.port && parsedBase.port !== '8080',
  `严禁连接正式 8080 端口，必须使用独立非 8080 隔离端口，当前 BASE_URL=${base}`
);

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PERF_P95_BUDGET_MS = process.env.PERF_P95_BUDGET_MS
  ? Number(process.env.PERF_P95_BUDGET_MS)
  : 500;

async function apiGet(path) {
  const res = await fetch(base + path);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 错误正文
  }
  assert.ok(res.ok, `GET ${path} 失败: HTTP ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function apiPost(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 错误正文
  }
  assert.ok(res.ok, `POST ${path} 失败: HTTP ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data: json };
}

const waitFrames = (page, count = 2) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let left = Math.max(1, n);
        const tick = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count
  );

/** 读取 Playwright 下载流为 UTF-8 字符串，兼容不同浏览器落盘模式。 */
async function readDownloadText(download) {
  const filePath = await download.path();
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const stream = await download.createReadStream();
  assert.ok(stream, '未能获取下载文件读取流');
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 仅启用 JAVA_FAST 策略，确保工作台求解快速、确定且不依赖外部 C++ 二进制。 */
async function enableOnlyJavaFastStrategy(page) {
  await page.locator('#engine-status').click();
  const dialog = page.locator('dialog#studio-settings-dialog[open]');
  await dialog.waitFor();
  const javaFastInput = dialog.locator('#cfg-strategy-JAVA_FAST');
  await javaFastInput.waitFor();
  if (!(await javaFastInput.isChecked())) {
    await javaFastInput.click();
  }
  const rows = dialog.locator('[data-strategy-id]');
  const total = await rows.count();
  for (let i = 0; i < total; i++) {
    const row = rows.nth(i);
    const sid = await row.getAttribute('data-strategy-id');
    const cb = row.locator('input[type="checkbox"]');
    if (sid !== 'JAVA_FAST' && (await cb.isChecked())) {
      await cb.click();
    }
  }
  await dialog.getByRole('button', { name: '保存并应用', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('dialog#studio-settings-dialog[open]').length === 0
  );
}

/** 校验两矩形是否存在实质重叠（允许 0.1 mm 浮点误差）。 */
function rectsOverlap(a, b, tol = 0.1) {
  return (
    a.x < b.x + b.w - tol &&
    a.x + a.w > b.x + tol &&
    a.y < b.y + b.l - tol &&
    a.y + a.l > b.y + tol
  );
}

/** 解析 G-Code 文本，校验内孔先切顺序、坐标无越界且无侵入 20mm 边界禁区。 */
function verifyHoledGCode(ncText, { rollWidthMm, minSafeYMm, placements }) {
  assert.ok(typeof ncText === 'string' && ncText.length > 80, '导出的 G-Code 内容为空或过短');
  assert.ok(ncText.includes('G21'), 'G-Code 缺少公制单位指令 G21');
  assert.ok(ncText.includes('G90'), 'G-Code 缺少绝对坐标指令 G90');
  assert.ok(ncText.includes('M30'), 'G-Code 缺少程序结束指令 M30');

  const lines = ncText.split(/\r?\n/);
  const innerHoleLines = [];
  const outerContourLines = [];
  const cuttingPoints = [];

  // 解析每段加工头注释与全部 G01 切削轨迹点
  let currentSection = null;
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/INNER\s*HOLE|内孔/i.test(line) && line.startsWith('(')) {
      innerHoleLines.push({ lineNo: i + 1, text: line });
      currentSection = { kind: 'HOLE', lineNo: i + 1, text: line, points: [] };
      sections.push(currentSection);
    } else if (/OUTER\s*CONTOUR|外轮廓|\(---\s*CONTOUR\s+\d+:/i.test(line) && line.startsWith('(')) {
      outerContourLines.push({ lineNo: i + 1, text: line });
      currentSection = { kind: 'OUTER', lineNo: i + 1, text: line, points: [] };
      sections.push(currentSection);
    }
    const g01 = line.match(/^G01\s+X(-?\d+(?:\.\d+)?)\s+Y(-?\d+(?:\.\d+)?)/i);
    if (g01) {
      const pt = { lineNo: i + 1, x: Number(g01[1]), y: Number(g01[2]) };
      cuttingPoints.push(pt);
      if (currentSection) currentSection.points.push(pt);
    }
  }

  assert.ok(
    innerHoleLines.length >= placements.length,
    `G-Code 必须包含不少于 ${placements.length} 段内孔先切注释（INNER HOLE），实际命中 ${innerHoleLines.length} 段`
  );
  assert.ok(
    outerContourLines.length >= placements.length,
    `G-Code 必须包含不少于 ${placements.length} 段外轮廓加工注释（OUTER CONTOUR），实际命中 ${outerContourLines.length} 段`
  );
  assert.ok(cuttingPoints.length >= placements.length * 8, 'G-Code 切削轨迹点数量不足，缺少完整内孔+外轮廓路径');

  // 验证“先切内孔、后切外轮廓”顺序：
  // 既兼容“整单先切全部内孔、后切全部外轮廓”，也兼容“逐片先切本片内孔、紧接着切本片外轮廓”
  let holeSeenBeforeFirstOuter = false;
  let pendingHoles = 0;
  for (const sec of sections) {
    if (sec.kind === 'HOLE') {
      pendingHoles += 1;
      if (outerContourLines.length > 0 && sec.lineNo < outerContourLines[0].lineNo) {
        holeSeenBeforeFirstOuter = true;
      }
      assert.ok(sec.points.length >= 3, `内孔加工段 ${sec.text} 缺少闭合 G01 轨迹`);
    } else if (sec.kind === 'OUTER') {
      assert.ok(
        pendingHoles > 0,
        `检测到外轮廓段（行 ${sec.lineNo}）出现在对应内孔之前，违反“先内孔后外轮廓”工业 CNC 加工规范`
      );
      pendingHoles -= 1;
      assert.ok(sec.points.length >= 3, `外轮廓加工段 ${sec.text} 缺少闭合 G01 轨迹`);
    }
  }
  assert.ok(holeSeenBeforeFirstOuter, '首条外轮廓之前未检测到任何内孔切削轨迹');

  // 验证所有 G01 切削点不越界、不侵入边界 20mm 安全禁区
  for (const pt of cuttingPoints) {
    assert.ok(
      pt.x >= -0.1 && pt.x <= rollWidthMm + 0.1,
      `G-Code 切削点越出母卷门幅 [0, ${rollWidthMm}]：行 ${pt.lineNo} X=${pt.x}`
    );
    assert.ok(
      pt.y >= minSafeYMm - 0.15,
      `G-Code 切削点侵入边界 20mm 疵点禁区（安全下界 Y>=${minSafeYMm}）：行 ${pt.lineNo} Y=${pt.y}`
    );
  }

  // 验证每个内孔轨迹点严格落在至少一个已排裁片的外包围盒内部（无干涉越界）
  for (const sec of sections.filter((s) => s.kind === 'HOLE')) {
    const insideSomePlacement = placements.some((p) => {
      const pw = Number(p.shape?.width ?? p.w) || 0;
      const ph = Number(p.shape?.height ?? p.l) || 0;
      return sec.points.every(
        (pt) =>
          pt.x >= p.x - 0.2 &&
          pt.x <= p.x + pw + 0.2 &&
          pt.y >= p.y - 0.2 &&
          pt.y <= p.y + ph + 0.2
      );
    });
    assert.ok(
      insideSomePlacement,
      `内孔轨迹段（行 ${sec.lineNo}: ${sec.text}）存在越出裁片外轮廓包围盒的点，疑似坐标偏移或干涉`
    );
  }

  return {
    innerHoleSegments: innerHoleLines.length,
    outerContourSegments: outerContourLines.length,
    totalG01Points: cuttingPoints.length
  };
}

/** 借助 CDP Performance.getMetrics 与页面 rAF 采集交互帧耗时分布。 */
async function measureCanvasInteraction(page, cdp, name, prepare, steps, stepFn) {
  await prepare();
  await waitFrames(page, 3);
  const readMetrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
    );

  await page.evaluate(() => {
    window.__reactPerfFrames = [];
    window.__reactPerfActive = true;
    const loop = (ts) => {
      window.__reactPerfFrames.push(ts);
      if (window.__reactPerfActive) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  const before = await readMetrics();
  for (let i = 0; i < steps; i++) {
    await stepFn(i);
    await waitFrames(page, 2);
  }
  const after = await readMetrics();
  const stamps = await page.evaluate(() => {
    window.__reactPerfActive = false;
    return window.__reactPerfFrames || [];
  });

  const intervals = stamps
    .slice(1)
    .map((ts, idx) => ts - stamps[idx])
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  assert.ok(intervals.length >= 10, `${name} 采集帧数过少（仅 ${intervals.length} 帧）`);

  const quantile = (q) => intervals[Math.min(intervals.length - 1, Math.floor(q * intervals.length))];
  return {
    name,
    steps,
    sampleFrames: intervals.length,
    busyMsPerStep: Number((((after.TaskDuration - before.TaskDuration) * 1000) / steps).toFixed(2)),
    scriptMsPerStep: Number(
      (((after.ScriptDuration - before.ScriptDuration) * 1000) / steps).toFixed(2)
    ),
    frameP50Ms: Number(quantile(0.5).toFixed(2)),
    frameP95Ms: Number(quantile(0.95).toFixed(2)),
    frameMaxMs: Number((intervals[intervals.length - 1] || 0).toFixed(2))
  };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  });

  const results = [];
  const perfMetrics = {};
  const pageErrors = [];
  const nativeDialogs = [];

  async function runStep(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, success: true, ...(detail ? { detail } : {}) });
      console.log('PASS:', name);
    } catch (err) {
      results.push({ name, success: false, error: err.message });
      console.error('FAIL:', name, err.stack || err.message);
    }
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', async (d) => {
    nativeDialogs.push(`${d.type()}: ${d.message()}`);
    await d.dismiss();
  });

  try {
    // =========================================================================
    // 场景 1：加工正确性闭环（带孔异形裁片 + 边界 20mm 疵点）
    // =========================================================================
    await runStep(
      '加工正确性闭环：带孔异形裁片 + 边界20mm安全边距疵点 -> 选卷求解落库200 -> G-Code内孔先切无干涉',
      async () => {
        const tag = 'E2E-HOLE-' + randomUUID().slice(0, 8).toUpperCase();
        const rollId = `ROLL-${tag}`;
        const model = `MOD-${tag}`;
        const rollWidth = 1600;
        const usedLen = 1000;
        const expectedBoundaryExclusionHeight = 15; // y=985, h=10, margin=20 => 扩边至 [965, 1015]，裁切到 startY=1000 后局部为 [0, 15]

        // 1.1 创建母卷，在工位起切线外沿 5mm 处录入带 20mm 安全边距的通幅疵点，并执行正式质检放行
        await apiPost('/api/rolls', {
          rollId,
          rollModel: model,
          width: rollWidth,
          totalLength: 10000,
          usedLength: usedLen,
          storageLocation: 'E2E隔离库位-A1',
          inspectionStatus: 'PENDING'
        });
        await apiPost(`/api/rolls/${encodeURIComponent(rollId)}/inspection-defects`, {
          width: rollWidth,
          totalLength: 10000,
          defects: [
            {
              x: 0,
              y: 985,
              w: rollWidth,
              h: 10,
              margin: 20,
              defectType: 'MANUAL_MARK',
              typeName: '边界20mm外扩疵点',
              captureId: randomUUID()
            }
          ]
        });
        await apiPost(`/api/v2/quality/rolls/${encodeURIComponent(rollId)}/inspect-complete`, {
          status: 'PASSED',
          inspector: 'E2E验布员',
          remarks: '边界20mm疵点验收合格放行'
        });

        const rollAfterPass = await apiGet(`/api/rolls/${encodeURIComponent(rollId)}`);
        assert.equal(rollAfterPass.inspectionStatus, 'PASSED', '母卷必须处于 PASSED 状态');
        assert.ok(
          Array.isArray(rollAfterPass.defects) && rollAfterPass.defects.length === 1,
          '母卷应保存 1 处边界 20mm 安全边距疵点'
        );

        // 1.2 创建含带孔异形裁片的需求族
        const outerVertices = [
          { x: 0, y: 0 },
          { x: 560, y: 0 },
          { x: 600, y: 40 },
          { x: 600, y: 400 },
          { x: 0, y: 400 }
        ];
        const innerHole = [
          { x: 180, y: 120 },
          { x: 420, y: 120 },
          { x: 420, y: 280 },
          { x: 180, y: 280 }
        ];
        const { data: createdFamily } = await apiPost('/api/v2/demand-pool', {
          name: `带孔异形验收-${tag}`,
          materialModel: model,
          dimension: 'CONTOUR_2D',
          bedLengthMm: 2200,
          trimStartMm: 0,
          pieceGapMm: 0,
          demands: [
            {
              id: 1,
              name: '带内孔切角板件',
              width: 600,
              length: 400,
              quantity: 2,
              allowRotation: false,
              allowHalfTurn: false,
              shape: {
                type: 'POLYGON',
                width: 600,
                height: 400,
                vertices: outerVertices,
                holes: [innerHole]
              }
            }
          ]
        });
        const holeTaskId = createdFamily.id;
        assert.ok(holeTaskId, '带孔需求族创建失败');

        // 1.3 在 React #/workbench 加载该需求族，启用快速基线策略并选中该 PASSED 实卷
        await page.goto(`${base}/app/#/workbench/${encodeURIComponent(holeTaskId)}`);
        await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();
        await page.locator('.wb-demand-prog-row').first().waitFor();
        await enableOnlyJavaFastStrategy(page);

        await page
          .locator('.studio-top-bar [aria-label="母卷投料来源"] button', { hasText: '现有母卷' })
          .click();
        const rollSelect = page.locator('.studio-canvas-inputs select').first();
        await rollSelect.waitFor();
        await rollSelect.selectOption(rollId);
        await waitFrames(page, 3);

        // 核验四层 Konva 舞台挂载（base / pieces / toolpath / dynamic）
        const canvasMeta = await page.evaluate(() => {
          const host = document.querySelector('.wb-board-konva-host');
          const stages = globalThis.Konva?.stages || [];
          const stage = stages.find((s) => s.container() === host);
          if (!stage) return null;
          return {
            layerCount: stage.getLayers().length,
            width: stage.width(),
            height: stage.height()
          };
        });
        assert.ok(canvasMeta, 'WorkbenchBoardCanvas 的 Konva Stage 未挂载');
        assert.equal(canvasMeta.layerCount, 4, 'WorkbenchBoardCanvas 必须保持 4 层独立 Konva Layer');

        // 1.4 捕获求解请求体，断言边界 20mm 外扩禁区未被裁窗丢失，随后确认落库 HTTP 200
        const capturedSolveBodies = [];
        const onRequest = (req) => {
          if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v2/optimization-jobs') {
            try {
              capturedSolveBodies.push(JSON.parse(req.postData() || '{}'));
            } catch {
              // ignore parse failure
            }
          }
        };
        page.on('request', onRequest);

        try {
          await page
            .locator('.studio-right-foot')
            .getByRole('button', { name: '开始排版', exact: true })
            .click();
          await page.locator('.scheme-slot.on').waitFor({ timeout: 25000 });
        } finally {
          page.off('request', onRequest);
        }

        assert.ok(capturedSolveBodies.length >= 1, '工作台未向 /api/v2/optimization-jobs 发出求解请求');
        const solveReq = capturedSolveBodies[capturedSolveBodies.length - 1];
        const exclusions = solveReq?.problem?.material?.exclusions || [];
        const boundaryExclusion = exclusions.find((ex) => {
          const y0 = Number(ex.y) || 0;
          const h = Number(ex.shape?.height) || 0;
          const w = Number(ex.shape?.width) || 0;
          return y0 <= 0.2 && y0 + h >= expectedBoundaryExclusionHeight - 0.2 && w >= rollWidth - 1;
        });
        assert.ok(
          boundaryExclusion,
          `前端实卷避疵裁窗丢失了工位边界 20mm 安全边距禁区（期望局部覆盖 Y∈[0,15]），实际 exclusions=${JSON.stringify(exclusions)}`
        );

        const confirmResponsePromise = page.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            new URL(res.url()).pathname === '/api/v2/schemes/confirm'
        );
        await page.getByRole('button', { name: '选定此方案' }).click();
        const confirmRes = await confirmResponsePromise;
        assert.equal(confirmRes.status(), 200, `方案确认落库必须返回 HTTP 200，实际为 ${confirmRes.status()}`);
        const confirmPayload = await confirmRes.json();
        const confirmedScheme = confirmPayload?.scheme;
        assert.ok(confirmedScheme?.id, '方案确认响应缺少 scheme.id');
        assert.equal(confirmedScheme.rollId, rollId, '确认方案应直接锁定所选合格实卷');

        // 校验落库方案所有裁片几何避开边界 20mm 禁区（Y >= 15mm）且互不重叠
        const savedPlacements = confirmedScheme.layout2D?.placements || [];
        assert.equal(savedPlacements.length, 2, '应排入全部 2 件带孔异形裁片');
        for (const p of savedPlacements) {
          const verts = p.shape?.vertices || [];
          const minVertY = verts.length
            ? Math.min(...verts.map((v) => Number(p.y) + Number(v.y)))
            : Number(p.y);
          assert.ok(
            minVertY >= expectedBoundaryExclusionHeight - 0.1,
            `裁片 #${p.id} 压入了 20mm 边界疵点禁区（minY=${minVertY} < ${expectedBoundaryExclusionHeight}）`
          );
          assert.ok(
            Number(p.x) >= -0.1 && Number(p.x) + Number(p.shape?.width ?? p.w) <= rollWidth + 0.1,
            `裁片 #${p.id} 超出母卷门幅 ${rollWidth}mm`
          );
          assert.ok(
            Array.isArray(p.shape?.holes) && p.shape.holes.length === 1,
            `落库裁片 #${p.id} 缺失内孔洞几何 shape.holes，无法进行内孔先切加工`
          );
        }
        assert.ok(
          !rectsOverlap(savedPlacements[0], savedPlacements[1]),
          '落库的两件带孔裁片存在包围盒干涉重叠'
        );

        // 1.5 在 React 工作台触发导出 G-Code 并校验“先切内孔、后切外轮廓”且无干涉
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '导出 G-Code', exact: true }).click();
        const download = await downloadPromise;
        assert.ok(
          download.suggestedFilename().toLowerCase().endsWith('.nc'),
          `G-Code 导出文件名应以 .nc 结尾，实际为 ${download.suggestedFilename()}`
        );
        const ncText = await readDownloadText(download);
        const ncStats = verifyHoledGCode(ncText, {
          rollWidthMm: rollWidth,
          minSafeYMm: expectedBoundaryExclusionHeight,
          placements: savedPlacements
        });

        return {
          rollId,
          schemeId: confirmedScheme.id,
          placedCount: savedPlacements.length,
          ...ncStats
        };
      }
    );

    // =========================================================================
    // 场景 2：跨任务复检一致性闭环（#/workbench、#/quality、#/cost-analytics）
    // =========================================================================
    await runStep(
      '跨任务复检一致性闭环：双任务合排报工后复检判废 -> 工作台/质检/成本三处净良品与余量完全一致',
      async () => {
        const tag = 'E2E-QUAL-' + randomUUID().slice(0, 8).toUpperCase();
        const rollId = `ROLL-${tag}`;
        const model = `MOD-${tag}`;

        // 2.1 建立隔离 PASSED 母卷（明确设置单价便于成本核算精确验真）
        await apiPost('/api/rolls', {
          rollId,
          rollModel: model,
          width: 1600,
          totalLength: 10000,
          usedLength: 0,
          unitPricePerSqm: 40,
          storageLocation: 'E2E隔离库位-B1',
          inspectionStatus: 'PENDING'
        });
        await apiPost(`/api/v2/quality/rolls/${encodeURIComponent(rollId)}/inspect-complete`, {
          status: 'PASSED',
          inspector: 'E2E质检员',
          remarks: '跨任务复检一致性验收放行'
        });

        // 2.2 建立两个独立矩形需求族：任务 A（500×400×2，单片 0.20m²）与任务 B（600×400×2，单片 0.24m²）
        const { data: taskA } = await apiPost('/api/v2/demand-pool', {
          name: `跨任务复检A-${tag}`,
          materialModel: model,
          dimension: 'RECT_2D',
          bedLengthMm: 2000,
          trimStartMm: 0,
          pieceGapMm: 0,
          demands: [
            { id: 1, name: 'A门帘主片', width: 500, length: 400, quantity: 2, allowRotation: false }
          ]
        });
        const { data: taskB } = await apiPost('/api/v2/demand-pool', {
          name: `跨任务复检B-${tag}`,
          materialModel: model,
          dimension: 'RECT_2D',
          bedLengthMm: 2000,
          trimStartMm: 0,
          pieceGapMm: 0,
          demands: [
            { id: 1, name: 'B侧帘辅片', width: 600, length: 400, quantity: 2, allowRotation: false }
          ]
        });

        // 2.3 确认跨任务多族合排方案（锁实卷 READY_TO_CUT）并完工报工
        const placements = [
          {
            id: 1,
            demandId: 1,
            name: 'A门帘主片',
            x: 0,
            y: 0,
            w: 500,
            l: 400,
            rotationDegrees: 0,
            gapFill: false,
            sourceTaskId: taskA.id,
            sourceLineId: 1
          },
          {
            id: 2,
            demandId: 1,
            name: 'A门帘主片',
            x: 500,
            y: 0,
            w: 500,
            l: 400,
            rotationDegrees: 0,
            gapFill: false,
            sourceTaskId: taskA.id,
            sourceLineId: 1
          },
          {
            id: 3,
            demandId: 2,
            name: 'B侧帘辅片',
            x: 0,
            y: 400,
            w: 600,
            l: 400,
            rotationDegrees: 0,
            gapFill: false,
            sourceTaskId: taskB.id,
            sourceLineId: 1
          },
          {
            id: 4,
            demandId: 2,
            name: 'B侧帘辅片',
            x: 600,
            y: 400,
            w: 600,
            l: 400,
            rotationDegrees: 0,
            gapFill: false,
            sourceTaskId: taskB.id,
            sourceLineId: 1
          }
        ];

        const { status: confirmStatus, data: confirmData } = await apiPost('/api/v2/schemes/confirm', {
          idempotencyKey: `E2E-CROSS-${tag}`,
          title: `跨任务合排-${tag}`,
          dimension: 'RECT_2D',
          scenarioId: 'SHORTEN_KIT',
          strategyId: 'JAVA_FAST',
          strategyName: '快速基线',
          taskId: taskA.id,
          taskName: taskA.name,
          materialMode: 'STOCK_ROLL',
          rollId,
          materialModel: model,
          widthMm: 1600,
          canvasLengthMm: 1200,
          windowStartY: 0,
          occupiedLengthMm: 800,
          trimStartMm: 0,
          pieceGapMm: 0,
          utilizationPct: 68.75,
          pieceAreaM2: 0.88,
          demands: [
            {
              id: 1,
              name: 'A门帘主片',
              width: 500,
              length: 400,
              quantity: 2,
              allowRotation: false,
              sourceTaskId: taskA.id,
              sourceLineId: 1
            },
            {
              id: 2,
              name: 'B侧帘辅片',
              width: 600,
              length: 400,
              quantity: 2,
              allowRotation: false,
              sourceTaskId: taskB.id,
              sourceLineId: 1
            }
          ],
          sourceAllocations: [
            { taskId: taskA.id, lineId: 1, quantity: 2 },
            { taskId: taskB.id, lineId: 1, quantity: 2 }
          ],
          layout2D: {
            placements,
            leftovers: [],
            cuts: []
          }
        });
        assert.equal(confirmStatus, 200, '跨任务合排确认方案必须返回 HTTP 200');
        const schemeId = confirmData.scheme.id;
        assert.equal(confirmData.scheme.state, 'READY_TO_CUT');

        await apiPost(`/api/v2/schemes/${encodeURIComponent(schemeId)}/complete`, {
          actualCutLenMm: 800,
          rejectedPieceIds: [],
          recoverRemnants: false,
          remnantLocation: 'E2E隔离余料区',
          operator: 'E2E报工员'
        });

        const rollBeforeDisp = await apiGet(`/api/rolls/${encodeURIComponent(rollId)}`);
        const usedLenBeforeDisp = Number(rollBeforeDisp.usedLength);
        assert.ok(usedLenBeforeDisp >= 800 - 0.1, '完工报工后母卷已用长度应推进至 >= 800mm');

        // 2.4 查找报工单并对属于任务 A 的 1 件合格裁片执行复检判废（SCRAP）
        const reconReports = await apiGet(
          `/api/v2/reconciliation/reports?limit=50&offset=0&taskId=${encodeURIComponent(taskA.id)}`
        );
        const reportEntry = (reconReports?.items || []).find(
          (it) => it?.report?.rollId === rollId || it?.rollId === rollId
        );
        assert.ok(reportEntry, '未在聚合报工列表中找到刚完工的跨任务报工单');
        const reportObj = reportEntry.report || reportEntry;
        const planId = reportObj.planId;
        assert.ok(planId, '报工回执缺少 planId');

        const taskAPiece = (reportObj.pieceResults || []).find(
          (p) =>
            p.outcome === 'QUALIFIED' &&
            (p.sourceTaskId === taskA.id || (Math.abs(Number(p.w) - 500) < 1 && Math.abs(Number(p.l) - 400) < 1))
        );
        assert.ok(taskAPiece, '未在报工明细中找到属于任务 A 的可复检合格裁片');

        await apiPost(`/api/cutting/reports/${encodeURIComponent(planId)}/quality-dispositions`, {
          operationId: randomUUID(),
          expectedRevision: reportObj.qualityRevision ?? 0,
          pieceId: Number(taskAPiece.pieceId),
          disposition: 'SCRAP',
          inspector: 'E2E复检员',
          reason: '跨任务复检一致性验收：任务A单片抽丝判废',
          recovery: null
        });

        // 校验铁律：复检判废不恢复已消耗母卷长度
        const rollAfterDisp = await apiGet(`/api/rolls/${encodeURIComponent(rollId)}`);
        assert.equal(
          Number(rollAfterDisp.usedLength),
          usedLenBeforeDisp,
          '复检判废严禁恢复已消耗母卷长度'
        );

        // 2.5 校验后端需求池与三处 React 页面（#/workbench、#/quality、#/cost-analytics）完全一致
        const [famAAfter, famBAfter, costSummary] = await Promise.all([
          apiGet(`/api/v2/demand-pool/${encodeURIComponent(taskA.id)}`),
          apiGet(`/api/v2/demand-pool/${encodeURIComponent(taskB.id)}`),
          apiGet('/api/v2/analytics/cost-summary?defaultUnitPricePerSqm=40&remnantResidualFactor=0.7')
        ]);

        assert.equal(famAAfter.completedTotal, 1, '任务 A 复检判废 1 件后净良品完成数应为 1');
        assert.equal(famAAfter.openTotal, 1, '任务 A 复检判废 1 件后待补排余量应退回为 1');
        assert.equal(famBAfter.completedTotal, 2, '任务 B 净良品完成数应保持为 2，不得被任务 A 判废误扣');
        assert.equal(famBAfter.openTotal, 0, '任务 B 待排余量应保持为 0');

        const costRowA = (costSummary.byTask || []).find((r) => r.taskId === taskA.id);
        const costRowB = (costSummary.byTask || []).find((r) => r.taskId === taskB.id);
        assert.ok(costRowA && costRowB, '/api/v2/analytics/cost-summary 必须同时包含任务 A 与任务 B 归集行');
        assert.equal(
          Number(costRowA.netGoodPieceCount),
          famAAfter.completedTotal,
          '成本分析中任务 A 净良品件数必须与需求池一致（1 件）'
        );
        assert.equal(
          Number(costRowB.netGoodPieceCount),
          famBAfter.completedTotal,
          '成本分析中任务 B 净良品件数必须与需求池一致（2 件）'
        );
        assert.ok(
          Math.abs(Number(costRowA.netGoodAreaM2) - 0.2) < 0.005,
          `成本分析中任务 A 净良品面积应为 0.20 m²，实际为 ${costRowA.netGoodAreaM2}`
        );
        assert.ok(
          Math.abs(Number(costRowB.netGoodAreaM2) - 0.48) < 0.005,
          `成本分析中任务 B 净良品面积应为 0.48 m²，实际为 ${costRowB.netGoodAreaM2}`
        );

        // 页面 1：#/workbench/<taskA.id> 与 #/workbench/<taskB.id>
        await page.goto(`${base}/app/#/workbench/${encodeURIComponent(taskA.id)}`);
        await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();
        await page.locator('.wb-demand-prog-row').first().waitFor();
        const wbSummaryA = await page.locator('.wb-summary-strip').innerText();
        assert.ok(
          wbSummaryA.includes('1/2') && wbSummaryA.includes('余 1'),
          `#/workbench 任务 A 进度条未反映复检判废后的净良品 1/2 与待补排余量 1：${wbSummaryA}`
        );

        await page.goto(`${base}/app/#/workbench/${encodeURIComponent(taskB.id)}`);
        await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();
        await page.waitForFunction(
          (name) => document.body.innerText.includes(name),
          taskB.name
        );
        const wbSummaryB = await page.locator('.wb-summary-strip').innerText();
        assert.ok(
          wbSummaryB.includes('2/2') && wbSummaryB.includes('已排齐'),
          `#/workbench 任务 B 应保持 2/2 已排齐，不受任务 A 复检影响：${wbSummaryB}`
        );

        // 页面 2：#/quality 复检处置页（核验合格=3、异常=1、已复检=1）
        await page.goto(`${base}/app/#/quality`);
        await page.getByRole('heading', { name: '复检处置', exact: true, level: 1 }).waitFor();
        const qualityRow = page.locator('tbody tr', { hasText: rollId }).first();
        await qualityRow.waitFor({ timeout: 10000 });
        const qCells = await qualityRow.locator('td').evaluateAll((tds) =>
          tds.map((td) => td.textContent.trim())
        );
        // 列序：0报工单, 1任务, 2母卷/料头, 3实切mm, 4合格, 5异常, 6可复检, 7已复检
        assert.equal(qCells[4], '3', `#/quality 净合格件数应为 3，实际行数据=${JSON.stringify(qCells)}`);
        assert.equal(qCells[5], '1', `#/quality 异常/判废件数应为 1，实际行数据=${JSON.stringify(qCells)}`);
        assert.equal(qCells[7], '1', `#/quality 已复检处置数应为 1，实际行数据=${JSON.stringify(qCells)}`);

        // 页面 3：#/cost-analytics 成本与备料分析页（核验按任务归集净良品面积与后端严格一致）
        await page.goto(`${base}/app/#/cost-analytics`);
        await page.getByRole('heading', { name: '成本与备料分析', exact: true, level: 1 }).waitFor();
        const costRowATr = page.locator('tbody tr', { hasText: taskA.id }).first();
        const costRowBTr = page.locator('tbody tr', { hasText: taskB.id }).first();
        await costRowATr.waitFor({ timeout: 10000 });
        await costRowBTr.waitFor({ timeout: 10000 });
        // 列序：0任务编号/名称, 1报工数, 2耗料面积, 3净良品(m²), ...
        const costCellsA = await costRowATr.locator('td').evaluateAll((tds) =>
          tds.map((td) => td.textContent.trim())
        );
        const costCellsB = await costRowBTr.locator('td').evaluateAll((tds) =>
          tds.map((td) => td.textContent.trim())
        );
        assert.ok(
          costCellsA[3].includes('0.20') || Math.abs(Number(costCellsA[3]) - 0.2) < 0.01,
          `#/cost-analytics 任务 A 净良品面积列应为 0.20 m²，实际=${costCellsA[3]}`
        );
        assert.ok(
          costCellsB[3].includes('0.48') || Math.abs(Number(costCellsB[3]) - 0.48) < 0.01,
          `#/cost-analytics 任务 B 净良品面积列应为 0.48 m²，实际=${costCellsB[3]}`
        );

        return {
          taskAId: taskA.id,
          taskBId: taskB.id,
          planId,
          netGoodA: famAAfter.completedTotal,
          openA: famAAfter.openTotal,
          netGoodB: famBAfter.completedTotal,
          qualityRowNetGood: Number(qCells[4]),
          costAreaA: costRowA.netGoodAreaM2,
          costAreaB: costRowB.netGoodAreaM2
        };
      }
    );

    // =========================================================================
    // 场景 3：React 四层 Konva 画布（WorkbenchBoardCanvas）交互帧耗时基线采样
    // =========================================================================
    await runStep(
      'React 四层 Konva 画布（WorkbenchBoardCanvas）滚轮缩放与拖拽平移帧耗时基线采样',
      async () => {
        const tag = 'E2E-PERF-' + randomUUID().slice(0, 8).toUpperCase();
        const { data: perfFamily } = await apiPost('/api/v2/demand-pool', {
          name: `画布性能基准-${tag}`,
          materialModel: `PERF-${tag}`,
          dimension: 'RECT_2D',
          bedLengthMm: 6000,
          trimStartMm: 0,
          pieceGapMm: 0,
          demands: [
            { id: 1, name: '主帘片A', width: 320, length: 420, quantity: 20, allowRotation: true },
            { id: 2, name: '副帘片B', width: 260, length: 380, quantity: 20, allowRotation: true },
            { id: 3, name: '门襟条C', width: 210, length: 340, quantity: 20, allowRotation: true },
            { id: 4, name: '绑带片D', width: 180, length: 280, quantity: 20, allowRotation: true }
          ]
        });

        await page.goto(`${base}/app/#/workbench/${encodeURIComponent(perfFamily.id)}`);
        await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();
        await page.locator('.wb-demand-prog-row').first().waitFor();
        await enableOnlyJavaFastStrategy(page);

        await page
          .locator('.studio-right-foot')
          .getByRole('button', { name: '开始排版', exact: true })
          .click();
        await page.locator('.scheme-slot.on').waitFor({ timeout: 25000 });
        await waitFrames(page, 4);

        // 校验 4 层 Konva 舞台及独立屏幕标尺画布均可见
        const hostLocator = page.locator('.wb-board-konva-host');
        await hostLocator.waitFor();
        const hostBox = await hostLocator.boundingBox();
        assert.ok(hostBox && hostBox.width > 300 && hostBox.height > 200, '画布容器尺寸异常');
        assert.ok(await page.locator('.wb-board-ruler-canvas').isVisible(), '固定屏幕标尺画布应可见');

        const stageInfo = await page.evaluate(() => {
          const host = document.querySelector('.wb-board-konva-host');
          const stage = (globalThis.Konva?.stages || []).find((s) => s.container() === host);
          if (!stage) return null;
          const layers = stage.getLayers();
          const worldGroup = layers[0]?.getChildren?.()?.[0];
          return {
            layerCount: layers.length,
            worldX: worldGroup ? worldGroup.x() : 0,
            worldY: worldGroup ? worldGroup.y() : 0
          };
        });
        assert.ok(stageInfo && stageInfo.layerCount === 4, 'WorkbenchBoardCanvas 必须挂载 4 个独立 Konva Layer');

        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');

        // 3.1 滚轮缩放基线采样（32 步交替放大/缩小）
        const zoomBefore = (await page.locator('.wb-board-zoom-pill').innerText()).trim();
        let zoomPeakObserved = zoomBefore;
        const zoomSample = await measureCanvasInteraction(
          page,
          cdp,
          'React四层画布滚轮缩放',
          async () => {
            await page.mouse.move(hostBox.x + hostBox.width / 2, hostBox.y + hostBox.height / 2);
          },
          32,
          async (i) => {
            // 前 16 步放大，后 16 步缩小回落
            await page.mouse.wheel(0, i < 16 ? -120 : 120);
            if (i === 15) {
              zoomPeakObserved = (await page.locator('.wb-board-zoom-pill').innerText()).trim();
            }
          }
        );
        assert.notEqual(
          zoomPeakObserved,
          zoomBefore,
          `滚轮缩放未触发画布缩放比例变更（始终为 ${zoomBefore}）`
        );

        // 3.2 拖拽平移基线采样（32 步鼠标中键拖拽，稳定命中 WorkbenchBoardCanvas 相机平移链路）
        const worldPosBeforePan = await page.evaluate(() => {
          const host = document.querySelector('.wb-board-konva-host');
          const stage = (globalThis.Konva?.stages || []).find((s) => s.container() === host);
          const wg = stage?.getLayers()?.[0]?.getChildren?.()?.[0];
          return wg ? { x: wg.x(), y: wg.y() } : null;
        });
        const panStart = { x: hostBox.x + hostBox.width * 0.45, y: hostBox.y + hostBox.height * 0.45 };
        const panSample = await measureCanvasInteraction(
          page,
          cdp,
          'React四层画布拖拽平移',
          async () => {
            await page.mouse.move(panStart.x, panStart.y);
            await page.mouse.down({ button: 'middle' });
          },
          32,
          (i) => page.mouse.move(panStart.x + (i + 1) * 5, panStart.y + (i + 1) * 3)
        );
        await page.mouse.up({ button: 'middle' });
        await waitFrames(page, 2);

        const worldPosAfterPan = await page.evaluate(() => {
          const host = document.querySelector('.wb-board-konva-host');
          const stage = (globalThis.Konva?.stages || []).find((s) => s.container() === host);
          const wg = stage?.getLayers()?.[0]?.getChildren?.()?.[0];
          return wg ? { x: wg.x(), y: wg.y() } : null;
        });
        assert.ok(worldPosBeforePan && worldPosAfterPan, '无法读取 Konva worldGroup 相机偏移');
        const panDisplacement = Math.hypot(
          worldPosAfterPan.x - worldPosBeforePan.x,
          worldPosAfterPan.y - worldPosBeforePan.y
        );
        assert.ok(
          panDisplacement >= 20,
          `拖拽平移未产生预期相机位移（实际位移 ${panDisplacement.toFixed(1)} px）`
        );

        assert.ok(
          zoomSample.frameP95Ms <= PERF_P95_BUDGET_MS,
          `滚轮缩放 P95 帧耗时 ${zoomSample.frameP95Ms}ms 超过预算 ${PERF_P95_BUDGET_MS}ms`
        );
        assert.ok(
          panSample.frameP95Ms <= PERF_P95_BUDGET_MS,
          `拖拽平移 P95 帧耗时 ${panSample.frameP95Ms}ms 超过预算 ${PERF_P95_BUDGET_MS}ms`
        );

        perfMetrics.canvasLayers = stageInfo.layerCount;
        perfMetrics.pieceDemandCount = 80;
        perfMetrics.zoom = zoomSample;
        perfMetrics.pan = panSample;

        return {
          layerCount: stageInfo.layerCount,
          zoomBefore,
          zoomPeakObserved,
          panDisplacementPx: Number(panDisplacement.toFixed(1)),
          zoom: zoomSample,
          pan: panSample
        };
      }
    );

    await runStep('全链路无未捕获页面脚本异常且无原生 alert/confirm 弹窗', async () => {
      assert.deepEqual(pageErrors, [], `检测到页面异常: ${pageErrors.join(' | ')}`);
      assert.deepEqual(nativeDialogs, [], `检测到原生弹窗: ${nativeDialogs.join(' | ')}`);
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.success).length;
  const summary = {
    executed: results.length,
    passed: results.length - failed,
    failed,
    skipped: 0,
    perfMetrics,
    results
  };
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(summary, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
  if (failed > 0) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
