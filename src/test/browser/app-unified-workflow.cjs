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

const apiPost = async (path, body) => {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.ok(r.ok, `POST ${path} failed: ${r.status}`);
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
  const nativeDialogs = [];
  const browseWrites = [];
  let allowWrites = false;

  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', async (d) => {
    nativeDialogs.push(`${d.type()}: ${d.message()}`);
    await d.dismiss();
  });
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
      assert.deepEqual(catLabels, ['订单需求', '排料工作台', '产出与核算', '材料库存', '工艺试验', '系统安全']);

      // Ensure "服装唛架" is inside "工艺试验" (moved out of workbench domain)
      await page.locator('#nav .nav-group-trigger', { hasText: '工艺试验' }).click();
      const showcaseLinks = await page
        .locator('#nav-sub-showcase a')
        .evaluateAll((els) => els.map((e) => e.textContent.trim()));
      assert.ok(showcaseLinks.includes('服装唛架'), '服装唛架 should live under 工艺试验');

      // Browse all primary routes without mutating backend state
      const routes = [
        ['demands', '需求管理'],
        ['demand-library', '需求库'],
        ['clusters', '需求模板库'],
        ['workbench', '搭切工作台'],
        ['slitting', '搭切工作台'],
        ['results', '结果管理'],
        ['reconciliation', '复检补排与对账'],
        ['cost-analytics', '成本与备料'],
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

      // Left dropzone + pre-scheduling config + right real-time result preview
      await page.locator('.dc-dropzone').waitFor();
      await page.locator('.dc-gallery-grid .dc-piece-card').first().waitFor();
      await page.locator('#dp-name').fill('E2E-卫衣测试需求族');

      // Pre-select 1800mm mother roll width on DemandCreatePage and launch directly into Workbench
      await page.locator('.dc-width-chips button', { hasText: '1800mm' }).click();
      await page.locator('.dc-create-form button[type="submit"]').click();
      await page.waitForURL('**/#/workbench');
      await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();

      // Confirm persisted family in backend and verify standalone Demand Library (#/demand-library) filters
      const poolBefore = await api('/api/v2/demand-pool');
      const familyBefore = poolBefore.find((f) => f.name === 'E2E-卫衣测试需求族');
      assert.ok(familyBefore, 'Demand family persisted in /api/v2/demand-pool');
      assert.equal(familyBefore.openTotal, 20);
      createdTaskId = familyBefore.id;

      // Verify pre-configured 1800mm width was carried into Workbench
      const carriedWidth = await page
        .locator('.studio-canvas-inputs input[type="number"]')
        .first()
        .inputValue();
      assert.equal(carriedWidth, '1800', 'Pre-configured 1800mm mother roll width carried into workbench');

      // Also verify standalone Demand Library page with dimension + status dropdown filters
      await page.goto(base + '/app/#/demand-library');
      await page.getByRole('heading', { name: '需求库', exact: true, level: 1 }).waitFor();
      await page.locator('tr', { hasText: 'E2E-卫衣测试需求族' }).first().waitFor();
      const dimSelect = page.locator('select[aria-label="按维度筛选"]');
      const statusSelect = page.locator('select[aria-label="按状态筛选"]');
      await dimSelect.selectOption('SLITTING_1D');
      assert.equal(
        await page.locator('tr', { hasText: 'E2E-卫衣测试需求族' }).count(),
        0,
        '2D rect family filtered out when dimension=SLITTING_1D'
      );
      await dimSelect.selectOption('RECT_2D');
      await statusSelect.selectOption('OPEN_ONLY');
      await page.locator('tr', { hasText: 'E2E-卫衣测试需求族' }).first().waitFor();
      await dimSelect.selectOption('ALL');
      await statusSelect.selectOption('ALL');

      // Jump back to Cutting Workbench from Demand Library
      await page
        .locator('tr', { hasText: 'E2E-卫衣测试需求族' })
        .getByRole('button', { name: '去搭切排程 →' })
        .click();
      await page.waitForURL('**/#/workbench');
      await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();

      // Verify default clean workbench state:
      // 1) Workflow guide stepper hidden by default
      // 2) Right rail no longer contains "并行求解算法引擎"
      // 3) Bottom-right primary CTA is "开始排版"
      assert.equal(
        await page.locator('.stage-stepper').count(),
        0,
        'Workflow guide stepper must be hidden by default'
      );
      const rightPaneText = await page.locator('.studio-right').innerText();
      assert.ok(
        !rightPaneText.includes('并行求解算法引擎'),
        'Right rail must not contain 并行求解算法引擎'
      );
      const defaultVirtualPressed = await page
        .getByRole('button', { name: '默认新母卷', exact: true })
        .getAttribute('aria-pressed');
      assert.equal(defaultVirtualPressed, 'true', 'Virtual new mother roll is default');
      assert.equal(await page.locator('.studio-top-bar .studio-solve-btn').count(), 0, 'Solve CTA removed from top bar');
      assert.equal(await page.locator('.studio-right-foot .studio-solve-btn').count(), 1, 'Solve CTA pinned at bottom-right');
      assert.equal(
        (await page.locator('.studio-right-foot .studio-solve-btn').innerText()).trim(),
        '开始排版',
        'Bottom-right primary CTA label must be 开始排版'
      );

      // Left column shows per-item completion progress rows with mini progress bars
      assert.equal(await page.locator('.wb-demand-prog-row').count(), 2, 'All demand items shown with progress bars');
      assert.equal(await page.locator('.wb-demand-prog-row .wb-mini-prog').count(), 2, 'Each item has a mini progress bar');

      // Open "本次具体需求概览" sheet and verify cutting breakdown table
      await page.getByRole('button', { name: '具体需求概览', exact: true }).click();
      await page.locator('dialog[open] .wb-overview-kpis').waitFor();
      assert.ok((await page.locator('dialog[open]').innerText()).includes('逐项具体需求切制明细'));
      await page.locator('dialog[open] .native-modal-head button').click();

      // Open Settings -> "求解引擎与配额" via bottom-left #engine-status and enable only JAVA_FAST
      await page.locator('#engine-status').click();
      const settingsDialog = page.locator('dialog#studio-settings-dialog[open]');
      await settingsDialog.waitFor();
      assert.equal(
        await settingsDialog.locator('#settings-tab-engines').getAttribute('aria-selected'),
        'true',
        '#engine-status should open directly to engines tab'
      );
      const javaFastInput = settingsDialog.locator('#cfg-strategy-JAVA_FAST');
      await javaFastInput.waitFor();
      if (!(await javaFastInput.isChecked())) {
        await javaFastInput.click();
      }
      const strategyRows = settingsDialog.locator('[data-strategy-id]');
      const strategyCount = await strategyRows.count();
      assert.equal(strategyCount, 5, 'Settings engines tab should list all 5 2D strategies');
      for (let i = 0; i < strategyCount; i++) {
        const row = strategyRows.nth(i);
        const sid = await row.getAttribute('data-strategy-id');
        const cb = row.locator('input[type="checkbox"]');
        if (sid !== 'JAVA_FAST' && (await cb.isChecked())) {
          await cb.click();
        }
      }
      await settingsDialog.getByRole('button', { name: '保存并应用', exact: true }).click();
      assert.equal(await page.locator('dialog#studio-settings-dialog[open]').count(), 0);
      await page.waitForFunction(() => {
        const el = document.querySelector('#engine-status');
        return Boolean(el && el.textContent && el.textContent.includes('1算法'));
      });
      assert.ok(
        (await page.locator('#engine-status').innerText()).includes('1算法'),
        '#engine-status must reflect 1 enabled algorithm after saving settings'
      );

      // Click bottom-right "开始排版"
      await page.locator('.studio-right-foot').getByRole('button', { name: '开始排版', exact: true }).click();
      await page.locator('.scheme-slot.on').waitFor({ timeout: 15000 });
      assert.ok(await page.locator('canvas').first().isVisible(), 'CAD canvas rendered');

      // Confirm selected scheme -> zero re-solve & immediate demand deduction + left progress bars update to done!
      await page.getByRole('button', { name: '选定此方案' }).click();
      await page.getByRole('link', { name: '查看结果' }).waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.wb-demand-prog-row.is-done').count(), 2, 'All items stay visible and turn done on left progress list');

      const poolAfterConfirm = await api('/api/v2/demand-pool');
      const familyAfterConfirm = poolAfterConfirm.find((f) => f.id === createdTaskId);
      assert.equal(familyAfterConfirm.openTotal, 0, 'openTotal immediately deducted to 0');
      assert.equal(familyAfterConfirm.plannedTotal, 20, 'plannedTotal reserved as 20');
    });

    await runStep('Results Center: auto-bind real mother roll -> ticket preview -> complete accounting', async () => {
      await page.getByRole('link', { name: '查看结果' }).click();
      await page.waitForURL('**/#/results/**');
      await page.getByRole('heading', { name: '结果管理', exact: true, level: 1 }).waitFor();

      const schemes = await api('/api/v2/schemes');
      const myScheme = schemes.find((e) => e.scheme.taskId === createdTaskId)?.scheme;
      assert.ok(myScheme, 'Confirmed scheme present in /api/v2/schemes');
      assert.equal(myScheme.state, 'AWAITING_ROLL');
      confirmedSchemeId = myScheme.id;

      // Test Cut Ticket print modal preview (verify full table, work order no, SVG diagram annotations)
      await page.getByRole('button', { name: '打印 A4 车间派工裁切单' }).click();
      await page.locator('.print-ticket-sheet').waitFor();
      const ticketText = await page.locator('.print-ticket-sheet').innerText();
      assert.ok(ticketText.includes(`WO-${confirmedSchemeId}`), 'Cut ticket must display work order number');
      assert.ok(
        await page.locator('.print-ticket-sheet .ticket-diagram svg').isVisible(),
        'Cut ticket SVG diagram must render'
      );
      const renderedTicketRows = await page
        .locator('.print-ticket-sheet .mp-table-scroll tbody tr')
        .count();
      assert.equal(
        renderedTicketRows,
        myScheme.placedCount,
        'Cut ticket must render all placed pieces without 25-row truncation'
      );
      await page.locator('dialog[open] .native-modal-head button').click();

      // Bind Virtual Mother Roll -> Create pending physical roll (P0-8: must NOT auto-pass inspection) -> Inspect & PASS -> Bind
      await page.getByRole('button', { name: '＋ 按方案规格新建待检母卷' }).click();
      const pendingHint = page.locator('.mp-res-pending-roll-hint');
      await pendingHint.waitFor({ timeout: 10000 });
      const createdPendingRollId = await pendingHint.getAttribute('data-pending-roll-id');
      assert.ok(createdPendingRollId, 'Created pending rollId must be displayed for inspection release');

      // Verify scheme remains AWAITING_ROLL and newly created roll is PENDING without inspector
      const pendingDetail = await api('/api/v2/schemes/' + encodeURIComponent(confirmedSchemeId));
      assert.equal(pendingDetail.scheme.state, 'AWAITING_ROLL', 'Auto-created roll must not bypass inspection into READY_TO_CUT');
      assert.ok(!pendingDetail.scheme.rollId, 'Uninspected roll must not be locked onto scheme');
      const createdRoll = await api('/api/v2/rolls/' + encodeURIComponent(createdPendingRollId));
      assert.equal(createdRoll.inspectionStatus, 'PENDING', 'Auto-created roll must default to PENDING');
      assert.equal(createdRoll.inspector || '', '', 'Auto-created roll must not forge an inspector');

      // Complete real inspection release on the pending roll, refresh Results Center, then bind it
      await apiPost('/api/v2/rolls', {
        ...createdRoll,
        inspectionStatus: 'PASSED',
        inspector: 'E2E验布员'
      });
      await page.getByRole('button', { name: '刷新列表' }).click();
      const rollSelect = page.locator('select[aria-label="选择在库合格母卷"]');
      await rollSelect.waitFor({ timeout: 10000 });
      await rollSelect.selectOption(createdPendingRollId);
      await page.getByRole('button', { name: '绑定所选在库母卷并校验疵点' }).click();

      // Wait for state badge to become 已锁实卷待切
      await page.locator('.tag', { hasText: '已锁实卷待切' }).first().waitFor({ timeout: 10000 });
      const boundDetail = await api('/api/v2/schemes/' + encodeURIComponent(confirmedSchemeId));
      assert.equal(boundDetail.scheme.state, 'READY_TO_CUT');
      assert.equal(boundDetail.scheme.rollId, createdPendingRollId, 'Physical rollId bound after inspection pass');
      autoBoundRollId = boundDetail.scheme.rollId;

      // One-click complete accounting now requires explicit ModalDialog summary confirmation
      await page.getByRole('button', { name: '一键完工记账' }).click();
      const confirmDialog = page.locator('dialog[open]', { hasText: '确认一键完工记账' });
      await confirmDialog.waitFor();
      const confirmText = await confirmDialog.innerText();
      assert.ok(confirmText.includes(autoBoundRollId), 'Confirmation modal must list bound rollId');
      assert.ok(confirmText.includes(String(myScheme.placedCount)), 'Confirmation modal must list expected qualified pieces');
      await confirmDialog.getByRole('button', { name: '确认一键完工记账' }).click();
      await page.locator('.tag', { hasText: '已完工记账' }).first().waitFor({ timeout: 10000 });
      assert.deepEqual(nativeDialogs, [], 'Workflow must never invoke native window.confirm/alert');

      const poolAfterComplete = await api('/api/v2/demand-pool');
      const familyAfterComplete = poolAfterComplete.find((f) => f.id === createdTaskId);
      assert.equal(familyAfterComplete.completedTotal, 20, 'completedTotal updated to 20');
      assert.equal(familyAfterComplete.plannedTotal, 0, 'plannedTotal cleared to 0');
    });

    await runStep('Inventory Management: view mother roll spatial cut-zone map ("看已切割区域")', async () => {
      const spatial = await api('/api/v2/rolls/' + encodeURIComponent(autoBoundRollId) + '/spatial-map');
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

      // Tab 1: verify #cfg-show-workflow-guide switch is readable & toggleable
      const workflowGuideSwitch = dialog.locator('#cfg-show-workflow-guide');
      await workflowGuideSwitch.waitFor();
      assert.equal(
        await workflowGuideSwitch.isChecked(),
        false,
        '#cfg-show-workflow-guide must default to off'
      );
      await workflowGuideSwitch.click();
      assert.equal(
        await workflowGuideSwitch.isChecked(),
        true,
        '#cfg-show-workflow-guide must toggle to on'
      );

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
      assert.equal(
        await page.evaluate(() => localStorage.getItem('cutplan.studio.showWorkflowGuide')),
        '1'
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
