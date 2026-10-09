export function expectedRemnants(data) {
    return (data.remnants || []).filter(r => !r.confirmed && !r.queued);
}

export function motherRollRemnants(stocks, rollId) {
    return rollId ? stocks.filter(r => r.sourceRollId === rollId) : [];
}
