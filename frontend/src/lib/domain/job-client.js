import { createUuid } from '../core/uuid.js';

const TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

/**
 * 标准优化作业客户端：
 * - 优先通过 SSE（GET /api/v2/optimization-jobs/{id}/events）接收实时 phase 与终态事件；
 * - 若运行环境无 EventSource 或 SSE 建连/流中断，自动无缝回退至原有受控轮询；
 * - 取消操作同步关闭 SSE 与中断轮询，覆盖提交返回前的晚到响应取消保护。
 */
export class OptimizationSession {
  constructor(
    fetchImpl = (...args) => globalThis.fetch(...args),
    intervalMs = 150,
    onCancellationError = () => {},
    options = {}
  ) {
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
    this.current = null;
    this.onCancellationError = onCancellationError;
    this.eventSourceFactory = options.eventSourceFactory ?? null;
    this.enableSse = options.enableSse !== false;
    this.sseTransport = options.sseTransport ?? 'auto';
  }

  async read(path, options = {}) {
    const fetchOptions =
      !options.method || options.method === 'GET' ? { cache: 'no-store', ...options } : options;
    const response = await this.fetch(path, fetchOptions);
    let value = null;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!response.ok) {
      const status = response.status;
      const fallbackMsg =
        status === 401 || status === 403
          ? `访问认证失效（${status}），请刷新页面重新登录后重试`
          : status === 413
          ? '请求数据过大（413），请检查反代网关请求体限制'
          : status === 429
          ? '计算并发排队或归档限额已满（429），请稍后重试'
          : status === 502 || status === 503 || status === 504
          ? `远端计算服务暂不可用或网关超时（${status}），请稍后重试`
          : `计算服务请求失败（${status}）`;
      throw new Error(value?.message || fallbackMsg);
    }
    if (value == null) throw new Error('计算服务返回了无效响应，请检查网络或反代网关状态');
    return value;
  }

  cancel() {
    const token = this.current;
    if (!token) return Promise.resolve();
    token.cancelled = true;
    token.poll.abort();
    if (token.closeSse) {
      try {
        token.closeSse();
      } catch {
        // 忽略关闭异常
      }
      token.closeSse = null;
    }
    return this.cancelJob(token);
  }

  cancelJob(token) {
    if (!token.id || token.cancelPromise) return token.cancelPromise || Promise.resolve();
    token.cancelPromise = this.read(
      `/api/v2/optimization-jobs/${encodeURIComponent(token.id)}/cancellations`,
      { method: 'POST', keepalive: true }
    ).catch((error) => {
      token.cancelError = error;
      if (!this.current || this.current === token) this.onCancellationError(error);
    });
    return token.cancelPromise;
  }

  resolveEventSource(url) {
    if (!this.enableSse) return null;
    if (typeof this.eventSourceFactory === 'function') {
      return this.eventSourceFactory(url);
    }
    return null;
  }

  shouldUseFetchSse() {
    if (!this.enableSse) return false;
    if (this.sseTransport === 'fetch') return true;
    if (this.sseTransport === 'eventsource') return false;
    return (
      typeof globalThis !== 'undefined' &&
      (typeof globalThis.EventSource === 'function' || typeof globalThis.window !== 'undefined')
    );
  }

  /**
   * 尝试通过 SSE 订阅作业实时进度：
   * - 若注入了自定义 eventSourceFactory（如单测 mock），沿用 EventSource 协议；
   * - 生产浏览器环境优先通过 fetch 流式读取 text/event-stream，天然复用全局鉴权拦截器透传 Authorization: Bearer，
   *   避免企业认证模式下原生 EventSource 吃 401，且取消时通过 AbortController 静默收口。
   */
  waitViaSse(job, token, onProgress) {
    const sseUrl = `/api/v2/optimization-jobs/${encodeURIComponent(job.id)}/events`;
    if (typeof this.eventSourceFactory === 'function') {
      return this.waitViaEventSource(sseUrl, job, token, onProgress);
    }
    if (this.shouldUseFetchSse()) {
      return this.waitViaFetchSse(sseUrl, job, token, onProgress);
    }
    return Promise.resolve({ done: false, fallback: true });
  }

  async waitViaFetchSse(sseUrl, job, token, onProgress) {
    const sseAbort = new AbortController();
    let closed = false;
    const closeStream = () => {
      if (closed) return;
      closed = true;
      try {
        sseAbort.abort();
      } catch {
        // 忽略重复中止异常
      }
    };
    token.closeSse = closeStream;

    const mergeAndNotify = (eventName, rawData) => {
      let payload = null;
      try {
        payload = JSON.parse(rawData);
      } catch {
        return false;
      }
      if (!payload || typeof payload !== 'object') return false;
      const nextState = payload.status || payload.state || job.state;
      const nextJob = {
        ...job,
        state: nextState,
        status: nextState,
        phase: payload.phase ?? job.phase,
        elapsedMs: payload.elapsedMs ?? job.elapsedMs,
        transport: 'sse'
      };
      Object.assign(job, nextJob);
      const isDoneEvent = eventName === 'done' || TERMINAL_STATES.includes(nextState);
      if (isDoneEvent) {
        return { done: true, lastEvent: payload };
      }
      if (eventName === 'progress' || payload.status || payload.state || payload.phase) {
        onProgress({ ...job });
      }
      return false;
    };

    let reader = null;
    try {
      const response = await this.fetch(sseUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: sseAbort.signal
      });
      if (token.cancelled || closed) return { done: false, aborted: true };
      if (!response || !response.ok || !response.body || typeof response.body.getReader !== 'function') {
        return { done: false, fallback: true };
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (token.cancelled || closed) return { done: false, aborted: true };
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (!frame.trim()) continue;
            let eventName = 'message';
            const dataLines = [];
            for (const line of frame.split(/\r?\n/)) {
              if (!line || line.startsWith(':')) continue;
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim() || 'message';
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (!dataLines.length) continue;
            const terminalHit = mergeAndNotify(eventName, dataLines.join('\n'));
            if (terminalHit) {
              return terminalHit;
            }
          }
        }
        if (done) {
          if (TERMINAL_STATES.includes(job.state)) {
            return { done: true, lastEvent: null };
          }
          return { done: false, fallback: true };
        }
      }
    } catch {
      if (token.cancelled || closed) return { done: false, aborted: true };
      return { done: false, fallback: true };
    } finally {
      if (token.closeSse === closeStream) token.closeSse = null;
      try {
        await reader?.cancel?.();
      } catch {
        // 忽略关闭异常
      }
      closeStream();
    }
  }

  waitViaEventSource(sseUrl, job, token, onProgress) {
    let es = null;
    try {
      es = this.resolveEventSource(sseUrl);
    } catch {
      return Promise.resolve({ done: false, fallback: true });
    }
    if (!es || typeof es.addEventListener !== 'function') {
      return Promise.resolve({ done: false, fallback: true });
    }

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (token.closeSse === finishAbort) token.closeSse = null;
        try {
          es.close?.();
        } catch {
          // 忽略关闭异常
        }
      };
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      const finishAbort = () => finish({ done: false, aborted: true });
      token.closeSse = finishAbort;

      const parseEventData = (evt) => {
        if (!evt || evt.data == null) return null;
        if (typeof evt.data === 'object') return evt.data;
        try {
          return JSON.parse(String(evt.data));
        } catch {
          return null;
        }
      };

      const mergeAndNotify = (payload, isDoneEvent) => {
        if (!payload || typeof payload !== 'object') return;
        const nextState = payload.status || payload.state || job.state;
        const nextJob = {
          ...job,
          state: nextState,
          status: nextState,
          phase: payload.phase ?? job.phase,
          elapsedMs: payload.elapsedMs ?? job.elapsedMs,
          transport: 'sse'
        };
        Object.assign(job, nextJob);
        if (isDoneEvent || TERMINAL_STATES.includes(nextState)) {
          finish({ done: true, lastEvent: payload });
          return;
        }
        onProgress({ ...job });
      };

      es.addEventListener('progress', (evt) => {
        if (token.cancelled) return finishAbort();
        mergeAndNotify(parseEventData(evt), false);
      });

      es.addEventListener('done', (evt) => {
        if (token.cancelled) return finishAbort();
        mergeAndNotify(parseEventData(evt), true);
      });

      // 兼容部分未命名默认 message 事件流
      es.addEventListener('message', (evt) => {
        if (token.cancelled) return finishAbort();
        const data = parseEventData(evt);
        if (data && (data.status || data.state || data.phase)) {
          mergeAndNotify(data, TERMINAL_STATES.includes(data.status || data.state));
        }
      });

      es.addEventListener('error', () => {
        if (token.cancelled) return finishAbort();
        finish({ done: false, fallback: true });
      });
    });
  }

  async solve(request, { onProgress = () => {} } = {}) {
    this.cancel();
    const token = { cancelled: false, poll: new AbortController(), id: null, closeSse: null };
    this.current = token;
    let terminal = false;
    const check = () => {
      if (token.cancelled) throw new DOMException('本次计算已取消', 'AbortError');
    };
    try {
      // 提交请求本身不中断：确保拿到已接受 job.id，从而在晚到取消时通知服务端停算
      let job = await this.read('/api/v2/optimization-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createUuid() },
        body: JSON.stringify(request)
      });
      token.id = job.id;
      if (token.cancelled) await this.cancelJob(token);
      check();

      if (!TERMINAL_STATES.includes(job.state)) {
        // 优先尝试 SSE 实时推送；若环境不支持或流断开则自动平滑降级到轮询
        onProgress(job);
        const sseOutcome = await this.waitViaSse(job, token, onProgress);
        check();

        if (sseOutcome.done) {
          // 终态后拉取权威作业详情以获取完整 resultRef / message
          const latest = await this.read(`/api/v2/optimization-jobs/${encodeURIComponent(job.id)}`, {
            signal: token.poll.signal
          });
          job = { ...job, ...latest };
          check();
        }

        // 若 SSE 降级或尚未完全落定终态，继续原有轮询循环直至终态
        let firstPollAfterFallback = true;
        while (!TERMINAL_STATES.includes(job.state)) {
          if (!firstPollAfterFallback) {
            onProgress(job);
          }
          firstPollAfterFallback = false;
          await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
          check();
          job = await this.read(`/api/v2/optimization-jobs/${encodeURIComponent(job.id)}`, {
            signal: token.poll.signal
          });
          check();
        }
      }

      terminal = true;
      onProgress(job);
      if (!job.resultRef) throw new Error(job.message || '计算结束，未形成已验证结果');
      // 仅根据已认证的 job.id 构造本地结果路径，防止响应体重定向至外部地址
      const result = await this.read(`/api/v2/optimization-results/${encodeURIComponent(job.id)}`, {
        signal: token.poll.signal
      });
      check();
      return { job, result };
    } catch (error) {
      // 轮询/连接失败时主动取消远端已接受作业，避免孤儿算力泄漏
      if (token.id && !terminal) await this.cancelJob(token);
      throw error;
    } finally {
      if (token.closeSse) {
        try {
          token.closeSse();
        } catch {
          // 忽略关闭异常
        }
      }
      if (this.current === token) this.current = null;
    }
  }
}
