// End-to-end browser verification of the refactored 4-domain architecture and 3-stage cutting workflow.
// Runs strictly against an isolated service (port !== 8080) with temporary state.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'BASE_URL must be localhost');
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'Isolated non-8080 port required');

const api = async (path) => {
  const r = await fetch(base + path);
  assert.ok(r.ok, `GET ${path} failed: ${r.status}`);
  return r.json();
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  });
  const results = [];

  async function runStep(name, fn) {
    try {
      await fn();
      results.push({ name, success: true });
      console.log('PASS:', name);
    } catch (err) {
      results.push({ name, success: false, error: err.message });
      console.error('FAIL:', name, err.stack || err.message);
    }
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  const browseWrites = [];
  let allowWrites = false;

  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', async (res) => {
    if (res.status() >= 400) {
      const txt = await res.text().catch(() => '');
      console.error('HTTP_ERROR:', res.status(), res.url(), txt);
    }
  });
  page.on('request', (req) => {
    if (!allowWrites && req.method() !== 'GET') {
      browseWrites.push(`${req.method()} ${req.url()}`);
    }
  });

  try {
    await runStep('4-domain navigation structure & read-only route smoke check', async () => {
      await page.goto(base + '/app/#/workbench');
      await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();

      const catLabels = await page
        .locator('#nav .nav-group-label')
        .evaluateAll((els) => els.map((e) => e.textContent.trim()));
      assert.deepEqual(catLabels, ['需求管理', '搭切工作台', '结果管理', '库存管理', '示例场景']);

      // Ensure "多门幅工艺对比" is inside "示例场景" (moved out of workbench domain)
      await page.locator('#nav .nav-group-trigger', { hasText: '示例场景' }).click();
      const showcaseLinks = await page
        .locator('#nav-sub-showcase a')
        .evaluateAll((els) => els.map((e) => e.textContent.trim()));
      assert.ok(showcaseLinks.includes('多门幅工艺对比'), '多门幅工艺对比 should live under 示例场景');

      // Browse all primary routes without mutating backend state
      const routes = [
        ['demands', '需求管理'],
        ['clusters', '需求模板库'],
        ['workbench', '搭切工作台'],
        ['slitting', '搭切工作台'],
        ['results', '结果管理'],
        ['reconciliation', '复检补排与对账'],
        ['inventory', '库存'],
        ['inspection', '跑布验疵'],
        ['documents', '库存单据'],
        ['garment', '唛架幅宽试算'],
        ['showcase', '能力展示'],
        ['settings', '设置']
      ];

      for (const [r, h1Text] of routes) {
        await page.goto(base + '/app/#/' + r);
        await page.getByRole('heading', { name: h1Text, exact: true, level: 1 }).waitFor();
        assert.equal(await page.locator('#nav [aria-current="page"]').count(), 1, `Active nav count on #/${r}`);
        for (const [w, h] of [[1366, 768], [1920, 1080]]) {
          await page.setViewportSize({ width: w, height: h });
          const noOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1
          );
          assert.ok(noOverflow, `Horizontal overflow detected on #/${r} at ${w}x${h}`);
        }
      }
      await page.setViewportSize({ width: 1440, height: 860 });
      assert.deepEqual(browseWrites, [], 'Browsing pages must not issue non-GET writes');
      assert.deepEqual(pageErrors, [], 'Zero pageerror during navigation');
    });

    allowWrites = true;
    let createdTaskId = null;
    let confirmedSchemeId = null;
    let autoBoundRollId = null;

    await runStep('Demand Pool creation -> Workbench 3-stage solve -> Confirm & deduct openQty', async () => {
      await page.goto(base + '/app/#/demands');
      await page.getByRole('heading', { name: '需求管理', exact: true, level: 1 }).waitFor();

      await page.getByRole('button', { name: '＋ 新建需求族' }).click();
      await page.locator('dialog[open]').waitFor();
      await page.locator('#dp-name').fill('E2E-卫衣测试需求族');
      await page.locator('dialog[open] button[type="submit"]').click();

      // Wait for row to appear in demand pool
      await page.locator('tr', { hasText: 'E2E-卫衣测试需求族' }).first().waitFor();
      const poolBefore = await api('/api/v2/demand-pool');
      const familyBefore = poolBefore.find((f) => f.name === 'E2E-卫衣测试需求族');
      assert.ok(familyBefore, 'Demand family persisted in /api/v2/demand-pool');
      assert.equal(familyBefore.openTotal, 20);
      createdTaskId = familyBefore.id;

      // Jump to Cutting Workbench from Demand Pool
      await page
        .locator('tr', { hasText: 'E2E-卫衣测试需求族' })
        .getByRole('button', { name: '去搭切排程 →' })
        .click();
      await page.waitForURL('**/#/workbench');
      await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();

      // Default Virtual New Mother Roll must be active, and solve button must live at bottom-right (.studio-right-foot)
      const defaultVirtualPressed = await page
        .getByRole('button', { name: '默认新母卷', exact: true })
        .getAttribute('aria-pressed');
      assert.equal(defaultVirtualPressed, 'true', 'Virtual new mother roll is default');
      assert.equal(await page.locator('.studio-top-bar .studio-solve-btn').count(), 0, 'Solve CTA removed from top bar');
      assert.equal(await page.locator('.studio-right-foot .studio-solve-btn').count(), 1, 'Solve CTA pinned at bottom-right');

      // Left column shows per-item completion progress rows with mini progress bars
      assert.equal(await page.locator('.wb-demand-prog-row').count(), 2, 'All demand items shown with progress bars');
      assert.equal(await page.locator('.wb-demand-prog-row .wb-mini-prog').count(), 2, 'Each item has a mini progress bar');

      // Open "本次具体需求概览" sheet and verify cutting breakdown table
      await page.getByRole('button', { name: '具体需求概览', exact: true }).click();
      await page.locator('dialog[open] .wb-overview-kpis').waitFor();
      assert.ok((await page.locator('dialog[open]').innerText()).includes('逐项具体需求切制明细'));
      await page.locator('dialog[open] .native-modal-head button').click();

      // Select fast deterministic Java heuristic strategy so solve completes in <1s
      const strategyDetails = page.locator('details.studio-accordion', { hasText: '并行求解算法引擎' });
      const checkboxes = strategyDetails.locator('input[type="checkbox"]');
      const cbCount = await checkboxes.count();
      for (let i = 0; i < cbCount; i++) {
        const labelText = await strategyDetails.locator('.choice-card').nth(i).innerText();
        const shouldCheck = labelText.includes('Java 天际线');
        const checked = await checkboxes.nth(i).isChecked();
        if (checked !== shouldCheck) {
          await checkboxes.nth(i).click();
        }
      }

      await page.locator('.studio-right-foot').getByRole('button', { name: /启动并行搭切/ }).click();
      await page.locator('.scheme-slot.on').waitFor({ timeout: 15000 });
      assert.ok(await page.locator('canvas').first().isVisible(), 'CAD canvas rendered');

      // Confirm selected scheme -> zero re-solve & immediate demand deduction + left progress bars update to done!
      await page.getByRole('button', { name: '选定此方案（扣减需求并保存结果）' }).click();
      await page.getByRole('link', { name: '去结果管理查看/导出' }).waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.wb-demand-prog-row.is-done').count(), 2, 'All items stay visible and turn done on left progress list');

      const poolAfterConfirm = await api('/api/v2/demand-pool');
      const familyAfterConfirm = poolAfterConfirm.find((f) => f.id === createdTaskId);
      assert.equal(familyAfterConfirm.openTotal, 0, 'openTotal immediately deducted to 0');
      assert.equal(familyAfterConfirm.plannedTotal, 20, 'plannedTotal reserved as 20');
    });

    await runStep('Results Center: auto-bind real mother roll -> ticket preview -> complete accounting', async () => {
      await page.getByRole('link', { name: '去结果管理查看/导出' }).click();
      await page.waitForURL('**/#/results/**');
      await page.getByRole('heading', { name: '结果管理', exact: true, level: 1 }).waitFor();

      const schemes = await api('/api/v2/schemes');
      const myScheme = schemes.find((e) => e.scheme.taskId === createdTaskId)?.scheme;
      assert.ok(myScheme, 'Confirmed scheme present in /api/v2/schemes');
      assert.equal(myScheme.state, 'AWAITING_ROLL');
      confirmedSchemeId = myScheme.id;

      // Test Cut Ticket print modal preview
      await page.getByRole('button', { name: '打印 A4 车间派工裁切单' }).click();
      await page.locator('.print-ticket-sheet').waitFor();
      assert.ok((await page.locator('.print-ticket-sheet').innerText()).includes(confirmedSchemeId));
      await page.locator('dialog[open] .native-modal-head button').click();

      // Bind Virtual Mother Roll -> One-click auto-create & bind physical roll
      await page.getByRole('button', { name: '＋ 按方案规格一键建卷并绑定' }).click();

      // Wait for state badge to become 已锁实卷待切
      await page.locator('.tag', { hasText: '已锁实卷待切' }).first().waitFor({ timeout: 10000 });
      const boundDetail = await api('/api/v2/schemes/' + encodeURIComponent(confirmedSchemeId));
      assert.equal(boundDetail.scheme.state, 'READY_TO_CUT');
      assert.ok(boundDetail.scheme.rollId, 'Physical rollId bound');
      autoBoundRollId = boundDetail.scheme.rollId;

      // One-click complete accounting
      await page.getByRole('button', { name: '一键完工记账' }).click();
      await page.locator('.tag', { hasText: '已完工记账' }).first().waitFor({ timeout: 10000 });

      const poolAfterComplete = await api('/api/v2/demand-pool');
      const familyAfterComplete = poolAfterComplete.find((f) => f.id === createdTaskId);
      assert.equal(familyAfterComplete.completedTotal, 20, 'completedTotal updated to 20');
      assert.equal(familyAfterComplete.plannedTotal, 0, 'plannedTotal cleared to 0');
    });

    await runStep('Inventory Management: view mother roll spatial cut-zone map ("看已切割区域")', async () => {
      const spatial = await api('/api/rolls/' + encodeURIComponent(autoBoundRollId) + '/spatial-map');
      assert.ok(spatial.cutZones.length >= 1, 'Spatial map contains cut zone');
      assert.ok(spatial.cutZones[0].lengthMm > 0, 'Cut zone has positive length');

      await page.goto(base + '/app/#/inventory?roll=' + encodeURIComponent(autoBoundRollId));
      await page.getByRole('heading', { name: '库存', exact: true, level: 1 }).waitFor();
      await page.locator('.roll-spatial-panel').waitFor({ timeout: 10000 });
      await page.locator('.spatial-seg.cut').first().waitFor();
      assert.ok(await page.locator('.inv-canvas-box canvas').first().isVisible(), 'Roll preview canvas visible');
      assert.deepEqual(pageErrors, [], 'Zero pageerror across full lifecycle');
    });

    await runStep('Settings Modal: left vertical tabs, right settings panes, preset & persistence without leaving current route', async () => {
      const urlBeforeOpen = page.url();
      await page.locator('#nav .nav-settings-link').click();
      const dialog = page.locator('dialog#studio-settings-dialog[open]');
      await dialog.waitFor();
      assert.equal(page.url(), urlBeforeOpen, 'Opening settings modal must not navigate away from active page');

      const tabLabels = await dialog
        .locator('[role="tab"] strong')
        .evaluateAll((els) => els.map((e) => e.textContent.trim()));
      assert.deepEqual(tabLabels, [
        '画布与常规',
        '裁切工艺与预设',
        '料头与余料策略',
        '求解引擎与配额',
        '导出与系统接入'
      ]);

      // Switch through each left tab and verify right panel switches cleanly
      await dialog.locator('#settings-tab-craft').click();
      await dialog.locator('#cfg-studio-margin').waitFor();
      await dialog.locator('.settings-preset-card', { hasText: '板材 · 素色板' }).click();
      assert.equal(await dialog.locator('#cfg-studio-margin').inputValue(), '30');

      await dialog.locator('#settings-tab-remnant').click();
      await dialog.locator('#s-width').waitFor();
      assert.equal(await dialog.locator('#s-width').inputValue(), '300');
      await dialog.locator('#s-width').fill('260');

      await dialog.locator('#settings-tab-engines').click();
      await dialog.locator('#engine-rows tr').first().waitFor();
      assert.ok((await dialog.locator('#engine-rows tr').count()) >= 1);

      await dialog.locator('#settings-tab-integration').click();
      await dialog.locator('#cfg-export-prefix').fill('WorkshopA');

      // Save and verify persistence + clean close
      await dialog.getByRole('button', { name: '保存并应用', exact: true }).click();
      assert.equal(await page.locator('dialog#studio-settings-dialog[open]').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('cam_min_rem_w')), '260');
      assert.equal(
        await page.evaluate(() => localStorage.getItem('cutplan.studio.exportPrefix')),
        'WorkshopA'
      );

      // Topbar engine status pill opens directly to engines tab and Escape dismisses
      await page.locator('#engine-status').click();
      await dialog.waitFor();
      assert.equal(
        await dialog.locator('#settings-tab-engines').getAttribute('aria-selected'),
        'true'
      );
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog#studio-settings-dialog[open]').count(), 0);
      assert.deepEqual(pageErrors, [], 'Zero pageerror in settings modal interactions');
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.success).length;
  console.log(
    JSON.stringify(
      { executed: results.length, passed: results.length - failed, failed, skipped: 0, results },
      null,
      2
    )
  );
  if (failed > 0) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
