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

export function defectFromCenter(point, w, h, margin, data) {
    if (![point.x, point.y, w, h, margin].every(Number.isFinite) || w <= 0 || h <= 0 || margin < 0)
        throw new Error('请填写有效的疵点尺寸和避让间距。');
    const x = Number((point.x - w / 2).toFixed(3)), y = Number((point.y - h / 2).toFixed(3));
    if (x < 0 || y < 0 || x + w > data.rollW || y + h > data.totalRollL)
        throw new Error('疵点范围超出母卷，请缩小尺寸或取消后重新标记。');
    return {x, y, w, h, margin};
}

export function rulerOrigin(data, overview = false) {
    return overview ? { x: 0, y: 0, dx: 1, dy: 1 } : stationOrigin(data);
}

export function labelDetail(width, height, scale, overview = false) {
    if (overview || width * scale < 64 || height * scale < 26) return 0;
    return width * scale >= 124 && height * scale >= 56 ? 2 : 1;
}

// 单个数字作格键；|cy| < 2^19 格时不冲突（1 m 格约 500 km）。
const cellKey = (cx, cy) => cx * 1048576 + cy;

/** 均匀网格分桶：query 返回所在格与查询框相交的条目序号（去重、升序），调用方再按屏幕框精确判断。 */
export function gridIndex(rects, size) {
    const cells = new Map(), seen = new Uint32Array(rects.length);
    let stamp = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    rects.forEach((r, i) => {
        const x0 = Math.floor(r.x / size), x1 = Math.floor((r.x + r.w) / size);
        const y0 = Math.floor(r.y / size), y1 = Math.floor((r.y + r.h) / size);
        if (![x0, x1, y0, y1].every(Number.isFinite) || x0 > x1 || y0 > y1) return;
        minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
            const list = cells.get(cellKey(cx, cy));
            if (list) list.push(i); else cells.set(cellKey(cx, cy), [i]);
        }
    });
    return {
        query(x0, y0, x1, y1) {
            const found = [];
            stamp++;
            for (let cx = Math.max(minX, Math.floor(x0 / size)); cx <= Math.min(maxX, Math.floor(x1 / size)); cx++)
                for (let cy = Math.max(minY, Math.floor(y0 / size)); cy <= Math.min(maxY, Math.floor(y1 / size)); cy++)
                    for (const i of cells.get(cellKey(cx, cy)) || []) if (seen[i] !== stamp) { seen[i] = stamp; found.push(i); }
            return found.sort((a, b) => a - b);
        }
    };
}

/** 按输入顺序贪心保留与已保留点相距不小于 distance 的点；只查相邻 3×3 格。 */
export function spacedPoints(points, distance) {
    const cells = new Map(), kept = [];
    for (const point of points) {
        const cx = Math.floor(point.x / distance), cy = Math.floor(point.y / distance);
        if (!Number.isFinite(cx + cy)) { kept.push(point); continue; }
        let near = false;
        for (let i = cx - 1; i <= cx + 1 && !near; i++) for (let j = cy - 1; j <= cy + 1 && !near; j++)
            near = (cells.get(cellKey(i, j)) || []).some(q => Math.hypot(point.x - q.x, point.y - q.y) < distance);
        if (near) continue;
        kept.push(point);
        const list = cells.get(cellKey(cx, cy));
        if (list) list.push(point); else cells.set(cellKey(cx, cy), [point]);
    }
    return kept;
}
