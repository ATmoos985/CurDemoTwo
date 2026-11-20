import {createUuid} from '../../core/uuid.js';

/** Standard job transport. Cancellation also covers a submit response arriving after the UI changed. */
export class OptimizationSession {
    constructor(fetchImpl = (...args) => globalThis.fetch(...args), intervalMs = 150, onCancellationError = () => {}) {
        this.fetch = fetchImpl; this.intervalMs = intervalMs; this.current = null; this.onCancellationError = onCancellationError;
    }
    async read(path, options = {}) {
        const fetchOptions = !options.method || options.method === 'GET'
            ? {cache: 'no-store', ...options}
            : options;
        const response = await this.fetch(path, fetchOptions);
        let value = null;
        try {
            value = await response.json();
        } catch {
            value = null;
        }
        if (!response.ok) {
            const status = response.status;
            const fallbackMsg = status === 401 || status === 403
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
        token.cancelled = true; token.poll.abort();
        return this.cancelJob(token);
    }
    cancelJob(token) {
        if (!token.id || token.cancelPromise) return token.cancelPromise || Promise.resolve();
        token.cancelPromise = this.read(`/api/v2/optimization-jobs/${encodeURIComponent(token.id)}/cancellations`,
            {method:'POST', keepalive:true}).catch(error => {
                token.cancelError = error;
                if (!this.current || this.current === token) this.onCancellationError(error);
            });
        return token.cancelPromise;
    }
    async solve(request, {onProgress = () => {}} = {}) {
        this.cancel();
        const token = {cancelled:false, poll:new AbortController(), id:null};
        this.current = token;
        let terminal = false;
        const check = () => { if (token.cancelled) throw new DOMException('本次计算已取消', 'AbortError'); };
        try {
            // Do not abort submission: receiving the accepted id allows late cancellation to stop server work.
            let job = await this.read('/api/v2/optimization-jobs', {method:'POST',
                headers:{'Content-Type':'application/json','Idempotency-Key':createUuid()},
                body:JSON.stringify(request)});
            token.id = job.id;
            if (token.cancelled) await this.cancelJob(token);
            check();
            while (!['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(job.state)) {
                onProgress(job);
                await new Promise(resolve => setTimeout(resolve, this.intervalMs));
                check();
                job = await this.read(`/api/v2/optimization-jobs/${encodeURIComponent(job.id)}`, {signal:token.poll.signal});
                check();
            }
            terminal = true;
            onProgress(job);
            if (!job.resultRef) throw new Error(job.message || '计算结束，未形成已验证结果');
            // Derive local route from id; a response cannot redirect authenticated reads elsewhere.
            const result = await this.read(`/api/v2/optimization-results/${encodeURIComponent(job.id)}`, {signal:token.poll.signal});
            check();
            return {job, result};
        } catch (error) {
            // Losing the polling connection must not orphan accepted work when a new run begins.
            if (token.id && !terminal) await this.cancelJob(token);
            throw error;
        } finally { if (this.current === token) this.current = null; }
    }
}
