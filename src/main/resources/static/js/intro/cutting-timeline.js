export const CUT_PATHS = {
    sheet:[[48,218,592,218],[264,62,264,218],[428,62,428,218],[218,218,218,348],[376,218,376,348],[526,218,526,348]],
    strip:[[190,62,190,348],[292,62,292,348],[380,62,380,348],[516,62,516,348]]
};
export const CYCLE_MS = 16000;
export function cuttingFrame(time, mode = 'sheet') {
    const paths = CUT_PATHS[mode], t = ((time % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
    const progress = Math.max(0, Math.min(paths.length, (t - 2400) / (9000 / paths.length)));
    const complete = Math.floor(progress);
    const separation = t < 12200 ? 0 : Math.min(1, (t - 12200) / 1200);
    const assembly = t < 1400 ? 1 - Math.min(1, t / 1400) : 0;
    return {paths, complete, progress, offset:assembly || separation,
        phase:t < 2400 ? '排料' : complete < paths.length ? '切割' : t < 12200 ? '刀路完成' : '裁片分离'};
}
