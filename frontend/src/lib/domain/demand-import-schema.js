/**
 * 生产级需求导入 Schema 识别、中英文别名映射、单位换算、1D 分切校验、BOM 展开及精确行级错误构造模块。
 * 纯 JS 叶子模块，零外部依赖。
 */

export const textVal = value => String(value ?? '').trim();
export const isPositiveNum = value =>
    ['number', 'string'].includes(typeof value) &&
    textVal(value) !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0;

export const UNIT_FACTORS = Object.freeze({
    mm: 1,
    cm: 10,
    m: 1000,
    inch: 25.4,
    in: 25.4,
    ft: 304.8
});

export const FIELD_ALIASES = Object.freeze({
    materialModel: ['材料型号', '面料型号', '型号', '物料编码', '物料型号', '料号', '面料编号', '材料', 'materialmodel', 'material', 'sku', 'itemcode', 'materialcode', 'fabricmodel'],
    fabricCode: ['布料编号', '色号', '花型编号', 'fabriccode', 'colorcode', 'swatch'],
    name: ['裁片名称', '零件名称', '部位名称', '名称', '部件名称', '裁片', '规格名称', 'partname', 'piecename', 'name', 'part', 'componentname', 'description'],
    width: ['宽度', '宽', '门幅', '幅宽', '片宽', '裁片宽', '分切宽度', '分切宽', '条宽', 'width', 'w', 'widthmm', 'cutwidth', 'slitwidth', 'slittingwidth', 'stripwidth'],
    length: ['长度', '长', '定长', '片长', '裁片长', '分切长度', '分切长', '高度', '高', 'length', 'l', 'height', 'h', 'lengthmm', 'cutlength', 'slitlength', 'slittinglength', 'fixedlength'],
    quantity: ['数量', '件数', '套数', '需求数', '订单数量', '用量数量', 'qty', 'quantity', 'count', 'pcs'],
    allowRotation: ['允许旋转', '旋转', '可旋转', '是否旋转', '旋转90度', 'allowrotation', 'rotation', 'rotatable'],
    unit: ['单位', '尺寸单位', '计量单位', 'unit', 'uom'],
    order: ['订单号', '订单编号', '工单号', '排产单号', 'orderno', 'order', 'orderid', 'so', 'salesorder'],
    productType: ['产品类型', '排产类型', '维度', '类型', '工艺类型', 'producttype', 'dimension', 'type', 'mode'],
    surfaceTreatment: ['表面处理', '表面工艺', '工艺要求', '涂装', '处理方式', 'surfacetreatment', 'surface', 'finish', 'coating'],
    bomParent: ['父件编码', '父项编码', '父级物料', '父件', '上级编码', '成品编码', 'parent', 'parentcode', 'parentsku', 'assembly'],
    bomChild: ['子件编码', '子项编码', '子级物料', '子件', '下级编码', '组件编码', 'child', 'childcode', 'childsku', 'component'],
    bomUsage: ['单耗', '用量', '单位用量', 'bom用量', '配比', '系数', 'usage', 'qtyper', 'unitqty', 'bomqty', 'ratio'],
    bomLevel: ['层级', 'bom层级', '阶层', 'level', 'bomlevel'],
    note: ['备注', '说明', '工艺备注', 'note', 'remark', 'remarks', 'comment']
});

export function normalizeUnit(rawUnit, fallback = 'mm') {
    const s = textVal(rawUnit).toLowerCase();
    if (!s) return fallback;
    if (s === 'mm' || s === '毫米') return 'mm';
    if (s === 'cm' || s === '厘米' || s === '公分') return 'cm';
    if (s === 'm' || s === '米') return 'm';
    if (s === 'in' || s === 'inch' || s === 'inches' || s === '英寸' || s === '"') return 'inch';
    if (s === 'ft' || s === 'feet' || s === '英尺') return 'ft';
    return fallback;
}

export function convertToRawMm(value, unit = 'mm') {
    const factor = UNIT_FACTORS[normalizeUnit(unit, 'mm')] ?? 1;
    return Number(value) * factor;
}

export function convertToMm(value, unit = 'mm') {
    const raw = convertToRawMm(value, unit);
    const q = Math.round(raw * 10) / 10;
    return Object.is(q, -0) ? 0 : q;
}

const HEADER_UNIT_TOKEN = '(?:mm|cm|m|inch|in|ft|毫米|厘米|公分|英寸|英尺|米)';
const BRACKET_UNIT_RE = new RegExp(`[(（\\[【]\\s*(?:in\\s+)?(${HEADER_UNIT_TOKEN})\\s*[)）\\]】]`, 'i');
const SUFFIX_UNIT_RE = new RegExp(`(?:[\\s_-]+in[\\s_-]+|_)\\s*(${HEADER_UNIT_TOKEN})\\s*$`, 'i');

const SLIT_ONLY_WIDTH_KEYS = new Set(['条宽', '分切宽度', '分切宽', 'slitwidth', 'slittingwidth', 'stripwidth']);
const SLIT_ONLY_LENGTH_KEYS = new Set(['分切长度', '分切长', 'slitlength', 'slittinglength']);
const ROLL_OR_SLIT_WIDTH_KEYS = new Set(['幅宽', '条宽', '分切宽度', '分切宽', 'slitwidth', 'slittingwidth', 'stripwidth']);
const FIXED_OR_SLIT_LENGTH_KEYS = new Set(['定长', '分切长度', '分切长', 'cutlength', 'slitlength', 'slittinglength', 'fixedlength']);
const EXPLICIT_1D_HEADER_RE = /(?:^|[^a-z0-9])1d(?:[^a-z0-9]|$)|分切|slitting|slit[_\s-]*width|slit[_\s-]*length|条宽|strip[_\s-]*width/i;

/** 从列名中提取纯净别名键与内嵌单位（如 `宽度(cm)` -> `{ key: '宽度', unit: 'cm' }`） */
export function parseHeaderColumn(headerCell) {
    const raw = textVal(headerCell);
    if (!raw) return { raw: '', key: '', unit: null };
    let unit = null;
    const bracketMatch = raw.match(BRACKET_UNIT_RE);
    if (bracketMatch) {
        unit = normalizeUnit(bracketMatch[1], null);
    }
    const withoutBrackets = raw.replace(/[(（\[【][^()（）\[\]【】]*[)）\]】]/g, '').trim();
    const suffixMatch = withoutBrackets.match(SUFFIX_UNIT_RE);
    if (!unit && suffixMatch) {
        unit = normalizeUnit(suffixMatch[1], null);
    }
    const stripped = withoutBrackets
        .replace(SUFFIX_UNIT_RE, '')
        .replace(/[\s_\-:：/]+/g, '')
        .toLowerCase();
    return { raw, key: stripped, unit };
}

function matchFieldByHeader(parsed) {
    if (!parsed.key) return null;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
        if (aliases.includes(parsed.key)) {
            return field;
        }
    }
    return null;
}

export function columnIndexToLabel(index) {
    let n = index + 1;
    let label = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        label = String.fromCharCode(65 + rem) + label;
        n = Math.floor((n - 1) / 26);
    }
    return label || 'A';
}

/** 构造兼容旧字段 `{ row, model, message, line }` 与新行号级字段 `{ rowIndex, sheetName, column, field, reason, code }` 的错误对象 */
export function createImportIssue({
    rowIndex,
    sheetName = 'Sheet1',
    column = '',
    field = '',
    model = '',
    reason,
    code = 'VALIDATION_ERROR',
    line = null
}) {
    return {
        row: rowIndex,
        rowIndex,
        sheetName,
        column: column || field || '未知列',
        field,
        model: textVal(model),
        message: reason,
        reason,
        code,
        line
    };
}

/** 判断一行是否为 9.28 窗帘订单表头 */
export function isCurtainHeaderRow(row) {
    if (!Array.isArray(row)) return false;
    return (
        textVal(row[2]).replace(/\s/g, '') === '订单编号' &&
        textVal(row[4]).replace(/\s/g, '') === '供应商编号'
    );
}

/** 探测单张表（二维数组）的格式、表头行、列映射与综合推荐评分（0-100） */
export function inspectRowsSchema(rows, options = {}) {
    const sheetName = options.sheetName || 'Sheet1';
    const safeRows = Array.isArray(rows) ? rows : [];
    const curtainIdx = safeRows.findIndex(isCurtainHeaderRow);
    if (curtainIdx >= 0) {
        const headers = (safeRows[curtainIdx] || []).map(textVal);
        const nonEmptyRows = safeRows.slice(curtainIdx + 1).filter(r => Array.isArray(r) && r.some(c => textVal(c) !== ''));
        const score = Math.min(100, 75 + Math.min(25, nonEmptyRows.length));
        return {
            sheetName,
            score,
            recommended: false,
            format: '9.28_CURTAIN',
            dimension: 'RECT_2D',
            headerRowIndex: curtainIdx + 1,
            headers,
            detectedMapping: { order: 2, fabricCode: 3, materialModel: 4 },
            columnUnits: { width: 'cm', length: 'cm' },
            unmappedColumns: [],
            rowCount: nonEmptyRows.length,
            previewRows: safeRows.slice(curtainIdx + 1, curtainIdx + 6)
        };
    }

    let bestCandidate = null;
    const scanLimit = Math.min(safeRows.length, 30);

    for (let r = 0; r < scanLimit; r++) {
        const row = safeRows[r];
        if (!Array.isArray(row)) continue;
        const nonEmptyCount = row.filter(c => textVal(c) !== '').length;
        if (nonEmptyCount < 2) continue;

        const mapping = {};
        const fieldKeys = {};
        const columnUnits = {};
        const unmappedColumns = [];
        const headers = row.map(textVal);

        row.forEach((cell, colIdx) => {
            const parsed = parseHeaderColumn(cell);
            if (!parsed.raw) return;
            const field = matchFieldByHeader(parsed);
            if (field && mapping[field] === undefined) {
                mapping[field] = colIdx;
                fieldKeys[field] = parsed.key;
                if (parsed.unit) columnUnits[field] = parsed.unit;
            } else if (!field) {
                unmappedColumns.push({ index: colIdx, header: parsed.raw });
            }
        });

        const hasBomCore = mapping.bomParent !== undefined && mapping.bomChild !== undefined && mapping.bomUsage !== undefined;
        const hasDemandCore =
            mapping.materialModel !== undefined &&
            (mapping.width !== undefined || mapping.length !== undefined);
        const hasFull2D =
            mapping.materialModel !== undefined &&
            mapping.width !== undefined &&
            mapping.length !== undefined;

        const dataRows = safeRows
            .slice(r + 1)
            .filter(dr => Array.isArray(dr) && dr.some(c => textVal(c) !== ''));

        let format = 'UNKNOWN';
        let fieldScore = Object.keys(mapping).length * 8;

        if (hasBomCore) {
            format = 'BOM_TREE';
            fieldScore += 35;
        } else if (hasFull2D || hasDemandCore) {
            if (mapping.productType !== undefined) {
                const sampleTypes = dataRows
                    .slice(0, 20)
                    .map(sr => parseProductDimension(sr?.[mapping.productType], 'RECT_2D'));
                format = sampleTypes.some(t => t === 'SLITTING_1D') ? 'SLITTING_1D' : 'STANDARD_2D';
            } else if (mapping.allowRotation !== undefined || mapping.fabricCode !== undefined) {
                format = 'STANDARD_2D';
            } else {
                const hasExplicit1DKeyword =
                    headers.some(h => EXPLICIT_1D_HEADER_RE.test(h)) ||
                    SLIT_ONLY_WIDTH_KEYS.has(fieldKeys.width) ||
                    SLIT_ONLY_LENGTH_KEYS.has(fieldKeys.length);
                const hasRollSlitPair =
                    ROLL_OR_SLIT_WIDTH_KEYS.has(fieldKeys.width) &&
                    FIXED_OR_SLIT_LENGTH_KEYS.has(fieldKeys.length) &&
                    (mapping.name === undefined || mapping.surfaceTreatment !== undefined);
                const hasSurface1DSignal =
                    mapping.surfaceTreatment !== undefined && (mapping.name === undefined || !hasFull2D);
                format = (hasExplicit1DKeyword || hasRollSlitPair || hasSurface1DSignal)
                    ? 'SLITTING_1D'
                    : 'STANDARD_2D';
            }
            fieldScore += hasFull2D ? 35 : 18;
            if (mapping.quantity !== undefined) fieldScore += 10;
            if (mapping.name !== undefined) fieldScore += 8;
        }

        const dataBonus = format === 'UNKNOWN' ? 0 : Math.min(20, dataRows.length * 2);
        const totalScore = format === 'UNKNOWN' ? Math.min(20, fieldScore) : Math.min(100, fieldScore + dataBonus);

        if (!bestCandidate || totalScore > bestCandidate.score) {
            bestCandidate = {
                sheetName,
                score: totalScore,
                recommended: false,
                format,
                dimension: format === 'SLITTING_1D' ? 'SLITTING_1D' : 'RECT_2D',
                headerRowIndex: format === 'UNKNOWN' ? 0 : r + 1,
                headers,
                detectedMapping: mapping,
                columnUnits,
                unmappedColumns,
                rowCount: dataRows.length,
                previewRows: dataRows.slice(0, 5)
            };
        }
    }

    if (!bestCandidate) {
        return {
            sheetName,
            score: 0,
            recommended: false,
            format: 'UNKNOWN',
            dimension: 'RECT_2D',
            headerRowIndex: 0,
            headers: [],
            detectedMapping: {},
            columnUnits: {},
            unmappedColumns: [],
            rowCount: 0,
            previewRows: []
        };
    }

    return bestCandidate;
}

/** 合并用户手动列覆写 columnOverrides（支持字段名 -> 0-based 列号或列名） */
export function resolveEffectiveMapping(schema, columnOverrides = {}) {
    const mapping = { ...(schema.detectedMapping || {}) };
    const headers = schema.headers || [];
    if (!columnOverrides || typeof columnOverrides !== 'object') {
        return mapping;
    }
    for (const [field, target] of Object.entries(columnOverrides)) {
        if (target == null || target === '') {
            delete mapping[field];
            continue;
        }
        if (typeof target === 'number' && Number.isInteger(target) && target >= 0) {
            mapping[field] = target;
        } else if (typeof target === 'string') {
            const idx = headers.findIndex(h => textVal(h) === textVal(target));
            if (idx >= 0) {
                mapping[field] = idx;
            } else if (/^\d+$/.test(target.trim())) {
                mapping[field] = Number(target.trim());
            }
        }
    }
    return mapping;
}

/** 解析允许旋转布尔值 */
export function parseAllowRotationCell(rawVal) {
    const s = textVal(rawVal).toLowerCase();
    if (!s) return { valid: true, value: false };
    if (['是', 'true', '1', 'yes', 'y'].includes(s)) return { valid: true, value: true };
    if (['否', 'false', '0', 'no', 'n'].includes(s)) return { valid: true, value: false };
    return { valid: false, value: false };
}

/** 解析产品维度（1D / 2D） */
export function parseProductDimension(rawType, defaultDim = 'RECT_2D') {
    const s = textVal(rawType).toUpperCase();
    if (!s) return defaultDim;
    if (['1D', 'SLITTING', 'SLITTING_1D', '分切', '一维', '一维分切'].includes(s)) return 'SLITTING_1D';
    if (['CONTOUR', 'CONTOUR_2D', '异形', '轮廓'].includes(s)) return 'CONTOUR_2D';
    if (['2D', 'RECT', 'RECT_2D', '矩形', '二维'].includes(s)) return 'RECT_2D';
    return defaultDim;
}

/**
 * 解析并展开 BOM 树结构：
 * - 校验单耗 > 0 与有限数值（否则记录 INVALID_BOM_USAGE）
 * - DFS 检测自环及有向循环引用（否则记录 CIRCULAR_BOM）
 * - 累乘根套件数至叶子物料，生成带 bomPath 的需求行
 */
export function expandBomRows({
    rows,
    headerRowIndex,
    headers,
    mapping,
    columnUnits,
    sheetName = 'Sheet1',
    defaultUnit = 'mm',
    bomRootQty = 1,
    bomRootCode = null,
    productTypeOverride = 'AUTO'
}) {
    const issues = [];
    const rootQtyProvided =
        bomRootQty !== undefined && bomRootQty !== null && textVal(bomRootQty) !== '';
    if (rootQtyProvided && !isPositiveNum(bomRootQty)) {
        issues.push(createImportIssue({
            rowIndex: Math.max(1, headerRowIndex),
            sheetName,
            column: 'BOM 根套件数量',
            field: 'bomRootQty',
            model: textVal(bomRootCode) || 'BOM_ROOT',
            reason: `BOM 根套件数量必须大于 0（当前值: "${textVal(bomRootQty)}"）`,
            code: 'INVALID_BOM_ROOT_QTY',
            line: { bomRootQty }
        }));
        return { demands: [], issues };
    }
    const nodes = new Map();
    const edgesByParent = new Map();
    const childSet = new Set();
    const validEdges = [];
    const childSpecCache = new Map();

    const colName = (field, fallback) => {
        const idx = mapping[field];
        return idx != null && headers[idx] ? headers[idx] : fallback;
    };

    const startIdx = Math.max(0, headerRowIndex);
    for (let i = startIdx; i < rows.length; i++) {
        const row = rows[i];
        if (!Array.isArray(row) || !row.some(c => textVal(c) !== '')) continue;
        const rowIndex = i + 1;
        const parent = textVal(row[mapping.bomParent]);
        const child = textVal(row[mapping.bomChild]);
        const rawUsage = row[mapping.bomUsage];
        const explicitMaterialModel = textVal(mapping.materialModel >= 0 ? row[mapping.materialModel] : '');
        const explicitPartName = textVal(mapping.name >= 0 ? row[mapping.name] : '');
        const materialModel = explicitMaterialModel || child;
        const partName = explicitPartName || child;
        const rowUnit = normalizeUnit(
            mapping.unit >= 0 ? row[mapping.unit] : '',
            columnUnits.width || columnUnits.length || defaultUnit
        );
        const widthRaw = mapping.width >= 0 ? row[mapping.width] : undefined;
        const lengthRaw = mapping.length >= 0 ? row[mapping.length] : undefined;
        const surfaceTreatment = mapping.surfaceTreatment >= 0 ? textVal(row[mapping.surfaceTreatment]) : '';
        const order = mapping.order >= 0 ? textVal(row[mapping.order]) : '';
        const rawDim = mapping.productType >= 0 ? row[mapping.productType] : '';
        const explicitDimension = textVal(rawDim) ? parseProductDimension(rawDim, null) : null;

        if (!parent) {
            issues.push(createImportIssue({
                rowIndex, sheetName, column: colName('bomParent', '父件编码'), field: 'bomParent',
                model: materialModel, reason: '缺少父件编码', code: 'MISSING_BOM_PARENT', line: { rowIndex, parent, child }
            }));
            continue;
        }
        if (!child) {
            issues.push(createImportIssue({
                rowIndex, sheetName, column: colName('bomChild', '子件编码'), field: 'bomChild',
                model: parent, reason: '缺少子件编码', code: 'MISSING_BOM_CHILD', line: { rowIndex, parent, child }
            }));
            continue;
        }
        if (!isPositiveNum(rawUsage)) {
            issues.push(createImportIssue({
                rowIndex, sheetName, column: colName('bomUsage', '单耗'), field: 'bomUsage',
                model: materialModel, reason: `BOM 单耗必须大于 0（当前值: "${textVal(rawUsage)}"）`,
                code: 'INVALID_BOM_USAGE', line: { rowIndex, parent, child, usage: rawUsage }
            }));
            continue;
        }

        const usage = Number(rawUsage);
        if (parent === child) {
            issues.push(createImportIssue({
                rowIndex, sheetName, column: colName('bomChild', '子件编码'), field: 'bom',
                model: parent, reason: `检测到 BOM 自循环引用：${parent} -> ${child}`,
                code: 'CIRCULAR_BOM', line: { rowIndex, parent, child }
            }));
            continue;
        }

        const widthBlank = textVal(widthRaw) === '';
        const lengthBlank = textVal(lengthRaw) === '';
        const rowWidthMm = isPositiveNum(widthRaw) ? convertToMm(widthRaw, rowUnit) : 0;
        const rowLengthMm = isPositiveNum(lengthRaw) ? convertToMm(lengthRaw, rowUnit) : 0;
        const rotRaw = mapping.allowRotation >= 0 ? row[mapping.allowRotation] : '';
        const hasRotText = textVal(rotRaw) !== '';
        const rotParsed = hasRotText ? parseAllowRotationCell(rotRaw) : { valid: true, value: false };
        const explicitAllowRotation = hasRotText && rotParsed.valid ? rotParsed.value : null;
        const rotationInvalid = hasRotText && !rotParsed.valid;

        let specConflict = false;
        const cachedSpec = childSpecCache.get(child);
        if (cachedSpec) {
            const widthConflict =
                cachedSpec.widthMm > 0 && rowWidthMm > 0 && Math.abs(cachedSpec.widthMm - rowWidthMm) > 0.05;
            const lengthConflict =
                cachedSpec.lengthMm > 0 && rowLengthMm > 0 && Math.abs(cachedSpec.lengthMm - rowLengthMm) > 0.05;
            if (widthConflict || lengthConflict) {
                specConflict = true;
                const conflictCol = widthConflict ? colName('width', '宽度') : colName('length', '长度');
                const conflictField = widthConflict ? 'width' : 'length';
                issues.push(createImportIssue({
                    rowIndex,
                    sheetName,
                    column: conflictCol,
                    field: conflictField,
                    model: explicitMaterialModel || cachedSpec.materialModel || child,
                    reason: `共享子件 "${child}" 与第 ${cachedSpec.dimRowIndex || cachedSpec.rowIndex} 行规格冲突（${cachedSpec.widthMm}×${cachedSpec.lengthMm} vs ${rowWidthMm}×${rowLengthMm}）`,
                    code: 'INVALID_DIM',
                    line: { rowIndex, parent, child, width: rowWidthMm, length: rowLengthMm }
                }));
            } else {
                if (cachedSpec.widthMm <= 0 && rowWidthMm > 0) {
                    cachedSpec.widthMm = rowWidthMm;
                    if (!cachedSpec.dimRowIndex) cachedSpec.dimRowIndex = rowIndex;
                }
                if (cachedSpec.lengthMm <= 0 && rowLengthMm > 0) {
                    cachedSpec.lengthMm = rowLengthMm;
                    if (!cachedSpec.dimRowIndex) cachedSpec.dimRowIndex = rowIndex;
                }
                if (!cachedSpec.materialModel && explicitMaterialModel) cachedSpec.materialModel = explicitMaterialModel;
                if (!cachedSpec.partName && explicitPartName) cachedSpec.partName = explicitPartName;
                if (!cachedSpec.surfaceTreatment && surfaceTreatment) cachedSpec.surfaceTreatment = surfaceTreatment;
                if (cachedSpec.allowRotation === null && explicitAllowRotation !== null) {
                    cachedSpec.allowRotation = explicitAllowRotation;
                }
                if (!cachedSpec.explicitDimension && explicitDimension) {
                    cachedSpec.explicitDimension = explicitDimension;
                }
            }
        } else if (
            rowWidthMm > 0 ||
            rowLengthMm > 0 ||
            explicitMaterialModel ||
            explicitPartName ||
            surfaceTreatment ||
            explicitAllowRotation !== null ||
            explicitDimension !== null
        ) {
            childSpecCache.set(child, {
                rowIndex,
                dimRowIndex: rowWidthMm > 0 || rowLengthMm > 0 ? rowIndex : 0,
                widthMm: rowWidthMm,
                lengthMm: rowLengthMm,
                materialModel: explicitMaterialModel,
                partName: explicitPartName,
                surfaceTreatment,
                allowRotation: explicitAllowRotation,
                explicitDimension
            });
        }

        const edge = {
            rowIndex,
            parent,
            child,
            usage,
            explicitMaterialModel,
            explicitPartName,
            materialModel,
            partName,
            rowUnit,
            widthRaw,
            lengthRaw,
            widthBlank,
            lengthBlank,
            rowWidthMm,
            rowLengthMm,
            specConflict,
            surfaceTreatment,
            order,
            explicitDimension,
            explicitAllowRotation,
            rotationInvalid
        };
        validEdges.push(edge);
        if (!edgesByParent.has(parent)) edgesByParent.set(parent, []);
        edgesByParent.get(parent).push(edge);
        childSet.add(child);
        if (!nodes.has(parent)) nodes.set(parent, { code: parent });
        nodes.set(child, edge);
    }

    // DFS 环检测（0 = 未访问，1 = 栈中/灰点，2 = 已完成）
    const color = new Map();
    const cycleEdgeRows = new Set();
    const stack = [];

    function dfs(node) {
        color.set(node, 1);
        stack.push(node);
        const outEdges = edgesByParent.get(node) || [];
        for (const edge of outEdges) {
            const nextState = color.get(edge.child) || 0;
            if (nextState === 1) {
                const cycleStart = stack.indexOf(edge.child);
                const cyclePath = [...stack.slice(cycleStart), edge.child].join(' -> ');
                if (!cycleEdgeRows.has(edge.rowIndex)) {
                    cycleEdgeRows.add(edge.rowIndex);
                    issues.push(createImportIssue({
                        rowIndex: edge.rowIndex,
                        sheetName,
                        column: colName('bomChild', '子件编码'),
                        field: 'bom',
                        model: edge.parent,
                        reason: `检测到 BOM 循环引用：${cyclePath}`,
                        code: 'CIRCULAR_BOM',
                        line: { rowIndex: edge.rowIndex, parent: edge.parent, child: edge.child, cyclePath }
                    }));
                }
            } else if (nextState === 0) {
                dfs(edge.child);
            }
        }
        stack.pop();
        color.set(node, 2);
    }

    for (const parent of edgesByParent.keys()) {
        if ((color.get(parent) || 0) === 0) {
            dfs(parent);
        }
    }

    const roots = bomRootCode
        ? [bomRootCode]
        : [...edgesByParent.keys()].filter(p => !childSet.has(p));

    const demands = [];
    const rootMult = rootQtyProvided ? Number(bomRootQty) : 1;

    function traverse(node, accQty, path, activeTrail) {
        const outEdges = (edgesByParent.get(node) || []).filter(e => !cycleEdgeRows.has(e.rowIndex));
        if (outEdges.length === 0) return;

        for (const edge of outEdges) {
            if (activeTrail.has(edge.child)) continue;
            const nextQty = accQty * edge.usage;
            const nextPath = [...path, edge.child];
            const isAssemblyNode = edgesByParent.has(edge.child);
            const childOut = (edgesByParent.get(edge.child) || []).filter(e => !cycleEdgeRows.has(e.rowIndex));
            if (isAssemblyNode) {
                if (childOut.length > 0) {
                    activeTrail.add(edge.child);
                    traverse(edge.child, nextQty, nextPath, activeTrail);
                    activeTrail.delete(edge.child);
                }
            } else {
                if (edge.specConflict) continue;
                const cached = childSpecCache.get(edge.child);
                const w = edge.widthBlank ? (cached?.widthMm || 0) : edge.rowWidthMm;
                const l = edge.lengthBlank ? (cached?.lengthMm || 0) : edge.rowLengthMm;
                const effectiveModel = edge.explicitMaterialModel || cached?.materialModel || edge.child;
                const effectiveName = edge.explicitPartName || cached?.partName || edge.child;
                const effectiveSurface = edge.surfaceTreatment || cached?.surfaceTreatment || '';
                const effectiveExplicitDim = edge.explicitDimension || cached?.explicitDimension || null;
                const overrideDim = productTypeOverride && productTypeOverride !== 'AUTO' ? productTypeOverride : null;
                const hasAllowRotationCol = mapping.allowRotation >= 0;
                const effectiveDimension =
                    overrideDim ||
                    effectiveExplicitDim ||
                    (effectiveSurface && !hasAllowRotationCol ? 'SLITTING_1D' : 'RECT_2D');
                const rawEffectiveRotation =
                    edge.explicitAllowRotation !== null
                        ? edge.explicitAllowRotation
                        : (cached?.allowRotation ?? false);
                const effectiveRotation = effectiveDimension === 'SLITTING_1D' ? false : rawEffectiveRotation;
                if (w <= 0) {
                    issues.push(createImportIssue({
                        rowIndex: edge.rowIndex, sheetName, column: colName('width', '宽度'), field: 'width',
                        model: effectiveModel, reason: 'BOM 叶子物料缺少有效宽度', code: 'INVALID_DIM', line: edge
                    }));
                    continue;
                }
                if (l <= 0) {
                    issues.push(createImportIssue({
                        rowIndex: edge.rowIndex, sheetName, column: colName('length', '长度'), field: 'length',
                        model: effectiveModel, reason: 'BOM 叶子物料缺少有效长度', code: 'INVALID_DIM', line: edge
                    }));
                    continue;
                }
                const roundedQty = Math.round(nextQty);
                if (Math.abs(nextQty - roundedQty) > 1e-6 || roundedQty <= 0 || roundedQty > 2147483647) {
                    issues.push(createImportIssue({
                        rowIndex: edge.rowIndex, sheetName, column: colName('bomUsage', '单耗'), field: 'quantity',
                        model: effectiveModel, reason: `BOM 展开数量必须为正整数（累计计算结果: ${nextQty}）`,
                        code: 'INVALID_QTY', line: edge
                    }));
                    continue;
                }
                if (edge.rotationInvalid) {
                    issues.push(createImportIssue({
                        rowIndex: edge.rowIndex, sheetName, column: colName('allowRotation', '允许旋转'), field: 'allowRotation',
                        model: effectiveModel, reason: '允许旋转只能填是或否', code: 'INVALID_ROTATION', line: edge
                    }));
                    continue;
                }
                demands.push({
                    row: edge.rowIndex,
                    materialModel: effectiveModel,
                    name: effectiveName,
                    width: w,
                    length: l,
                    quantity: roundedQty,
                    allowRotation: effectiveRotation,
                    order: edge.order,
                    dimension: effectiveDimension,
                    bomPath: nextPath.join(' > '),
                    ...(effectiveSurface || effectiveDimension === 'SLITTING_1D'
                        ? { surfaceTreatment: effectiveSurface || '默认' }
                        : {})
                });
            }
        }
    }

    for (const root of roots) {
        traverse(root, rootMult, [root], new Set([root]));
    }

    return { demands, issues };
}
