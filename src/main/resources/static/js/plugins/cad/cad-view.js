// 画布显示换算。模型始终使用 mm，留白与标注始终使用屏幕像素。
export const RULER_SIZE = 28;
export const canvasView = { overview: false, dimensions: true, paths: true };

export function fitBounds(width, height, bounds) {
    const left = RULER_SIZE + 62, right = 30;
    const top = RULER_SIZE + 54, bottom = 88;
    const availableW = Math.max(1, width - left - right);
    const availableH = Math.max(1, height - top - bottom);
    const scale = Math.min(availableW / bounds.width, availableH / bounds.height, 1);
    return {
        scale,
        x: left + (availableW - bounds.width * scale) / 2 - bounds.x * scale,
        y: top + (availableH - bounds.height * scale) / 2 - bounds.y * scale
    };
}

export function rulerStep(scale) {
    const desired = 80 / scale;
    const magnitude = 10 ** Math.floor(Math.log10(desired));
    return [1, 2, 5, 10].find(n => n * magnitude >= desired) * magnitude;
}

export function stationOrigin(data) {
    const origin = (data.cutOrigin || 'right-bottom').toLowerCase();
    const right = origin.startsWith('right'), bottom = origin.endsWith('bottom');
    const trim = data.trimStart || 0;
    return {
        x: right ? data.rollW : 0,
        y: (data.windowStartY || 0) + (bottom ? data.bedL - trim : trim),
        dx: right ? -1 : 1, dy: bottom ? -1 : 1,
        label: `${right ? '右' : '左'}${bottom ? '下' : '上'}`
    };
}

export function stationCoordinates(x, y, data) {
    const origin = stationOrigin(data);
    return { x: (x - origin.x) * origin.dx, y: (y - origin.y) * origin.dy };
}

export function rulerOrigin(data, overview = false) {
    return overview ? { x: 0, y: 0, dx: 1, dy: 1 } : stationOrigin(data);
}

export function labelDetail(width, height, scale, overview = false) {
    if (overview || width * scale < 64 || height * scale < 26) return 0;
    return width * scale >= 124 && height * scale >= 56 ? 2 : 1;
}
