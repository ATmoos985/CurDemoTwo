import { sceneOrigin } from './nesting-scene.js';

/** Shared geometric drawing. Completion styling and interactions are supplied by the host. */
export function renderNestingGeometry(Konva, groups, scene, options = {}) {
    const { material, region, process } = scene;
    const { dark = false, overlay = {}, stepLimit = Infinity, optimized = false } = options;
    const { background, exclusions, leftovers, placements, cuts, boundary } = groups;
    for (const group of Object.values(groups)) group.destroyChildren();
    const width = material.shape.width, height = material.shape.height;
    const start = region.y, end = start + region.shape.height;
    background.add(new Konva.Rect({ width, height, fill: dark ? '#19232e' : '#ffffff',
        stroke: dark ? '#607183' : '#a8b5c1', strokeWidth: 1, strokeScaleEnabled: false }));
    // Limit subdivisions for large materials; this grid has no geometric meaning.
    const grid = Math.max(1000, Math.ceil(height / 200000) * 1000);
    for (let y = grid; y < height; y += grid) background.add(new Konva.Line({
        points: [0, y, width, y], stroke: dark ? '#2c3947' : '#e7edf1',
        strokeWidth: 1, strokeScaleEnabled: false, listening: false }));
    if (overlay.completedLength > 0) {
        const y = overlay.completedLength;
        background.add(new Konva.Rect({ width, height: y, fill: dark ? '#293442' : '#e9edf0', opacity: .65, listening: false }));
        background.add(new Konva.Line({ points: [0, y, width, y], stroke: '#bc8b39',
            strokeWidth: 1.5, strokeScaleEnabled: false, dash: [8, 5], listening: false }));
    }
    for (const d of scene.exclusions) {
        const group = new Konva.Group(), margin = d.clearance ?? 0;
        const { width: w, height: h } = d.shape;
        const active = d.y + h >= start && d.y <= end, upcoming = d.y > end;
        group.add(new Konva.Rect({ name: `defect-zone-${d.id}`, x: d.x - margin, y: d.y - margin,
            width: w + margin * 2, height: h + margin * 2,
            fill: active ? '#dc26261a' : '#d977061a', stroke: active ? '#b94e4e' : '#bd873a',
            strokeWidth: 1, strokeScaleEnabled: false, dash: [6, 4], visible: active || upcoming }));
        group.add(new Konva.Rect({ name: `defect-box-${d.id}`, x: d.x, y: d.y, width: w, height: h,
            fill: active ? '#c45e5e' : (upcoming ? '#c79750' : '#94a3b8'), stroke: '#9f4848', strokeWidth: 1, strokeScaleEnabled: false }));
        for (const points of [[d.x, d.y, d.x + w, d.y + h], [d.x + w, d.y, d.x, d.y + h]])
            group.add(new Konva.Line({ points, stroke: '#ffffff', strokeWidth: 1, strokeScaleEnabled: false, listening: false }));
        exclusions.add(group);
    }
    for (const r of scene.leftovers) {
        const group = new Konva.Group({ name: `remnant-entity-${r.id}` });
        group.add(new Konva.Rect({ x: r.x, y: r.y, width: r.shape.width, height: r.shape.height,
            fill: r.hasDefect ? (dark ? '#453c2d' : '#faf2e4') : (dark ? '#303b45' : '#f0f3f5'),
            stroke: r.hasDefect ? '#b68d48' : '#8b9ba7', strokeWidth: 1, strokeScaleEnabled: false, dash: [6, 4] }));
        options.onLeftover?.(group, r);
        leftovers.add(group);
    }
    for (const p of scene.placements) {
        const completed = overlay.completedIds?.has(p.id);
        const group = new Konva.Group({ x: p.x, y: p.y, name: `piece-entity-${p.id}` });
        group.add(new Konva.Rect({ width: p.shape.width, height: p.shape.height,
            fill: completed ? (dark ? '#293442' : '#e9edf0') : (dark ? '#304d5a' : '#e2edf2'),
            stroke: completed ? '#94a3b8' : '#62899b', strokeWidth: 1, strokeScaleEnabled: false, dash: completed ? [5, 4] : [] }));
        options.onPlacement?.(group, p);
        placements.add(group);
    }
    const home = options.home || sceneOrigin(scene);
    let lastX = home.x, lastY = home.y;
    const badges = [];
    for (const c of scene.cuts) {
        if (c.sequence > stepLimit) continue;
        const { startX: x1, startY: y1, endX: x2, endY: y2 } = c;
        if (optimized && Math.hypot(x1 - lastX, y1 - lastY) > 1) cuts.add(new Konva.Line({
            points: [lastX, lastY, x1, y1], stroke: '#739eaf', strokeWidth: 1, strokeScaleEnabled: false, dash: [5, 5], listening: false }));
        cuts.add(new Konva.Line({ points: [x1, y1, x2, y2], stroke: '#b96070',
            strokeWidth: 1.5, strokeScaleEnabled: false, dash: optimized ? [] : [7, 5], listening: false }));
        badges.push({ x: x1, y: y1, x2, y2, step: c.sequence });
        lastX = x2; lastY = y2;
    }
    cuts.visible(options.showPaths !== false);
    boundary.add(new Konva.Rect({ width: region.shape.width, height: region.shape.height,
        stroke: '#c45656', strokeWidth: 1.5, strokeScaleEnabled: false }));
    if (process.trimStart > 0) boundary.add(new Konva.Rect({
        y: (process.startCorner || 'right-bottom').endsWith('bottom') ? region.shape.height - process.trimStart : 0,
        width: region.shape.width, height: process.trimStart, fill: '#d5ac6130', stroke: '#b68d48',
        strokeWidth: 1, strokeScaleEnabled: false, dash: [6, 4] }));
    boundary.position({ x: region.x, y: region.y });
    boundary.listening(false);
    return badges;
}
