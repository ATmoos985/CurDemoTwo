/** Inventory facts and dimensions-only candidates are different sets. */
export function remnantAvailability(stocks, candidates, request) {
    const matching = stocks.filter(stock => stock.status === 'AVAILABLE' && stock.materialBatch === request.rollModel);
    const ids = new Set(candidates.filter(item => item.type === 'remnant').map(item => item.id));
    const fitting = matching.filter(stock => ids.has(stock.id));
    const pieces = request.demands.reduce((sum, demand) => sum + demand.demand, 0);
    return {total:stocks.length, matching:matching.length, fitting:fitting.length, pieces,
        message:!request.rollModel ? '填写需求型号后查看可用料头' : !pieces ? `同型号在库 ${matching.length} 块 · 当前没有剩余需求`
            : !matching.length ? '同型号暂无在库料头'
            : !fitting.length ? `同型号 ${matching.length} 块 · 尺寸或当前工艺不适合剩余需求`
            : `同型号 ${matching.length} 块 · ${fitting.length} 块可进一步试排`};
}
