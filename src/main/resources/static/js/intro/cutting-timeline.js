export const CUT_PATHS = {
    sheet:[[48,218,592,218],[264,62,264,218],[428,62,428,218],[218,218,218,348],[376,218,376,348],[526,218,526,348]],
    strip:[[190,62,190,348],[292,62,292,348],[380,62,380,348],[516,62,516,348]]
};
export const CYCLE_MS = 6500;
export const COMPLETED_MS = 2700;
export function cuttingFrame(time, mode = 'sheet') {
    const paths = CUT_PATHS[mode], t = ((time % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
    const ramp = (start, duration) => Math.max(0, Math.min(1, (t - start) / duration));
    // Presentation groups: crosscut first, then the remaining edges together.
    const progress = paths.map((_, index) => mode === 'sheet'
        ? index === 0 ? ramp(800, 800) : ramp(1600, 1000)
        : ramp(800, 1800));
    const complete = progress.filter(value => value === 1).length;
    const separation = ramp(2800, 600);
    const assembly = 1 - ramp(0, 600);
    return {paths, complete, progress, offset:assembly || separation,
        phase:t < 800 ? '排料' : complete < paths.length ? '切割' : t < 2800 ? '刀路完成' : '裁片分离'};
}
