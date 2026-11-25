// UI shell smoke checks use an isolated service and do not submit business commands.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'isolated service required');

const MODERN_ROUTES = [
  ['demands', '需求管理'],
  ['demand-library', '需求库'],
  ['clusters', '需求模板库'],
  ['workbench', '搭切工作台'],
  ['planning', '联合排产与自动分床'],
  ['results', '结果管理'],
  ['reconciliation', '复检补排与对账'],
  ['cost-analytics', '成本与备料分析'],
  ['inventory', '库存'],
  ['inspection', '跑布验疵'],
  ['documents', '库存单据'],
  ['garment', '唛架幅宽试算'],
  ['showcase', '能力展示'],
  ['settings', '设置']
];

const LEGACY_REDIRECTS = [
  ['tasks', '#/demand-library', '需求库'],
  ['task/new', '#/demands', '需求管理'],
  ['execution', '#/results', '结果管理'],
  ['quality', '#/reconciliation', '复检补排与对账'],
  ['analysis', '#/cost-analytics', '成本与备料分析']
];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  const writes = [];
  const results = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(r.url());
  });
  async function check(name, fn) {
    try {
      await fn();
      results.push({ name, success: true });
    } catch (e) {
      results.push({ name, success: false, error: e.message });
    }
  }
  try {
    for (const [route, heading] of MODERN_ROUTES) {
      await check('route loads: ' + route, async () => {
        await page.goto(base + '/app/#/' + route);
        await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
        assert.deepEqual(errors, []);
        assert.equal(await page.locator('nav [aria-current="page"]').count(), 1);
      });
    }

    for (const [legacyRoute, expectedHash, heading] of LEGACY_REDIRECTS) {
      await check('legacy route redirects: ' + legacyRoute + ' -> ' + expectedHash, async () => {
        await page.goto(base + '/app/#/' + legacyRoute);
        await page.waitForFunction((target) => location.hash === target, expectedHash);
        await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
        assert.deepEqual(errors, []);
      });
    }

    await check('demand library search and filter retain accessible controls and empty state', async () => {
      await page.goto(base + '/app/#/demand-library');
      const searchInput = page.getByRole('searchbox', { name: '搜索需求族' });
      await searchInput.waitFor();
      await searchInput.fill('no-match-ui-preview-20261125');
      await page.getByText('暂无匹配的需求记录', { exact: true }).waitFor();
      await searchInput.fill('');
      const statusSelect = page.getByLabel('按状态筛选');
      await statusSelect.selectOption('OPEN');
      assert.equal(await statusSelect.inputValue(), 'OPEN');
      await statusSelect.selectOption('ALL');
      assert.equal(await statusSelect.inputValue(), 'ALL');
    });

    await check('empty results center provides a working workbench link', async () => {
      await page.route('**/api/v2/schemes*', (r) =>
        r.fulfill({ contentType: 'application/json', body: '[]' })
      );
      await page.goto(base + '/app/#/results');
      await page.getByRole('link', { name: '前往搭切工作台 →', exact: true }).click();
      await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();
      await page.unroute('**/api/v2/schemes*');
    });

    await check('browsing has no business writes or script errors', async () => {
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.success).length;
  console.log(
    JSON.stringify({ executed: results.length, passed: results.length - failed, failed, skipped: 0, results }, null, 2)
  );
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
