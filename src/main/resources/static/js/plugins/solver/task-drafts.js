const PREFIX = 'cutting-demand-draft:';

/** One record per editing session: retaining another task never overwrites it. */
export function createDraftStore(storage) {
    const read = id => {
        let value;
        try { value = JSON.parse(storage.getItem(PREFIX + id)); } catch { return null; }
        return value?.version === 1 && value.id === id && typeof value.task?.name === 'string'
            && Array.isArray(value.task.demands) ? value : null;
    };
    return {
        read,
        write: draft => storage.setItem(PREFIX + draft.id, JSON.stringify(draft)),
        remove: id => { if (id) storage.removeItem(PREFIX + id); },
        list() {
            const records = [];
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key?.startsWith(PREFIX)) {
                    const draft = read(key.slice(PREFIX.length));
                    if (draft) records.push(draft);
                }
            }
            return records.sort((a,b) => b.updatedAt - a.updatedAt);
        }
    };
}
