const clone = value => JSON.parse(JSON.stringify(value));

export function planScene(data) {
    return clone({pieces:data.pieces || [], remnants:data.remnants || [], cuts:data.cuts || [], cutIntervals:data.cutIntervals || []});
}

/** History belongs to one saved plan; solving or accepting a new version starts a new history. */
export function createPlanHistory(initial) {
    let current = clone(initial);
    const past = [], future = [];
    return {
        get current() { return clone(current); },
        get canUndo() { return past.length > 0; },
        get canRedo() { return future.length > 0; },
        record(scene) {
            if (JSON.stringify(scene) === JSON.stringify(current)) return false;
            past.push(current); if (past.length > 50) past.shift();
            current = clone(scene); future.length = 0; return true;
        },
        undo() { if (!past.length) return null; future.push(current); current = past.pop(); return clone(current); },
        redo() { if (!future.length) return null; past.push(current); current = future.pop(); return clone(current); }
    };
}
