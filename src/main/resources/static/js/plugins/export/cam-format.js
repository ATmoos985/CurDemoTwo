/**
 * 纯函数：数控 G-Code / DXF 文本生成与机台原点。不读全局状态、不访问 DOM，经典导出与新版界面共用。
 * data：{cuts, pieces, remnants, defects, rollId, rollW, bedL, windowStartY, cutOrigin}，坐标均为工位局部 mm。
 */

/** 机台原点：右/左 × 上/下；料头投料时 windowStartY 为 0。 */
export function homePoint({cutOrigin = 'right-bottom', width = 2000, length = 5000, windowStartY = 0} = {}) {
    const origin = String(cutOrigin || 'right-bottom');
    return {x: origin.startsWith('right') ? width || 2000 : 0, y: (windowStartY || 0) + (origin.endsWith('bottom') ? length || 5000 : 0)};
}

const cutEnds = c => {
    const isHoriz = c.type === '横切';
    return c.startX !== undefined && c.endX !== undefined
        ? [c.startX, c.startY, c.endX, c.endY]
        : [isHoriz ? c.start : c.pos, isHoriz ? c.pos : c.start, isHoriz ? c.end : c.pos, isHoriz ? c.pos : c.end];
};

/** 归一化轮廓顶点列表，去除连续重合及与起点重合的尾点，确保闭合轮廓至少 3 个有效顶点。 */
function normalizeContourPoints(rawPoints) {
    const pts = [];
    for (const pt of rawPoints || []) {
        const x = Array.isArray(pt) ? Number(pt[0]) : Number(pt?.x);
        const y = Array.isArray(pt) ? Number(pt[1]) : Number(pt?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const prev = pts[pts.length - 1];
        if (!prev || Math.hypot(x - prev.x, y - prev.y) > 1e-4) {
            pts.push({x, y});
        }
    }
    while (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-4) {
        pts.pop();
    }
    return pts.length >= 3 ? pts : [];
}

/** 从裁片对象提取工位局部 mm 坐标下的闭合轮廓顶点（兼容 shape.vertices、polygon 与标准矩形）。 */
function extractPieceContour(piece) {
    if (!piece || typeof piece !== 'object') return [];
    const ox = Number(piece.x) || 0;
    const oy = Number(piece.y) || 0;
    const w = Number(piece.shape?.width ?? piece.w ?? piece.width) || 0;
    const h = Number(piece.shape?.height ?? piece.l ?? piece.height) || 0;

    if (Array.isArray(piece.shape?.vertices) && piece.shape.vertices.length >= 3) {
        return normalizeContourPoints(
            piece.shape.vertices.map(v => ({
                x: ox + (Array.isArray(v) ? Number(v[0]) : Number(v?.x || 0)),
                y: oy + (Array.isArray(v) ? Number(v[1]) : Number(v?.y || 0))
            }))
        );
    }

    if (Array.isArray(piece.polygon) && piece.polygon.length >= 3) {
        const raw = normalizeContourPoints(piece.polygon);
        if (raw.length >= 3) {
            let applyOffset = piece.polygonRelative === true;
            if (piece.polygonRelative === undefined && (ox !== 0 || oy !== 0)) {
                const minX = Math.min(...raw.map(pt => pt.x));
                const minY = Math.min(...raw.map(pt => pt.y));
                const maxX = Math.max(...raw.map(pt => pt.x));
                const maxY = Math.max(...raw.map(pt => pt.y));
                if (w > 0 && h > 0 && minX >= -0.5 && minY >= -0.5 && maxX <= w + 0.5 && maxY <= h + 0.5) {
                    applyOffset = true;
                }
            }
            return applyOffset ? raw.map(pt => ({x: ox + pt.x, y: oy + pt.y})) : raw;
        }
    }

    if (w > 0 && h > 0) {
        return [
            {x: ox, y: oy},
            {x: ox + w, y: oy},
            {x: ox + w, y: oy + h},
            {x: ox, y: oy + h}
        ];
    }
    return [];
}

function buildContourOperations(data) {
    const rawList = Array.isArray(data.placements) && data.placements.length > 0
        ? data.placements
        : Array.isArray(data.pieces)
            ? data.pieces
            : [];
    const ops = [];
    for (let i = 0; i < rawList.length; i++) {
        const p = rawList[i];
        const points = extractPieceContour(p);
        if (points.length < 3) continue;
        let perimeter = 0;
        for (let k = 0; k < points.length; k++) {
            const a = points[k];
            const b = points[(k + 1) % points.length];
            perimeter += Math.hypot(b.x - a.x, b.y - a.y);
        }
        ops.push({
            index: ops.length + 1,
            label: p.name || `Piece #${p.id ?? i + 1}`,
            points,
            perimeter
        });
    }
    return ops;
}

export function gcodeText(data, {cutFeed = 4000, rapidFeed = 15000, plungeDelay = 200, retractDelay = 100, optimized = false, home, now = new Date()} = {}) {
    const cuts = data.cuts || [];
    const contourOps = cuts.length === 0 ? buildContourOperations(data) : [];
    const totalContourSteps = contourOps.reduce((sum, op) => sum + op.points.length, 0);
    const rollId = data.rollId || 'ROLL-2026-0920', rollW = data.rollW || 2000, bedL = data.bedL || 5000, winStartY = data.windowStartY || 0;
    const h = home || homePoint({cutOrigin: data.cutOrigin, width: rollW, length: bedL, windowStartY: winStartY});
    const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
    const g = [];
    g.push('(------------------------------------------------------------------)');
    g.push('( CAD/CAM FABRIC CUTTING PROGRAM - CNC G-CODE                      )');
    g.push(`( DATE CREATED  : ${dateStr}                              )`);
    g.push(`( MOTHER ROLL   : ${rollId} (Width: ${rollW} mm)                 )`);
    const mm = n => Math.round(n * 10) / 10; // 全局坐标累加会带浮点尾差，程序头只保留 0.1 mm
    g.push(`( BED STATION   : 0 ~ ${bedL} mm (Global Y: ${mm(winStartY)} ~ ${mm(winStartY + bedL)} mm) )`);
    g.push(`( ORIGIN DATUM  : ${data.cutOrigin || 'right-bottom'}                                  )`);
    if (cuts.length > 0 || contourOps.length === 0) {
        g.push(`( TOTAL CUTS    : ${cuts.length} STEPS                                   )`);
    } else {
        g.push(`( TOTAL CUTS    : ${contourOps.length} CONTOURS (${totalContourSteps} STEPS)                         )`);
    }
    g.push(`( OPTIMIZED     : ${optimized ? 'YES (Segment-TSP 2-Opt)' : 'NO (Sequential)'}            )`);
    g.push('( CONTROL TYPE  : 2D CUTTING - VERIFY MACHINE POSTPROCESSOR BEFORE USE )');
    g.push('(------------------------------------------------------------------)');
    g.push('');
    g.push('G21          (Metric Units: Millimeters)');
    g.push('G90          (Absolute Coordinate System)');
    g.push('G17          (XY Plane Selection)');
    g.push('G94          (Feed Rate: mm per minute)');
    g.push('M08          (Auxiliary: Bed Vacuum Absorption ON)');
    g.push('G04 P500     (Dwell 500ms for Vacuum Bed Stabilization)');
    g.push('');
    g.push('(--- INITIAL RAPID TO HOME POSITION ---)');
    g.push(`G00 X${h.x.toFixed(3)} Y${h.y.toFixed(3)} Z50.000 F${rapidFeed}`);
    g.push('');
    let lastX = h.x, lastY = h.y, totalCutDist = 0, totalAirDist = 0;
    if (cuts.length > 0) {
        for (const c of cuts) {
            const [startX, startY, endX, endY] = cutEnds(c);
            const airDist = Math.hypot(startX - lastX, startY - lastY), cutDist = Math.hypot(endX - startX, endY - startY);
            totalAirDist += airDist; totalCutDist += cutDist;
            g.push(`(--- STEP ${c.step}: ${c.type} L=${Math.round(cutDist)}mm | ${c.info || ''} ---)`);
            g.push(`G00 X${startX.toFixed(3)} Y${startY.toFixed(3)} Z10.000 (Rapid Air Move)`);
            g.push('M03 S1        (Tool Down / Laser ON)');
            g.push(`G04 P${plungeDelay}     (Plunge Dwell)`);
            g.push(`G01 X${endX.toFixed(3)} Y${endY.toFixed(3)} Z0.000 F${cutFeed} (Cutting Feed)`);
            g.push('M05          (Tool Up / Laser OFF)');
            g.push(`G04 P${retractDelay}     (Retract Dwell)`);
            g.push('');
            lastX = endX; lastY = endY;
        }
    } else if (contourOps.length > 0) {
        for (const op of contourOps) {
            const startPt = op.points[0];
            const airDist = Math.hypot(startPt.x - lastX, startPt.y - lastY);
            totalAirDist += airDist;
            g.push(`(--- CONTOUR ${op.index}: ${op.label} (${op.points.length} PTS, L=${Math.round(op.perimeter)}mm) ---)`);
            g.push(`G00 X${startPt.x.toFixed(3)} Y${startPt.y.toFixed(3)} Z10.000 (Rapid Air Move)`);
            g.push('M03 S1        (Tool Down / Laser ON)');
            g.push(`G04 P${plungeDelay}     (Plunge Dwell)`);
            let curX = startPt.x, curY = startPt.y;
            for (let k = 1; k <= op.points.length; k++) {
                const nextPt = op.points[k % op.points.length];
                totalCutDist += Math.hypot(nextPt.x - curX, nextPt.y - curY);
                g.push(`G01 X${nextPt.x.toFixed(3)} Y${nextPt.y.toFixed(3)} Z0.000 F${cutFeed} (Contour Cut)`);
                curX = nextPt.x; curY = nextPt.y;
            }
            g.push('M05          (Tool Up / Laser OFF)');
            g.push(`G04 P${retractDelay}     (Retract Dwell)`);
            g.push('');
            lastX = curX; lastY = curY;
        }
    }
    g.push('(--- RETURN TO HOME AND FINISH ---)');
    g.push(`G00 X${h.x.toFixed(3)} Y${h.y.toFixed(3)} Z50.000 F${rapidFeed}`);
    g.push('M09          (Vacuum Bed OFF)');
    g.push('M30          (End of Program / Rewind)');
    g.push(`(TOTAL CUT DISTANCE: ${Math.round(totalCutDist)} mm | TOTAL AIR DISTANCE: ${Math.round(totalAirDist)} mm)`);
    return g.join('\n');
}

/** AutoCAD R12 ASCII DXF：边界、裁片、料头、疵点（含避让外扩）、切割线、空走线六个图层。 */
export function dxfText(data, {home} = {}) {
    const rollW = data.rollW || 2000, bedL = data.bedL || 5000;
    const pieces = data.pieces || [], remnants = data.remnants || [], defects = data.globalDefects || data.defects || [], cuts = data.cuts || [];
    const h = home || homePoint({cutOrigin: data.cutOrigin, width: rollW, length: bedL, windowStartY: data.windowStartY});
    const dxf = [];
    dxf.push('0\nSECTION\n2\nHEADER');
    dxf.push('9\n$ACADVER\n1\nAC1009');
    dxf.push('9\n$INSUNITS\n70\n4');
    dxf.push('0\nENDSEC');
    dxf.push('0\nSECTION\n2\nTABLES');
    dxf.push('0\nTABLE\n2\nLAYER\n70\n6');
    for (const l of [{name: '0_FABRIC_BORDER', color: 7}, {name: '1_PIECES', color: 3}, {name: '2_REMNANTS', color: 4},
        {name: '3_DEFECTS', color: 1}, {name: '4_CUT_LINES', color: 6}, {name: '5_RAPID_TRAVERSE', color: 5}])
        dxf.push(`0\nLAYER\n2\n${l.name}\n70\n0\n62\n${l.color}\n6\nCONTINUOUS`);
    dxf.push('0\nENDTAB');
    dxf.push('0\nENDSEC');
    dxf.push('0\nSECTION\n2\nENTITIES');
    const addLine = (layer, x1, y1, x2, y2) => dxf.push(`0\nLINE\n8\n${layer}\n10\n${x1.toFixed(3)}\n20\n${y1.toFixed(3)}\n30\n0.0\n11\n${x2.toFixed(3)}\n21\n${y2.toFixed(3)}\n31\n0.0`);
    const addRect = (layer, x1, y1, x2, y2) => { addLine(layer, x1, y1, x2, y1); addLine(layer, x2, y1, x2, y2); addLine(layer, x2, y2, x1, y2); addLine(layer, x1, y2, x1, y1); };
    const addText = (layer, x, y, height, text) => dxf.push(`0\nTEXT\n8\n${layer}\n10\n${x.toFixed(3)}\n20\n${y.toFixed(3)}\n30\n0.0\n40\n${height.toFixed(1)}\n1\n${text}`);
    addRect('0_FABRIC_BORDER', 0, 0, rollW, bedL);
    addText('0_FABRIC_BORDER', 20, 20, 40, `BED STATION: ${rollW}x${bedL}mm`);
    for (const p of pieces) {
        if (p.shape?.type === 'POLYGON') p.shape.vertices.forEach((v, i) => { const n = p.shape.vertices[(i + 1) % p.shape.vertices.length]; addLine('1_PIECES', p.x + v.x, p.y + v.y, p.x + n.x, p.y + n.y); });
        else addRect('1_PIECES', p.x, p.y, p.x + p.w, p.y + p.l);
        addText('1_PIECES', p.x + 15, p.y + p.l / 2 - 10, 30, `${p.name || 'Piece'}`);
        addText('1_PIECES', p.x + 15, p.y + p.l / 2 + 30, 24, `${p.w}x${p.l}mm`);
    }
    for (const r of remnants) {
        addRect('2_REMNANTS', r.x, r.y, r.x + r.w, r.y + r.l);
        addText('2_REMNANTS', r.x + 15, r.y + 35, 26, `REMNANT: ${r.id}`);
        addText('2_REMNANTS', r.x + 15, r.y + 70, 20, `${r.w}x${r.l}mm`);
    }
    for (const d of defects) {
        addRect('3_DEFECTS', d.x, d.y, d.x + d.w, d.y + d.h);
        const m = d.margin !== undefined ? d.margin : 20;
        addRect('3_DEFECTS', d.x - m, d.y - m, d.x + d.w + m, d.y + d.h + m);
        addText('3_DEFECTS', d.x, Math.max(10, d.y - 10), 20, `DEFECT #${d.id} (${d.desc || 'Flaw'})`);
    }
    let lastX = h.x, lastY = h.y;
    for (const c of cuts) {
        const [startX, startY, endX, endY] = cutEnds(c);
        addLine('5_RAPID_TRAVERSE', lastX, lastY, startX, startY);
        addLine('4_CUT_LINES', startX, startY, endX, endY);
        addText('4_CUT_LINES', startX + 5, startY + 5, 20, `CUT #${c.step}`);
        lastX = endX; lastY = endY;
    }
    dxf.push('0\nENDSEC');
    dxf.push('0\nEOF');
    return dxf.join('\n');
}
