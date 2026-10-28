// 通用母卷相机：世界坐标 u = 沿卷长（mm），v = 幅宽方向（mm）。
// 屏幕方向只是映射：横向 x=a+u·s, y=c+v·s；竖向 x=c+v·s, y=a+u·s。
// cam = {s: 像素/mm, a: 卷长轴偏移, c: 幅宽轴偏移}。

/** 96 dpi 下 1 CSS 像素对应的毫米数，用于把屏幕比例换算成真实 1:N。 */
export const DEFAULT_MM_PER_PX = 25.4 / 96;

export function toScreen(cam, vertical, u, v) {
    const a = cam.a + u * cam.s, c = cam.c + v * cam.s;
    return vertical ? [c, a] : [a, c];
}

export function toWorld(cam, vertical, x, y) {
    const [a, c] = vertical ? [y, x] : [x, y];
    return [(a - cam.a) / cam.s, (c - cam.c) / cam.s];
}

/** 屏幕矩形；世界矩形从 (u,v) 起，沿卷长 du、沿幅宽 dv。 */
export function screenRect(cam, vertical, u, v, du, dv) {
    const [x, y] = toScreen(cam, vertical, u, v);
    return vertical ? {x, y, w: dv * cam.s, h: du * cam.s} : {x, y, w: du * cam.s, h: dv * cam.s};
}

/** 让世界范围 [u0,u1]×[v0,v1] 居中充满视口（扣除留白）。 */
export function fitCamera({u0, u1, v0, v1}, {width, height}, vertical, pad = {}) {
    const {start = 0, end = 0, near = 0, far = 0} = pad;
    const along = (vertical ? height : width) - start - end;
    const across = (vertical ? width : height) - near - far;
    const s = Math.max(1e-9, Math.min(along / Math.max(1, u1 - u0), across / Math.max(1, v1 - v0)));
    return {
        s,
        a: start + (along - (u1 - u0) * s) / 2 - u0 * s,
        c: near + (across - (v1 - v0) * s) / 2 - v0 * s
    };
}

/** 以屏幕点为中心缩放，缩放倍数限制在 [min,max] 像素/mm。 */
export function zoomAt(cam, vertical, x, y, factor, min = 1e-4, max = 8) {
    const s = Math.max(min, Math.min(max, cam.s * factor)), f = s / cam.s;
    const [a, c] = vertical ? [y, x] : [x, y];
    return {...cam, s, a: a - (a - cam.a) * f, c: c - (c - cam.c) * f};
}

export function panBy(cam, vertical, dx, dy) {
    const [da, dc] = vertical ? [dy, dx] : [dx, dy];
    return {...cam, a: cam.a + da, c: cam.c + dc};
}

/** 屏幕比例 1:N 中的 N（真实毫米 / 屏幕毫米）。 */
export function ratioOf(s, mmPerPx = DEFAULT_MM_PER_PX) {
    return 1 / (s * mmPerPx);
}

export function scaleForRatio(n, mmPerPx = DEFAULT_MM_PER_PX) {
    if (!(n > 0)) throw new Error('比例须为正数');
    return 1 / (n * mmPerPx);
}

/** 解析 “1:20”“1：20”“20”。无效返回 null。 */
export function parseRatio(text) {
    const m = String(text ?? '').trim().match(/^(?:1\s*[:：]\s*)?(\d+(?:\.\d+)?)$/);
    const n = m ? Number(m[1]) : NaN;
    return n > 0 ? n : null;
}

export function formatRatio(n) {
    return '1:' + (n >= 10 ? Math.round(n) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
}

/** 标尺刻度步长（世界单位），保证相邻刻度至少相隔 minPx 像素。 */
export function rulerStep(s, minPx = 70) {
    const d = minPx / s, mag = 10 ** Math.floor(Math.log10(d));
    return [1, 2, 5, 10].find(n => n * mag >= d) * mag;
}
