import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 外部库存 Outbox 生产级同步 Worker（零第三方依赖，基于 Node 22 原生 fetch）。
 *
 * 工作流：
 * 1. 按周期调用 POST /api/v2/integration-deliveries/claims 顺序领取待投递事件（租约机制）。
 * 2. 携带 Idempotency-Key / X-Cutting-Event-Id 幂等头转发至外部 WMS Webhook。
 * 3. 转发成功调用 POST /api/v2/integration-deliveries/{eventId}/acknowledgements (ACCEPTED)；
 *    失败则回执 REJECTED，原子持久化被拒 token（WORKER_STATE_FILE）并按指数退避携带 retryOf 重试；
 *    进程崩溃重启后优先从状态文件恢复，未命中时主动查询 GET /api/v2/integration-deliveries 兜底续传。
 * 4. 定期巡检 GET /api/v2/integration-deliveries 积压深度，超阈值输出结构化滞后告警日志。
 */

function parsePositiveInt(raw, fallback, name, { min = 1, max = 86_400_000 } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`${name} 必须为 ${min} 到 ${max} 之间的整数`);
  }
  return num;
}

function parseHttpUrl(raw, name) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`缺少必填配置 ${name}`);
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} 不是合法的 URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} 仅支持 http/https 协议`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} 不允许在 URL 中内嵌明文凭据`);
  }
  return url;
}

export function loadWorkerConfig(env = process.env) {
  const apiUrl = parseHttpUrl(env.CUTTING_API_URL || 'http://127.0.0.1:8080', 'CUTTING_API_URL');
  const integrationToken = String(env.CUTTING_INTEGRATION_TOKEN || '').trim();
  if (!integrationToken) {
    throw new Error('缺少必填配置 CUTTING_INTEGRATION_TOKEN（专用集成 Bearer 凭据）');
  }
  const wmsUrl = parseHttpUrl(env.WMS_WEBHOOK_URL, 'WMS_WEBHOOK_URL');
  const wmsToken = String(env.WMS_WEBHOOK_TOKEN || '').trim();

  const pollIntervalMs = parsePositiveInt(env.POLL_INTERVAL_MS, 2000, 'POLL_INTERVAL_MS', { min: 50, max: 300_000 });
  const baseBackoffMs = parsePositiveInt(env.BASE_BACKOFF_MS, 1000, 'BASE_BACKOFF_MS', { min: 20, max: 300_000 });
  const maxBackoffMs = parsePositiveInt(env.MAX_BACKOFF_MS, 60_000, 'MAX_BACKOFF_MS', { min: baseBackoffMs, max: 3_600_000 });
  const requestTimeoutMs = parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000, 'REQUEST_TIMEOUT_MS', { min: 200, max: 120_000 });
  const lagAlertThreshold = parsePositiveInt(env.LAG_ALERT_THRESHOLD, 10, 'LAG_ALERT_THRESHOLD', { min: 1, max: 100_000 });
  const lagCheckEveryTicks = parsePositiveInt(env.LAG_CHECK_EVERY_TICKS, 5, 'LAG_CHECK_EVERY_TICKS', { min: 1, max: 1000 });
  const maxRetries = parsePositiveInt(env.MAX_RETRIES, 8, 'MAX_RETRIES', { min: 1, max: 1000 });
  const workerId = String(env.WORKER_ID || 'wms-sync').trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'wms-sync';
  const stateFile = String(env.WORKER_STATE_FILE || '').trim() || null;

  return {
    apiOrigin: apiUrl.origin,
    integrationToken,
    wmsWebhookUrl: wmsUrl.toString(),
    wmsWebhookToken: wmsToken,
    pollIntervalMs,
    baseBackoffMs,
    maxBackoffMs,
    requestTimeoutMs,
    lagAlertThreshold,
    lagCheckEveryTicks,
    maxRetries,
    workerId,
    stateFile
  };
}

export function computeBackoffMs(attemptCount, baseBackoffMs, maxBackoffMs) {
  const safeAttempt = Math.max(1, Math.floor(Number(attemptCount) || 1));
  const raw = baseBackoffMs * Math.pow(2, Math.min(20, safeAttempt - 1));
  return Math.min(maxBackoffMs, Math.round(raw));
}

function sanitizeReceipt(value, eventId) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : `WMS-ACK-${eventId}`;
  return raw.slice(0, 200);
}

function sanitizeReason(value) {
  const raw = String(value || '外部 WMS 接收失败').trim() || '外部 WMS 接收失败';
  return raw.slice(0, 1000);
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text.slice(0, 400) };
  }
}

function extractTokenFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.rejectedToken,
    record.retryToken,
    record.attemptToken,
    record.lastAttemptToken,
    record.token,
    typeof record.attempt === 'object' && record.attempt ? record.attempt.token : null,
    typeof record.lastAttempt === 'object' && record.lastAttempt ? record.lastAttempt.token : null
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function createSyncWorker(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const logger = deps.logger || ((entry) => process.stderr.write(JSON.stringify(entry) + '\n'));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const stateFilePath = typeof config.stateFile === 'string' && config.stateFile.trim()
    ? config.stateFile.trim()
    : null;

  const state = {
    running: false,
    tickCount: 0,
    consecutiveFailures: 0,
    pendingRetryOf: null,
    pendingRetryEventId: null,
    nextAllowedAt: 0,
    totalAcked: 0,
    totalRejected: 0,
    lastLag: null
  };

  function log(level, code, fields = {}) {
    logger({
      timestamp: new Date(now()).toISOString(),
      workerId: config.workerId,
      level,
      code,
      ...fields
    });
  }

  function clearPersistedRetryState() {
    if (!stateFilePath) return;
    try {
      rmSync(stateFilePath, { force: true });
    } catch (err) {
      log('WARN', 'OUTBOX_STATE_CLEAR_FAILED', {
        message: sanitizeReason(err?.message || String(err))
      });
    }
  }

  function persistRetryState() {
    if (!stateFilePath) return;
    if (!state.pendingRetryOf) {
      clearPersistedRetryState();
      return;
    }
    const serialized = JSON.stringify({
      version: 1,
      workerId: config.workerId,
      apiOrigin: config.apiOrigin,
      pendingRetryOf: state.pendingRetryOf,
      pendingRetryEventId: state.pendingRetryEventId,
      updatedAt: new Date(now()).toISOString()
    }, null, 2);
    const tmpPath = `${stateFilePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      mkdirSync(dirname(stateFilePath), { recursive: true });
      writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, stateFilePath);
    } catch (err) {
      try { rmSync(tmpPath, { force: true }); } catch {}
      log('WARN', 'OUTBOX_STATE_PERSIST_FAILED', {
        message: sanitizeReason(err?.message || String(err))
      });
    }
  }

  function setPendingRetry(token, eventId) {
    state.pendingRetryOf = token || null;
    state.pendingRetryEventId = token ? (eventId || null) : null;
    persistRetryState();
  }

  function clearPendingRetry() {
    state.pendingRetryOf = null;
    state.pendingRetryEventId = null;
    clearPersistedRetryState();
  }

  function loadPersistedRetryState() {
    if (!stateFilePath) return;
    let raw;
    try {
      raw = readFileSync(stateFilePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      log('WARN', 'OUTBOX_STATE_LOAD_FAILED', {
        message: sanitizeReason(err?.message || String(err))
      });
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.apiOrigin && parsed.apiOrigin !== config.apiOrigin) {
        return;
      }
      const token = typeof parsed?.pendingRetryOf === 'string' && parsed.pendingRetryOf.trim()
        ? parsed.pendingRetryOf.trim()
        : null;
      if (!token) return;
      state.pendingRetryOf = token;
      state.pendingRetryEventId = typeof parsed?.pendingRetryEventId === 'string' && parsed.pendingRetryEventId.trim()
        ? parsed.pendingRetryEventId.trim()
        : null;
      log('INFO', 'OUTBOX_STATE_RESTORED', {
        eventId: state.pendingRetryEventId,
        hasRetryToken: true
      });
    } catch (err) {
      log('WARN', 'OUTBOX_STATE_LOAD_FAILED', {
        message: sanitizeReason(err?.message || String(err))
      });
    }
  }

  loadPersistedRetryState();

  async function apiRequest(path, { method = 'GET', body } = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${config.integrationToken}`
    };
    let encoded;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      encoded = JSON.stringify(body);
    }
    const response = await fetchImpl(`${config.apiOrigin}${path}`, {
      method,
      headers,
      body: encoded,
      redirect: 'error',
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
    const payload = await readJsonSafe(response);
    if (!response.ok) {
      const err = new Error(payload?.message || `后端集成接口返回 HTTP ${response.status}`);
      err.status = response.status;
      err.code = payload?.code || `HTTP_${response.status}`;
      err.retryable = payload?.retryable === true || response.status >= 500;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  async function forwardToWms(lease) {
    const event = lease.event;
    const attemptNo = lease.attempt?.number ?? 1;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': String(event.id),
      'X-Cutting-Event-Id': String(event.id),
      'X-Cutting-Event-Sequence': String(event.sequence ?? ''),
      'X-Cutting-Consumer': String(lease.consumer || ''),
      'X-Cutting-Attempt': String(attemptNo)
    };
    if (config.wmsWebhookToken) {
      headers.Authorization = `Bearer ${config.wmsWebhookToken}`;
    }

    const response = await fetchImpl(config.wmsWebhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        eventId: event.id,
        sequence: event.sequence,
        consumer: lease.consumer,
        attempt: attemptNo,
        event
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
    const payload = await readJsonSafe(response);
    if (!response.ok) {
      const detail = payload?.message || payload?.error || payload?.rawText || `HTTP ${response.status}`;
      const err = new Error(`WMS Webhook 拒绝（HTTP ${response.status}）：${detail}`);
      err.status = response.status;
      throw err;
    }
    const externalReceipt = sanitizeReceipt(
      payload?.externalReceipt || payload?.receiptId || payload?.receipt || payload?.id,
      event.id
    );
    return { externalReceipt, payload };
  }

  async function ackEvent(eventId, token, externalReceipt) {
    return apiRequest(`/api/v2/integration-deliveries/${encodeURIComponent(eventId)}/acknowledgements`, {
      method: 'POST',
      body: {
        token,
        status: 'ACCEPTED',
        externalReceipt: sanitizeReceipt(externalReceipt, eventId)
      }
    });
  }

  async function rejectEvent(eventId, token, reason) {
    return apiRequest(`/api/v2/integration-deliveries/${encodeURIComponent(eventId)}/acknowledgements`, {
      method: 'POST',
      body: {
        token,
        status: 'REJECTED',
        reason: sanitizeReason(reason)
      }
    });
  }

  async function checkLag() {
    const page = await apiRequest('/api/v2/integration-deliveries?after=0&limit=100');
    const acknowledgedThrough = Number(page?.acknowledgedThrough) || 0;
    const allItems = Array.isArray(page?.items) ? page.items : [];
    const pendingItems = allItems.filter(
      (item) => Number(item?.sequence) > acknowledgedThrough || item?.state !== 'ACKNOWLEDGED'
    );
    const pendingCount = pendingItems.length;
    const lagSnapshot = {
      consumer: page?.consumer || null,
      acknowledgedThrough,
      pendingCount,
      hasMore: Boolean(page?.hasMore),
      oldestEventId: pendingItems[0]?.eventId || null,
      oldestState: pendingItems[0]?.state || null
    };
    state.lastLag = lagSnapshot;

    if (pendingCount >= config.lagAlertThreshold || Boolean(page?.hasMore)) {
      log('WARN', 'OUTBOX_LAG_ALERT', {
        ...lagSnapshot,
        threshold: config.lagAlertThreshold,
        consecutiveFailures: state.consecutiveFailures
      });
    }
    return lagSnapshot;
  }

  async function recoverRejectedTokenFromApi(errorPayload) {
    const inlineToken = extractTokenFromRecord(errorPayload);
    if (inlineToken) {
      return {
        token: inlineToken,
        eventId: errorPayload?.eventId || null,
        source: 'error_payload'
      };
    }

    const firstPage = await apiRequest('/api/v2/integration-deliveries?after=0&limit=100');
    const ackThrough = Number(firstPage?.acknowledgedThrough) || 0;
    const findRejectedHead = (items) => {
      if (!Array.isArray(items)) return null;
      const exactHead = items.find(
        (item) => Number(item?.sequence) === ackThrough + 1 && item?.state === 'REJECTED'
      );
      if (exactHead) return exactHead;
      return items.find((item) => item?.state === 'REJECTED') || null;
    };

    let target = findRejectedHead(firstPage?.items);
    if (!target && ackThrough > 0) {
      const headPage = await apiRequest(`/api/v2/integration-deliveries?after=${ackThrough}&limit=20`);
      target = findRejectedHead(headPage?.items);
    }
    if (!target) return null;

    const token = extractTokenFromRecord(target);
    if (!token) return null;
    return {
      token,
      eventId: target.eventId || null,
      source: 'deliveries_api'
    };
  }

  async function claimNextLease() {
    const requestId = `${config.workerId}-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const claimBody = state.pendingRetryOf
      ? { requestId, retryOf: state.pendingRetryOf }
      : { requestId };
    return apiRequest('/api/v2/integration-deliveries/claims', {
      method: 'POST',
      body: claimBody
    });
  }

  async function runOnce() {
    state.tickCount += 1;

    if (state.nextAllowedAt > now()) {
      return {
        outcome: 'BACKOFF_WAITING',
        waitMs: state.nextAllowedAt - now(),
        consecutiveFailures: state.consecutiveFailures
      };
    }

    let lease;
    try {
      lease = await claimNextLease();
    } catch (err) {
      let finalErr = err;
      if (err.code === 'STALE_ATTEMPT' && state.pendingRetryOf) {
        log('WARN', 'OUTBOX_STALE_RETRY_STATE_CLEARED', {
          eventId: state.pendingRetryEventId
        });
        clearPendingRetry();
        try {
          lease = await claimNextLease();
          finalErr = null;
        } catch (retryErr) {
          finalErr = retryErr;
        }
      }

      if (finalErr && finalErr.code === 'DELIVERY_REJECTED') {
        const previousRetryOf = state.pendingRetryOf;
        try {
          const recovered = await recoverRejectedTokenFromApi(finalErr.payload);
          if (recovered?.token && recovered.token !== previousRetryOf) {
            setPendingRetry(recovered.token, recovered.eventId);
            log('WARN', 'OUTBOX_REJECTED_TOKEN_RECOVERED', {
              eventId: recovered.eventId,
              source: recovered.source
            });
            try {
              lease = await claimNextLease();
              finalErr = null;
            } catch (retryErr) {
              finalErr = retryErr;
            }
          }
        } catch (recoverErr) {
          log('ERROR', 'OUTBOX_REJECTED_RECOVERY_FAILED', {
            errorCode: recoverErr?.code || 'RECOVERY_ERROR',
            message: sanitizeReason(recoverErr?.message)
          });
        }
      }

      if (finalErr) {
        state.consecutiveFailures += 1;
        const backoffMs = computeBackoffMs(state.consecutiveFailures, config.baseBackoffMs, config.maxBackoffMs);
        state.nextAllowedAt = now() + backoffMs;
        log('ERROR', finalErr.code === 'DELIVERY_REJECTED' ? 'OUTBOX_DELIVERY_REJECTED' : 'OUTBOX_CLAIM_FAILED', {
          errorCode: finalErr.code || 'CLAIM_ERROR',
          message: sanitizeReason(finalErr.message),
          consecutiveFailures: state.consecutiveFailures,
          backoffMs
        });
        return { outcome: 'CLAIM_ERROR', errorCode: finalErr.code || 'CLAIM_ERROR', backoffMs };
      }
    }

    if (!lease || lease.state === 'EMPTY' || !lease.event || !lease.attempt) {
      state.consecutiveFailures = 0;
      clearPendingRetry();
      state.nextAllowedAt = 0;
      if (state.tickCount % config.lagCheckEveryTicks === 0) {
        await checkLag().catch(() => {});
      }
      return { outcome: 'EMPTY' };
    }

    const eventId = lease.event.id;
    const token = lease.attempt.token;
    const sequence = lease.event.sequence;

    try {
      const { externalReceipt } = await forwardToWms(lease);
      const delivery = await ackEvent(eventId, token, externalReceipt);
      state.totalAcked += 1;
      state.consecutiveFailures = 0;
      clearPendingRetry();
      state.nextAllowedAt = 0;

      log('INFO', 'OUTBOX_DELIVERY_ACKED', {
        eventId,
        sequence,
        attempt: lease.attempt.number,
        externalReceipt,
        state: delivery?.state || 'ACKNOWLEDGED'
      });

      if (state.tickCount % config.lagCheckEveryTicks === 0) {
        await checkLag().catch(() => {});
      }
      return { outcome: 'ACKNOWLEDGED', eventId, sequence, externalReceipt };
    } catch (forwardErr) {
      const reason = sanitizeReason(forwardErr?.message);
      let rejectAcked = false;
      try {
        await rejectEvent(eventId, token, reason);
        rejectAcked = true;
      } catch (rejectErr) {
        log('ERROR', 'OUTBOX_REJECT_ACK_FAILED', {
          eventId,
          sequence,
          errorCode: rejectErr?.code || 'REJECT_ERROR',
          message: sanitizeReason(rejectErr?.message)
        });
      }

      state.totalRejected += 1;
      state.consecutiveFailures += 1;
      if (rejectAcked) {
        setPendingRetry(token, eventId);
      } else {
        clearPendingRetry();
      }
      const backoffMs = computeBackoffMs(state.consecutiveFailures, config.baseBackoffMs, config.maxBackoffMs);
      state.nextAllowedAt = now() + backoffMs;

      log('WARN', 'WMS_FORWARD_FAILED', {
        eventId,
        sequence,
        attempt: lease.attempt.number,
        rejectAcked,
        reason,
        consecutiveFailures: state.consecutiveFailures,
        backoffMs
      });

      if (state.consecutiveFailures >= config.maxRetries) {
        log('ERROR', 'OUTBOX_MAX_RETRIES_EXCEEDED', {
          eventId,
          sequence,
          consecutiveFailures: state.consecutiveFailures,
          maxRetries: config.maxRetries,
          backoffMs
        });
      }

      return {
        outcome: 'REJECTED',
        eventId,
        sequence,
        rejectAcked,
        retryOf: state.pendingRetryOf,
        backoffMs,
        consecutiveFailures: state.consecutiveFailures
      };
    }
  }

  async function start() {
    if (state.running) return;
    state.running = true;
    log('INFO', 'OUTBOX_WORKER_STARTED', {
      apiOrigin: config.apiOrigin,
      pollIntervalMs: config.pollIntervalMs,
      baseBackoffMs: config.baseBackoffMs,
      maxBackoffMs: config.maxBackoffMs,
      lagAlertThreshold: config.lagAlertThreshold
    });

    while (state.running) {
      const result = await runOnce();
      if (!state.running) break;
      if (result.outcome === 'ACKNOWLEDGED') {
        // 连续消费积压事件，不额外空等完整轮询周期
        continue;
      }
      const waitMs =
        result.outcome === 'BACKOFF_WAITING'
          ? Math.min(config.pollIntervalMs, Math.max(50, result.waitMs))
          : config.pollIntervalMs;
      await sleep(waitMs);
    }
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    log('INFO', 'OUTBOX_WORKER_STOPPED', {
      totalAcked: state.totalAcked,
      totalRejected: state.totalRejected
    });
  }

  return {
    config,
    state,
    runOnce,
    checkLag,
    start,
    stop
  };
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const config = loadWorkerConfig(process.env);
    const worker = createSyncWorker(config);
    process.once('SIGINT', () => worker.stop());
    process.once('SIGTERM', () => worker.stop());
    await worker.start();
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        code: 'OUTBOX_WORKER_STARTUP_FAILED',
        message: err?.message || String(err)
      }) + '\n'
    );
    process.exitCode = 1;
  }
}
