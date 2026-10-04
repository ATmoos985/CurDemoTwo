import { createNestingScene } from './nesting-scene.js';

/** Input revisions own results. Late responses can never replace a newer input. */
export class NestingSession {
    constructor(fetchImpl = (...args) => globalThis.fetch(...args)) { this.fetch = fetchImpl; this.revision = 0; this.result = null; }
    setProblem(problem) {
        const scene = createNestingScene(problem);
        this.controller?.abort(); this.controller = null;
        this.problem = structuredClone(problem); this.result = null; this.revision++;
        return scene;
    }
    invalidate() { this.controller?.abort(); this.controller = null; this.result = null; this.revision++; }
    async solve() {
        this.controller?.abort();
        const controller = new AbortController(); this.controller = controller;
        const revision = ++this.revision, problem = structuredClone(this.problem);
        this.result = null;
        try {
            const response = await this.fetch('/api/v1/nesting/solve', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(problem), signal: controller.signal });
            const result = await response.json();
            if (revision !== this.revision) return null;
            if (!response.ok) throw new Error(result.message || `求解失败（${response.status}）`);
            const scene = createNestingScene(problem, result);
            this.result = result;
            return scene;
        } catch (error) {
            if (revision !== this.revision) return null;
            throw error;
        } finally { if (this.controller === controller) this.controller = null; }
    }
}
