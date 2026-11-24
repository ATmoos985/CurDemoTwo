import test from 'node:test';
import assert from 'node:assert/strict';
import { OptimizationSession } from '../../main/resources/static/js/business/optimization/job-client.js';

const response = (value) => ({ ok: true, json: async () => value });

function createMockEventSource() {
  const listeners = new Map();
  return {
    closed: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    emit(type, payload) {
      const fns = listeners.get(type) || [];
      const evt = payload === undefined ? {} : { data: typeof payload === 'string' ? payload : JSON.stringify(payload) };
      for (const fn of fns) fn(evt);
    },
    close() {
      this.closed = true;
    }
  };
}

test('job transport submits once, polls and reads archived result without invoking a solver endpoint', async () => {
  const calls = [];
  const phases = [];
  const client = new OptimizationSession(
    async (path, options = {}) => {
      calls.push([path, options]);
      if (path.endsWith('/optimization-jobs')) return response({ id: 'a', state: 'QUEUED' });
      if (path.includes('/optimization-results/')) return response({ marker: { trials: [1] } });
      return response({ id: 'a', state: 'SUCCEEDED', resultRef: '/api/v2/optimization-results/a' });
    },
    0
  );
  const result = await client.solve(
    { strategy: { id: 'marker-shortening' } },
    { onProgress: (j) => phases.push(j.state) }
  );
  assert.deepEqual(phases, ['QUEUED', 'SUCCEEDED']);
  assert.deepEqual(result.result.marker.trials, [1]);
  assert.equal(calls.length, 3);
  assert.ok(calls[0][1].headers['Idempotency-Key']);
  assert.ok(calls.every(([path]) => path.startsWith('/api/v2/')));
});

test('cancellation before submit returns still cancels the accepted server job', async () => {
  let accept;
  const calls = [];
  const client = new OptimizationSession(
    async (path) => {
      calls.push(path);
      if (path.endsWith('/optimization-jobs')) return new Promise((resolve) => { accept = resolve; });
      return response({ id: 'late', state: 'CANCEL_REQUESTED' });
    },
    0
  );
  const pending = client.solve({});
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await client.cancel();
  accept(response({ id: 'late', state: 'QUEUED' }));
  await rejected;
  assert.deepEqual(calls, ['/api/v2/optimization-jobs', '/api/v2/optimization-jobs/late/cancellations']);
});

test('failed job is reported without attempting to fetch a nonexistent result', async () => {
  const calls = [];
  const client = new OptimizationSession(
    async (path) => {
      calls.push(path);
      return response({ id: 'failed', state: 'FAILED', message: '引擎失败' });
    },
    0
  );
  await assert.rejects(client.solve({}), /引擎失败/);
  assert.equal(calls.length, 1);
});

test('result URL is derived from job identity even if a response supplies a remote URL', async () => {
  const calls = [];
  const client = new OptimizationSession(
    async (path) => {
      calls.push(path);
      return response(
        path.endsWith('/optimization-jobs')
          ? { id: 'a', state: 'TIMED_OUT', resultRef: 'https://untrusted.test/result' }
          : { marker: {} }
      );
    },
    0
  );
  await client.solve({});
  assert.deepEqual(calls, ['/api/v2/optimization-jobs', '/api/v2/optimization-results/a']);
});

test('polling failure cancels accepted work before dropping its handle', async () => {
  const calls = [];
  const client = new OptimizationSession(
    async (path) => {
      calls.push(path);
      if (path.endsWith('/optimization-jobs')) return response({ id: 'network-failure', state: 'RUNNING' });
      if (path.endsWith('/cancellations')) return response({ state: 'CANCEL_REQUESTED' });
      throw new Error('network unavailable');
    },
    0
  );
  await assert.rejects(client.solve({}), /network unavailable/);
  await client.cancel();
  assert.deepEqual(calls, [
    '/api/v2/optimization-jobs',
    '/api/v2/optimization-jobs/network-failure',
    '/api/v2/optimization-jobs/network-failure/cancellations'
  ]);
});

test('non-HTTPS origin without crypto.randomUUID still generates a valid Idempotency-Key and surfaces non-JSON proxy errors', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const origRandomUUID = globalThis.crypto?.randomUUID;
  let patched = false;
  try {
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
      patched = true;
    }
    const headersSeen = [];
    const client = new OptimizationSession(
      async (path, options = {}) => {
        if (path.endsWith('/optimization-jobs')) {
          headersSeen.push(options.headers['Idempotency-Key']);
          return response({ id: 'http-ok', state: 'SUCCEEDED', resultRef: '/api/v2/optimization-results/http-ok' });
        }
        return response({ layout: { placements: [] } });
      },
      0
    );
    await client.solve({});
    assert.match(headersSeen[0], /^[0-9a-f-]{36}$/i);

    const proxyErrorClient = new OptimizationSession(
      async () => ({
        ok: false,
        status: 401,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        }
      }),
      0
    );
    await assert.rejects(proxyErrorClient.solve({}), /401/);
  } finally {
    if (patched && globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: origRandomUUID, configurable: true });
    } else if (desc) {
      Object.defineProperty(globalThis, 'crypto', desc);
    }
  }
});

test('SSE 优先接收 progress 与 done 实时事件并正确读取归档结果', async () => {
  const sseUrls = [];
  const es = createMockEventSource();
  const progressEvents = [];
  const fetchCalls = [];

  const client = new OptimizationSession(
    async (path) => {
      fetchCalls.push(path);
      if (path.endsWith('/optimization-jobs')) return response({ id: 'sse-1', state: 'QUEUED' });
      if (path === '/api/v2/optimization-jobs/sse-1') {
        return response({ id: 'sse-1', state: 'SUCCEEDED', phase: 'COMPLETED', resultRef: '/api/v2/optimization-results/sse-1' });
      }
      return response({ layout: { placements: [{ id: 1 }] } });
    },
    10,
    () => {},
    {
      eventSourceFactory: (url) => {
        sseUrls.push(url);
        queueMicrotask(() => {
          es.emit('progress', { jobId: 'sse-1', status: 'RUNNING', phase: 'SOLVING', elapsedMs: 320 });
          es.emit('progress', { jobId: 'sse-1', status: 'RUNNING', phase: 'VALIDATING', elapsedMs: 680 });
          es.emit('done', { jobId: 'sse-1', status: 'SUCCEEDED', phase: 'COMPLETED', elapsedMs: 740 });
        });
        return es;
      }
    }
  );

  const solved = await client.solve({}, { onProgress: (j) => progressEvents.push({ state: j.state, phase: j.phase, elapsedMs: j.elapsedMs }) });
  assert.deepEqual(sseUrls, ['/api/v2/optimization-jobs/sse-1/events']);
  assert.equal(es.closed, true);
  assert.ok(progressEvents.some((e) => e.phase === 'SOLVING' && e.elapsedMs === 320));
  assert.ok(progressEvents.some((e) => e.phase === 'VALIDATING' && e.elapsedMs === 680));
  assert.equal(solved.job.state, 'SUCCEEDED');
  assert.equal(solved.result.layout.placements.length, 1);
  assert.deepEqual(fetchCalls, [
    '/api/v2/optimization-jobs',
    '/api/v2/optimization-jobs/sse-1',
    '/api/v2/optimization-results/sse-1'
  ]);
});

test('SSE 通道中断时自动无缝平滑降级至轮询并完成求解', async () => {
  const es = createMockEventSource();
  let pollCount = 0;
  const client = new OptimizationSession(
    async (path) => {
      if (path.endsWith('/optimization-jobs')) return response({ id: 'sse-fallback', state: 'QUEUED' });
      if (path === '/api/v2/optimization-jobs/sse-fallback') {
        pollCount += 1;
        if (pollCount === 1) return response({ id: 'sse-fallback', state: 'RUNNING', phase: 'SOLVING' });
        return response({ id: 'sse-fallback', state: 'SUCCEEDED', resultRef: '/api/v2/optimization-results/sse-fallback' });
      }
      return response({ layout: { placements: [{ id: 9 }] } });
    },
    0,
    () => {},
    {
      eventSourceFactory: () => {
        queueMicrotask(() => es.emit('error'));
        return es;
      }
    }
  );

  const solved = await client.solve({});
  assert.equal(es.closed, true);
  assert.equal(pollCount, 2);
  assert.equal(solved.result.layout.placements[0].id, 9);
});

test('SSE 监听期间取消作业会立即关闭 EventSource 并通知服务端取消', async () => {
  const es = createMockEventSource();
  const calls = [];
  const client = new OptimizationSession(
    async (path) => {
      calls.push(path);
      if (path.endsWith('/optimization-jobs')) return response({ id: 'sse-cancel', state: 'RUNNING' });
      return response({ id: 'sse-cancel', state: 'CANCEL_REQUESTED' });
    },
    50,
    () => {},
    { eventSourceFactory: () => es }
  );

  const runPromise = client.solve({});
  const rejected = assert.rejects(runPromise, { name: 'AbortError' });
  await new Promise((r) => setTimeout(r, 10));
  await client.cancel();
  await rejected;
  assert.equal(es.closed, true);
  assert.ok(calls.includes('/api/v2/optimization-jobs/sse-cancel/cancellations'));
});
