import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBackoffMs, createSyncWorker, loadWorkerConfig } from '../sync-worker.mjs';

const TEST_TOKEN = 'test-integration-secret-token-0123456789abcdef';
const WMS_TOKEN = 'test-wms-webhook-bearer-token-9876543210';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 模拟严格遵循 IntegrationService.java 契约的后端 Outbox HTTP 服务。
 * 可选 options.rejectedTokenField 控制 GET /api/v2/integration-deliveries 对 REJECTED 项返回令牌的字段形态（默认不返回，兼容旧后端）。
 */
async function startMockOutboxServer(initialEvents, options = {}) {
  const { rejectedTokenField = null } = options;
  let acknowledgedThrough = 0;
  const attempts = [];
  const events = initialEvents.map((e, i) => ({
    id: e.id,
    sequence: i + 1,
    action: e.action || 'CUT_REPORT',
    occurredAt: Date.now(),
    changes: e.changes || []
  }));

  const lastAttemptFor = (eventId) => {
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      if (attempts[i].eventId === eventId) return attempts[i];
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      return sendJson(res, 401, { code: 'UNAUTHORIZED', message: '需要有效的集成服务凭据', retryable: false });
    }
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/v2/integration-deliveries') {
      const after = Number(url.searchParams.get('after') || 0);
      const limit = Number(url.searchParams.get('limit') || 20);
      const sliced = events.filter((ev) => ev.sequence > after).slice(0, limit);
      const items = sliced.map((ev) => {
        const a = lastAttemptFor(ev.id);
        const item = {
          eventId: ev.id,
          sequence: ev.sequence,
          state: a ? a.state : 'PENDING',
          attempt: a ? a.number : 0,
          expiresAt: a ? a.expiresAt : 0,
          externalReceipt: a ? a.externalReceipt : null,
          reason: a ? a.reason : null
        };
        if (a && a.state === 'REJECTED' && rejectedTokenField) {
          if (rejectedTokenField === 'attempt.token') {
            item.attempt = { number: a.number, token: a.token };
          } else {
            item[rejectedTokenField] = a.token;
          }
        }
        return item;
      });
      const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].sequence : after;
      return sendJson(res, 200, {
        consumer: 'external-inventory',
        acknowledgedThrough,
        items,
        nextCursor,
        hasMore: events.some((ev) => ev.sequence > nextCursor)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/v2/integration-deliveries/claims') {
      const body = JSON.parse(await readBody(req));
      if (!body.requestId) {
        return sendJson(res, 400, { code: 'INVALID_INPUT', message: '缺少 requestId', retryable: false });
      }
      if (acknowledgedThrough >= events.length) {
        return sendJson(res, 200, { consumer: 'external-inventory', state: 'EMPTY', attempt: null, event: null });
      }
      const event = events[acknowledgedThrough];
      const prev = lastAttemptFor(event.id);
      if (prev && prev.state === 'REJECTED') {
        if (body.retryOf !== prev.token) {
          return sendJson(res, 409, { code: 'DELIVERY_REJECTED', message: '需要显式 retryOf 重试', retryable: false });
        }
      } else if (body.retryOf != null) {
        return sendJson(res, 409, { code: 'STALE_ATTEMPT', message: '重试令牌不属于当前被拒绝的尝试', retryable: false });
      }
      const attempt = {
        requestId: body.requestId,
        retryOf: body.retryOf || null,
        eventId: event.id,
        eventSequence: event.sequence,
        number: prev ? prev.number + 1 : 1,
        token: randomUUID(),
        expiresAt: Date.now() + 60_000,
        state: 'LEASED',
        externalReceipt: null,
        reason: null
      };
      attempts.push(attempt);
      return sendJson(res, 200, {
        consumer: 'external-inventory',
        state: 'LEASED',
        attempt,
        event
      });
    }

    const ackMatch = url.pathname.match(/^\/api\/v2\/integration-deliveries\/([^/]+)\/acknowledgements$/);
    if (req.method === 'POST' && ackMatch) {
      const eventId = decodeURIComponent(ackMatch[1]);
      const body = JSON.parse(await readBody(req));
      const found = attempts.find((a) => a.token === body.token && a.eventId === eventId);
      if (!found) {
        return sendJson(res, 409, { code: 'STALE_ATTEMPT', message: '令牌不匹配', retryable: false });
      }
      if (body.status === 'ACCEPTED') {
        if (!body.externalReceipt || body.reason != null) {
          return sendJson(res, 400, { code: 'INVALID_INPUT', message: 'ACCEPTED 回执格式错误', retryable: false });
        }
        found.state = 'ACKNOWLEDGED';
        found.externalReceipt = body.externalReceipt;
        acknowledgedThrough = found.eventSequence;
      } else if (body.status === 'REJECTED') {
        if (!body.reason || body.externalReceipt != null) {
          return sendJson(res, 400, { code: 'INVALID_INPUT', message: 'REJECTED 回执格式错误', retryable: false });
        }
        found.state = 'REJECTED';
        found.reason = body.reason;
      } else {
        return sendJson(res, 400, { code: 'INVALID_INPUT', message: '未知状态', retryable: false });
      }
      return sendJson(res, 200, {
        eventId: found.eventId,
        sequence: found.eventSequence,
        state: found.state,
        attempt: found.number,
        expiresAt: found.expiresAt,
        externalReceipt: found.externalReceipt,
        reason: found.reason
      });
    }

    sendJson(res, 404, { code: 'NOT_FOUND', message: '未知路径', retryable: false });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    getState: () => ({ acknowledgedThrough, attempts: [...attempts] }),
    close: () => new Promise((r) => server.close(r))
  };
}

async function startMockWmsServer(handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const record = { headers: { ...req.headers }, body };
    received.push(record);
    await handler(record, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/wms/events`,
    received,
    close: () => new Promise((r) => server.close(r))
  };
}

test('loadWorkerConfig 强制校验集成令牌、URL 与退避参数', () => {
  assert.throws(() => loadWorkerConfig({ WMS_WEBHOOK_URL: 'http://127.0.0.1:9000/hook' }), /CUTTING_INTEGRATION_TOKEN/);
  assert.throws(() => loadWorkerConfig({ CUTTING_INTEGRATION_TOKEN: TEST_TOKEN }), /WMS_WEBHOOK_URL/);
  assert.throws(() => loadWorkerConfig({
    CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
    WMS_WEBHOOK_URL: 'ftp://127.0.0.1/hook'
  }), /http\/https/);
  assert.throws(() => loadWorkerConfig({
    CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
    WMS_WEBHOOK_URL: 'http://user:pass@127.0.0.1/hook'
  }), /明文凭据/);

  const cfg = loadWorkerConfig({
    CUTTING_API_URL: 'http://127.0.0.1:8080',
    CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
    WMS_WEBHOOK_URL: 'http://127.0.0.1:9999/wms',
    BASE_BACKOFF_MS: '500',
    MAX_BACKOFF_MS: '8000',
    LAG_ALERT_THRESHOLD: '3'
  });
  assert.equal(cfg.baseBackoffMs, 500);
  assert.equal(cfg.maxBackoffMs, 8000);
  assert.equal(cfg.lagAlertThreshold, 3);
  assert.equal(computeBackoffMs(1, 500, 8000), 500);
  assert.equal(computeBackoffMs(3, 500, 8000), 2000);
  assert.equal(computeBackoffMs(10, 500, 8000), 8000);
});

test('Outbox Worker 正常拉取、携带幂等头转发 WMS 并回执 ACCEPTED，队列清空返回 EMPTY', async () => {
  const outbox = await startMockOutboxServer([
    { id: 'evt-001', action: 'CUT_REPORT', changes: [{ aggregateType: 'ROLL', aggregateId: 'R-1' }] },
    { id: 'evt-002', action: 'INVENTORY_TRANSFER', changes: [{ aggregateType: 'TRANSFER', aggregateId: 'TR-1' }] }
  ]);
  const wms = await startMockWmsServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${WMS_TOKEN}`);
    sendJson(res, 200, { receiptId: `WMS-REC-${req.body.eventId}` });
  });
  const logs = [];

  try {
    const worker = createSyncWorker(
      loadWorkerConfig({
        CUTTING_API_URL: outbox.origin,
        CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
        WMS_WEBHOOK_URL: wms.url,
        WMS_WEBHOOK_TOKEN: WMS_TOKEN
      }),
      { logger: (entry) => logs.push(entry) }
    );

    const r1 = await worker.runOnce();
    assert.equal(r1.outcome, 'ACKNOWLEDGED');
    assert.equal(r1.eventId, 'evt-001');
    assert.equal(r1.externalReceipt, 'WMS-REC-evt-001');

    const r2 = await worker.runOnce();
    assert.equal(r2.outcome, 'ACKNOWLEDGED');
    assert.equal(r2.eventId, 'evt-002');

    const r3 = await worker.runOnce();
    assert.equal(r3.outcome, 'EMPTY');

    assert.equal(outbox.getState().acknowledgedThrough, 2);
    assert.equal(wms.received.length, 2);
    assert.equal(wms.received[0].headers['idempotency-key'], 'evt-001');
    assert.equal(wms.received[0].headers['x-cutting-event-id'], 'evt-001');
    assert.equal(wms.received[1].headers['x-cutting-event-sequence'], '2');
    assert.ok(logs.some((l) => l.code === 'OUTBOX_DELIVERY_ACKED' && l.eventId === 'evt-002'));
  } finally {
    await outbox.close();
    await wms.close();
  }
});

test('WMS 转发失败回执 REJECTED，按指数退避携带 retryOf 重试直至恢复成功', async () => {
  const outbox = await startMockOutboxServer([{ id: 'evt-retry-1', action: 'RECEIPT_IN' }]);
  let wmsAttempts = 0;
  const wms = await startMockWmsServer((req, res) => {
    wmsAttempts += 1;
    if (wmsAttempts <= 2) {
      return sendJson(res, 503, { message: '下游 WMS 维护中' });
    }
    sendJson(res, 200, { externalReceipt: 'WMS-RECOVERED-01' });
  });

  let fakeNow = 1_700_000_000_000;
  const logs = [];

  try {
    const worker = createSyncWorker(
      loadWorkerConfig({
        CUTTING_API_URL: outbox.origin,
        CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
        WMS_WEBHOOK_URL: wms.url,
        BASE_BACKOFF_MS: '500',
        MAX_BACKOFF_MS: '4000',
        MAX_RETRIES: '2'
      }),
      {
        now: () => fakeNow,
        logger: (entry) => logs.push(entry)
      }
    );

    // 第 1 次失败 -> 退避 500ms
    const fail1 = await worker.runOnce();
    assert.equal(fail1.outcome, 'REJECTED');
    assert.equal(fail1.rejectAcked, true);
    assert.equal(fail1.backoffMs, 500);
    assert.ok(fail1.retryOf);

    // 退避窗口内不重复轰炸
    const waiting = await worker.runOnce();
    assert.equal(waiting.outcome, 'BACKOFF_WAITING');
    assert.equal(wmsAttempts, 1);

    // 推进 500ms，第 2 次携带 retryOf 重试 -> 仍失败 -> 退避翻倍至 1000ms，并触发超最大重试告警
    fakeNow += 500;
    const fail2 = await worker.runOnce();
    assert.equal(fail2.outcome, 'REJECTED');
    assert.equal(fail2.backoffMs, 1000);
    assert.ok(logs.some((l) => l.code === 'OUTBOX_MAX_RETRIES_EXCEEDED'));

    // 推进 1000ms，第 3 次携带最新 retryOf 重试 -> WMS 恢复成功
    fakeNow += 1000;
    const ok = await worker.runOnce();
    assert.equal(ok.outcome, 'ACKNOWLEDGED');
    assert.equal(ok.externalReceipt, 'WMS-RECOVERED-01');
    assert.equal(outbox.getState().acknowledgedThrough, 1);

    // 核对 3 次发送的幂等键完全一致，且后端第 2/3 次领取正确携带上一次被拒令牌
    assert.equal(wms.received.length, 3);
    assert.ok(wms.received.every((r) => r.headers['idempotency-key'] === 'evt-retry-1'));
    const allAttempts = outbox.getState().attempts;
    assert.equal(allAttempts.length, 3);
    assert.equal(allAttempts[1].retryOf, allAttempts[0].token);
    assert.equal(allAttempts[2].retryOf, allAttempts[1].token);
  } finally {
    await outbox.close();
    await wms.close();
  }
});

test('积压事件达到阈值时输出结构化 OUTBOX_LAG_ALERT 滞后告警日志', async () => {
  const outbox = await startMockOutboxServer([
    { id: 'lag-1' },
    { id: 'lag-2' },
    { id: 'lag-3' }
  ]);
  const wms = await startMockWmsServer((_req, res) => sendJson(res, 200, { id: 'ok' }));
  const logs = [];

  try {
    const worker = createSyncWorker(
      loadWorkerConfig({
        CUTTING_API_URL: outbox.origin,
        CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
        WMS_WEBHOOK_URL: wms.url,
        LAG_ALERT_THRESHOLD: '2'
      }),
      { logger: (entry) => logs.push(entry) }
    );

    const lag = await worker.checkLag();
    assert.equal(lag.pendingCount, 3);
    assert.equal(lag.oldestEventId, 'lag-1');
    const alert = logs.find((l) => l.code === 'OUTBOX_LAG_ALERT');
    assert.ok(alert, '应记录 OUTBOX_LAG_ALERT 告警');
    assert.equal(alert.level, 'WARN');
    assert.equal(alert.pendingCount, 3);
    assert.equal(alert.threshold, 2);
  } finally {
    await outbox.close();
    await wms.close();
  }
});

test('WMS 拒收后进程崩溃重启：基于 WORKER_STATE_FILE 本地原子持久化自动恢复 retryOf 并重试成功，完成后清理状态文件', async () => {
  // 故意不开启 rejectedTokenField，验证不依赖服务端任何额外改动即可自愈
  const outbox = await startMockOutboxServer([{ id: 'evt-crash-file-1', action: 'CUT_REPORT' }]);
  let wmsCalls = 0;
  const wms = await startMockWmsServer((_req, res) => {
    wmsCalls += 1;
    if (wmsCalls === 1) {
      return sendJson(res, 503, { message: 'WMS 临时不可用' });
    }
    sendJson(res, 200, { externalReceipt: 'WMS-FILE-RECOVERED-01' });
  });

  const tempDir = mkdtempSync(join(tmpdir(), 'outbox-worker-state-'));
  const stateFile = join(tempDir, 'nested', 'worker-state.json');
  const logs1 = [];
  const logs2 = [];

  try {
    const baseEnv = {
      CUTTING_API_URL: outbox.origin,
      CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
      WMS_WEBHOOK_URL: wms.url,
      WORKER_STATE_FILE: stateFile
    };

    const cfg1 = loadWorkerConfig(baseEnv);
    assert.equal(cfg1.stateFile, stateFile);
    const worker1 = createSyncWorker(cfg1, { logger: (e) => logs1.push(e) });

    // 1. 首次转发失败并回执 REJECTED，原子落盘 pendingRetryOf
    const fail1 = await worker1.runOnce();
    assert.equal(fail1.outcome, 'REJECTED');
    assert.equal(fail1.rejectAcked, true);
    assert.ok(existsSync(stateFile), '拒收后必须原子持久化状态文件');
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.pendingRetryOf, fail1.retryOf);
    assert.equal(persisted.pendingRetryEventId, 'evt-crash-file-1');
    const dirEntries = readdirSync(join(tempDir, 'nested'));
    assert.deepEqual(dirEntries, ['worker-state.json'], '原子 rename 后不得遗留 .tmp 临时文件');

    // 2. 模拟进程崩溃：丢弃 worker1，基于同一 stateFile 启动全新 worker2 实例
    const worker2 = createSyncWorker(loadWorkerConfig(baseEnv), { logger: (e) => logs2.push(e) });
    assert.equal(worker2.state.pendingRetryOf, fail1.retryOf);
    assert.equal(worker2.state.pendingRetryEventId, 'evt-crash-file-1');
    assert.ok(logs2.some((l) => l.code === 'OUTBOX_STATE_RESTORED' && l.eventId === 'evt-crash-file-1'));

    // 3. worker2 自动携带持久化 retryOf 完成重试并回执 ACCEPTED，随后自动清理状态文件
    const recovered = await worker2.runOnce();
    assert.equal(recovered.outcome, 'ACKNOWLEDGED');
    assert.equal(recovered.eventId, 'evt-crash-file-1');
    assert.equal(recovered.externalReceipt, 'WMS-FILE-RECOVERED-01');
    assert.equal(outbox.getState().acknowledgedThrough, 1);
    assert.equal(existsSync(stateFile), false, '恢复并 ACCEPTED 成功后必须删除/清空状态文件');

    const allAttempts = outbox.getState().attempts;
    assert.equal(allAttempts.length, 2);
    assert.equal(allAttempts[1].retryOf, allAttempts[0].token);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await outbox.close();
    await wms.close();
  }
});

test('无本地状态文件时重启命中 DELIVERY_REJECTED：主动查询投递列表提取被拒 token 兜底续传并 ACCEPTED', async () => {
  for (const fieldName of ['rejectedToken', 'attempt.token']) {
    const outbox = await startMockOutboxServer(
      [{ id: 'evt-api-1' }, { id: 'evt-api-2' }],
      { rejectedTokenField: fieldName }
    );
    let failOnce = true;
    const wms = await startMockWmsServer((req, res) => {
      if (req.body.eventId === 'evt-api-2' && failOnce) {
        failOnce = false;
        return sendJson(res, 502, { message: '下游网关超时' });
      }
      sendJson(res, 200, { receiptId: `WMS-API-OK-${req.body.eventId}` });
    });
    const logs2 = [];

    try {
      const cfg = loadWorkerConfig({
        CUTTING_API_URL: outbox.origin,
        CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
        WMS_WEBHOOK_URL: wms.url
      });

      // 旧实例消费第 1 条成功、第 2 条拒收后未保存状态文件即崩溃
      const worker1 = createSyncWorker(cfg, { logger: () => {} });
      assert.equal((await worker1.runOnce()).outcome, 'ACKNOWLEDGED');
      const rejected = await worker1.runOnce();
      assert.equal(rejected.outcome, 'REJECTED');
      assert.equal(rejected.eventId, 'evt-api-2');

      // 新实例无任何本地状态文件启动：首次 claim 命中 DELIVERY_REJECTED -> 查列表恢复 token -> 重试 ACCEPTED
      const worker2 = createSyncWorker(cfg, { logger: (e) => logs2.push(e) });
      assert.equal(worker2.state.pendingRetryOf, null);
      const res = await worker2.runOnce();
      assert.equal(res.outcome, 'ACKNOWLEDGED', `字段 ${fieldName} 兜底恢复应直接完成重试并 ACCEPTED`);
      assert.equal(res.eventId, 'evt-api-2');
      assert.equal(res.externalReceipt, 'WMS-API-OK-evt-api-2');
      assert.equal(outbox.getState().acknowledgedThrough, 2);
      assert.ok(
        logs2.some((l) => l.code === 'OUTBOX_REJECTED_TOKEN_RECOVERED' && l.eventId === 'evt-api-2' && l.source === 'deliveries_api'),
        `字段 ${fieldName} 应输出 OUTBOX_REJECTED_TOKEN_RECOVERED 结构化日志`
      );

      const evt2Attempts = outbox.getState().attempts.filter((a) => a.eventId === 'evt-api-2');
      assert.equal(evt2Attempts.length, 2);
      assert.equal(evt2Attempts[1].retryOf, evt2Attempts[0].token);
    } finally {
      await outbox.close();
      await wms.close();
    }
  }
});

test('状态文件残留陈旧 retryOf 命中 STALE_ATTEMPT 时自动清理并恢复正常消费', async () => {
  const outbox = await startMockOutboxServer([{ id: 'evt-stale-1' }]);
  const wms = await startMockWmsServer((_req, res) => sendJson(res, 200, { receiptId: 'WMS-STALE-OK' }));
  const tempDir = mkdtempSync(join(tmpdir(), 'outbox-worker-stale-'));
  const stateFile = join(tempDir, 'stale-state.json');
  const logs = [];

  try {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      apiOrigin: outbox.origin,
      pendingRetryOf: '00000000-0000-0000-0000-000000000000',
      pendingRetryEventId: 'evt-already-done'
    }));

    const worker = createSyncWorker(
      loadWorkerConfig({
        CUTTING_API_URL: outbox.origin,
        CUTTING_INTEGRATION_TOKEN: TEST_TOKEN,
        WMS_WEBHOOK_URL: wms.url,
        WORKER_STATE_FILE: stateFile
      }),
      { logger: (e) => logs.push(e) }
    );

    const res = await worker.runOnce();
    assert.equal(res.outcome, 'ACKNOWLEDGED');
    assert.equal(res.eventId, 'evt-stale-1');
    assert.equal(existsSync(stateFile), false, '陈旧状态文件应被自动清理');
    assert.ok(logs.some((l) => l.code === 'OUTBOX_STALE_RETRY_STATE_CLEARED'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await outbox.close();
    await wms.close();
  }
});
