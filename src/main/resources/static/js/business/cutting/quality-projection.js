// 纯读模型：原始报工不变，复检事件只影响当前产出与可处置范围。
export function reviewablePieces(report) {
    if (report.status === 'REVERSED') return [];
    const disposed = new Set((report.qualityDispositions || []).map(e => e.command.pieceId));
    return (report.pieceResults || []).filter(p => ['QUALIFIED','REJECTED'].includes(p.outcome) && !disposed.has(p.pieceId));
}
export function effectivePieceResults(report) {
    const events = new Map((report.qualityDispositions || []).map(e => [e.command.pieceId,e]));
    return (report.pieceResults || []).map(p => {
        const e = events.get(p.pieceId);
        return e ? {...p,outcome:'REJECTED',reason:`复检${e.command.disposition === 'REMNANT' ? '转料头' : '报废'}：${e.command.reason}`} : {...p};
    });
}
