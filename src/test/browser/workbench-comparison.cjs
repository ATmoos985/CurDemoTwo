// 在独立免登录实例上运行，启用 local-ai 时设置 COMPARISON_TEST_SOURCE=LOCAL_MODEL。
// BASE_URL=http://127.0.0.1:18095 node --test src/test/browser/workbench-comparison.cjs
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');

assert.ok(process.env.BASE_URL, '必须指定隔离 Spring 服务的 BASE_URL');
const base = new URL(process.env.BASE_URL);
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)
  && base.port && base.port !== '8080' && base.pathname === '/' && !base.username && !base.password
  && !base.search && !base.hash, '仅可连接独立的非 8080 本地回环服务');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pieceName = '前幅大裁片';
const expectedSource = process.env.COMPARISON_TEST_SOURCE || 'RULES';
assert.ok(['LOCAL_MODEL', 'RULES'].includes(expectedSource), '请选择要实际验证的答复来源');
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
});
after(async () => { await browser?.close(); });

async function createFamily(bedLengthMm, pieceLengthMm) {
  const response = await fetch(new URL('/api/v2/demand-pool', base), {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '候选比较验收-' + randomUUID(), materialModel: '比较样布', dimension: 'RECT_2D',
      bedLengthMm, trimStartMm: 0, pieceGapMm: 0,
      demands: [{ id: 1, name: pieceName, width: 900, length: pieceLengthMm, quantity: 3, allowRotation: false }]
    })
  });
  assert.ok(response.ok, '建立测试工单 ' + response.status + ' ' + (response.ok ? '' : await response.text()));
  const family = await response.json();
  assert.ok(family.id);
  return family.id;
}

async function enableStrategies(page) {
  await page.locator('#engine-status').click();
  const settings = page.locator('#studio-settings-dialog[open]');
  const wanted = ['JAVA_FAST', 'DN_FIXED'];
  for (const id of wanted) await settings.locator('#cfg-strategy-' + id).check();
  for (const row of await settings.locator('[data-strategy-id]').all()) {
    if (!wanted.includes(await row.getAttribute('data-strategy-id'))) await row.locator('input[type="checkbox"]').uncheck();
  }
  await settings.getByRole('button', { name: '保存并应用' }).click();
  await settings.waitFor({ state: 'hidden' });
}

async function responseFor(page, method, path, action) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname === path,
      { timeout: expectedSource === 'LOCAL_MODEL' && path.endsWith('/comparison-questions') ? 90000 : 15000 }),
    action()
  ]);
  assert.equal(response.status(), 200, method + ' ' + path + ' ' + (response.ok() ? '' : await response.text()));
  return response;
}

async function checkDrawing(page, dialog, prefix, label, side) {
  const response = await responseFor(page, 'GET', prefix + '/results/' + encodeURIComponent(side.resultId),
    () => dialog.getByRole('button', { name: '查看 ' + label + ' 原图' }).click());
  const archive = await response.json();
  assert.equal(archive.id, side.resultId);
  assert.ok(archive.inputHash);
  assert.equal(archive.inputHash, side.inputHash);
  const drawing = dialog.getByRole('img', { name: new RegExp('方案 ' + label + '.*原始裁片排布') });
  await drawing.waitFor();
  const geometries = [...archive.layout.placements, ...(archive.marker?.gapFillPlacements || [])];
  const rendered = await drawing.locator('.comparison-piece').evaluateAll(paths =>
    paths.map(p => ({ translation: p.getAttribute('transform'), title: p.querySelector('title').textContent })));
  assert.equal(rendered.length, geometries.length);
  if (!geometries.length) await dialog.getByText('这份归档没有排入裁片，图中显示空的加工区。').waitFor();
  geometries.forEach((p, i) => {
    assert.equal(rendered[i].translation, 'translate(' + p.x + ' ' + p.y + ')');
    assert.ok(rendered[i].title.includes(p.name));
  });
  await dialog.getByRole('button', { name: '← 返回对比表' }).click();
  await dialog.getByRole('table').waitFor();
  assert.ok((await dialog.getByRole('table').innerText()).includes(side.resultId));
}

for (const scenario of [
  { label: '已齐套', length: 1600, pieceLength: 400, placed: 3 },
  { label: '缺件', length: 500, pieceLength: 400, placed: 1 },
  { label: '全部缺件', length: 500, pieceLength: 600, placed: 0 }
]) {
  test('真实二维工单 · ' + scenario.label + ' · 双选、逐项核对、用布判断、两张原图、归档追问', async () => {
    const taskId = await createFamily(scenario.length, scenario.pieceLength);
    const prefix = '/api/v2/workbench/tasks/' + encodeURIComponent(taskId);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    const writes = [];
    const httpFailures = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', r => { if (r.status() >= 400) httpFailures.push(r.status() + ' ' + new URL(r.url()).pathname); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(r.method() + ' ' + new URL(r.url()).pathname); });
    try {
      await page.goto(new URL('/app/#/workbench/' + encodeURIComponent(taskId), base).href);
      await page.locator('.wb-demand-prog-row').filter({ hasText: pieceName }).first().waitFor();
      await enableStrategies(page);
      await page.getByRole('radio', { name: '定长装满', exact: true }).click();
      await page.getByRole('button', { name: '1220', exact: true }).click();
      const length = page.locator('.studio-canvas-inputs label').filter({ hasText: '版长 L' }).locator('input');
      await length.fill(String(scenario.length));
      await length.press('Tab');
      await page.locator('.studio-right-foot .studio-solve-btn').click();
      if (scenario.placed) await page.locator('.scheme-slot').nth(1).waitFor({ timeout: 90000 });
      else await page.getByText('本轮未排入裁片，可查看归档结果').waitFor({ timeout: 90000 });
      await page.getByRole('button', { name: '比较方案', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '比较候选方案' });
      const a = dialog.getByLabel('方案 A', { exact: true });
      const b = dialog.getByLabel('方案 B', { exact: true });
      const ids = [await a.inputValue(), await b.inputValue()];
      assert.ok(ids.every(Boolean) && ids[0] !== ids[1], '两个不同的归档候选可用');
      await b.selectOption('');
      await a.selectOption(ids[1]);
      await b.selectOption(ids[0]);
      const initialWrites = writes.length;
      const response = await responseFor(page, 'GET', prefix + '/result-comparison',
        () => dialog.getByRole('button', { name: '比较这两套' }).click());
      const report = await response.json();
      assert.equal(report.taskId, taskId);
      assert.notEqual(report.left.resultId, report.right.resultId);
      const query = new URL(response.url()).searchParams;
      assert.equal(query.get('leftId'), report.left.resultId);
      assert.equal(query.get('rightId'), report.right.resultId);
      const table = dialog.getByRole('table', { name: '候选排料方案逐项对比' });
      await table.waitFor();
      const missing = 3 - scenario.placed;
      for (const [index, side] of [report.left, report.right].entries()) {
        assert.deepEqual([side.requested, side.placed, side.unplaced], [3, scenario.placed, missing]);
        assert.deepEqual(side.demands.map(d => [d.name, d.requested, d.placed, d.unplaced]), [[pieceName, 3, scenario.placed, missing]]);
        const cell = table.getByRole('row', { name: /需求履约/ }).getByRole('cell').nth(index);
        assert.ok((await cell.innerText()).includes('应排 3 件 · 已排 ' + scenario.placed + ' 件 · 缺 ' + missing + ' 件'));
        await cell.getByText('逐规格核对', { exact: true }).click();
        assert.ok((await cell.innerText()).includes(pieceName + ' · 应排 3 · 已排 ' + scenario.placed + ' · 缺 ' + missing + ' 件'));
      }
      const verdict = dialog.getByRole('region', { name: '用料比较结论' });
      assert.equal(report.lengthComparison.status, missing ? 'INCOMPLETE' : 'COMPARABLE');
      assert.equal(report.lengthComparison.savedLengthMm, missing ? null : 0);
      assert.match(await verdict.getByRole('heading').innerText(), missing ? /不能比较哪套更省布/ : /预计占用版长相同/);
      assert.ok(report.lengthComparison.reason && (await verdict.innerText()).includes(report.lengthComparison.reason));
      const metric = table.getByText('计算口径', { exact: true }).first();
      await metric.click();
      assert.match(await metric.locator('..').innerText(), /分子.*mm².*分母.*mm²/);
      await dialog.getByText('追问这两个方案', { exact: true }).click();
      const answerArea = dialog.locator('.wb-comparison-questions [role="status"]');
      async function ask(question) {
        await dialog.getByRole('textbox', { name: '关于齐套、缺件或省布的问题' }).fill(question);
        const qa = await responseFor(page, 'POST', prefix + '/comparison-questions',
          () => dialog.getByRole('button', { name: '提问', exact: true }).click());
        assert.deepEqual([qa.request().postDataJSON().leftId, qa.request().postDataJSON().rightId], [report.left.resultId, report.right.resultId]);
        const answer = await qa.json();
        assert.equal(answer.source, expectedSource);
        const label = expectedSource === 'RULES' ? '归档事实答复' : '本机模型识别问题 · 归档事实';
        await answerArea.getByText(label, { exact: true }).waitFor();
        for (const line of answer.lines) assert.ok((await answerArea.innerText()).includes(line));
        return answer;
      }
      const stock = await ask('两套各缺哪种裁片？');
      assert.ok(stock.lines.some(l => missing ? l.includes(pieceName) && l.includes('缺 ' + missing + ' 片') : l.includes('已齐套')));
      const answer = await ask('哪套预计能省多少布？');
      assert.ok(answer.lines.some(l => missing ? l.includes('无法判定哪套更省布') : l.includes('预计占用长度相同')));
      await checkDrawing(page, dialog, prefix, 'A', report.left);
      await checkDrawing(page, dialog, prefix, 'B', report.right);
      assert.ok(await answerArea.isVisible() && (await answerArea.innerText()).includes(answer.lines[0]), '从原图返回后保留答复');
      assert.deepEqual(writes.slice(initialWrites), Array(2).fill('POST ' + prefix + '/comparison-questions'));
      assert.deepEqual(errors, []);
      console.log(scenario.label + ' / 两案各 ' + scenario.placed + '/3 件 / ' + report.lengthComparison.status + ' / 原图 2 张 / ' + answer.source);
    } catch (error) {
      console.error({ httpFailures, writes, pageErrors: errors, screen: (await page.locator('body').innerText()).slice(-1800) });
      throw error;
    } finally {
      await context.close();
    }
  });
}
