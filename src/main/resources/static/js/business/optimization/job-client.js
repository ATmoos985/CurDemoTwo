/** Standard job transport. Cancellation also covers a submit response arriving after the UI changed. */
export class OptimizationSession {
    constructor(fetchImpl = (...args) => globalThis.fetch(...args), intervalMs = 150, onCancellationError = () => {}) {
        this.fetch = fetchImpl; this.intervalMs = intervalMs; this.current = null; this.onCancellationError = onCancellationError;
    }
    async read(path, options = {}) {
        const response = await this.fetch(path, options);
        const value = await response.json();
        if (!response.ok) throw new Error(value.message || `计算服务请求失败（${response.status}）`);
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
                headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},
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
