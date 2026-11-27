/** Import only demand facts. Inventory, defects, reports and task identities are never imported. */
import { decodeTextBuffer, parseDelimitedText } from './demand-import-csv.js';
import {
    textVal,
    isPositiveNum,
    normalizeUnit,
    convertToMm,
    convertToRawMm,
    createImportIssue,
    isCurtainHeaderRow,
    inspectRowsSchema,
    resolveEffectiveMapping,
    parseAllowRotationCell,
    parseProductDimension,
    expandBomRows
} from './demand-import-schema.js';

const cm = value => Math.round(Number(value) * 1000000) / 100000;

function extractSheetRows(sheet, options = {}) {
    if (!sheet) return [];
    if (Array.isArray(sheet)) return sheet;
    if (typeof options.xlsxUtils?.sheet_to_json === 'function') {
        return options.xlsxUtils.sheet_to_json(sheet, { header: 1, defval: '' });
    }
    const ref = sheet['!ref'];
    if (!ref || typeof ref !== 'string') return [];
    const [startRef, endRef] = ref.split(':');
    const start = decodeCellRef(startRef);
    const end = decodeCellRef(endRef || startRef);
    if (!start || !end) return [];
    const rows = [];
    for (let r = start.r; r <= end.r; r++) {
        const row = [];
        for (let c = start.c; c <= end.c; c++) {
            const addr = encodeCol(c) + (r + 1);
            const cell = sheet[addr];
            row.push(cell && cell.v !== undefined ? cell.v : '');
        }
        rows.push(row);
    }
    return rows;
}

function decodeCellRef(ref) {
    const m = String(ref || '').trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return null;
    const letters = m[1].toUpperCase();
    let c = 0;
    for (let i = 0; i < letters.length; i++) {
        c = c * 26 + (letters.charCodeAt(i) - 64);
    }
    return { r: Number(m[2]) - 1, c: c - 1 };
}

function encodeCol(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

export function parseDemandSheet(rows, options = {}) {
    if (!Array.isArray(rows)) throw new Error('工作表数据格式无效。');
    if (rows.length > 10001) throw new Error('工作表超过 10000 行，请按批次拆分。');
    const sheetName = options.sheetName || 'Sheet1';

    const header = rows.findIndex(isCurtainHeaderRow);
    if (header >= 0) return parseCurtainRows(rows, header + 1, sheetName);

    const schema = inspectRowsSchema(rows, { sheetName });
    const hasOverrides = options.columnOverrides && Object.keys(options.columnOverrides).length > 0;
    let effectiveHeaderIdx = schema.headerRowIndex;
    let effectiveHeaders = schema.headers;

    if (schema.format === 'UNKNOWN' && hasOverrides) {
        const firstNonEmpty = rows.findIndex(r => Array.isArray(r) && r.some(c => textVal(c) !== ''));
        if (firstNonEmpty >= 0) {
            effectiveHeaderIdx = firstNonEmpty + 1;
            effectiveHeaders = rows[firstNonEmpty].map(textVal);
        }
    }

    const mapping = resolveEffectiveMapping(
        { ...schema, headers: effectiveHeaders },
        options.columnOverrides
    );

    const hasBomMapping =
        mapping.bomParent !== undefined && mapping.bomChild !== undefined && mapping.bomUsage !== undefined;
    const hasDemandMapping =
        mapping.materialModel !== undefined &&
        (mapping.width !== undefined || mapping.length !== undefined);

    if (schema.format === 'UNKNOWN' && !hasBomMapping && !hasDemandMapping) {
        throw new Error('未识别表头。请选择 9.28 订单格式，或下载标准需求模板。');
    }

    const defaultUnit = normalizeUnit(options.defaultUnit, 'mm');
    const format = hasBomMapping
        ? 'BOM_TREE'
        : schema.format === 'UNKNOWN'
            ? (options.productTypeOverride === 'SLITTING_1D' ? 'SLITTING_1D' : 'STANDARD_2D')
            : schema.format;

    if (format === 'BOM_TREE') {
        const result = {
            groups: [],
            issues: [],
            format: 'BOM 层级展开 · mm',
            sheetName,
            dimension: 'RECT_2D',
            detectedMapping: mapping
        };
        const expanded = expandBomRows({
            rows,
            headerRowIndex: effectiveHeaderIdx,
            headers: effectiveHeaders,
            mapping,
            columnUnits: schema.columnUnits,
            sheetName,
            defaultUnit,
            bomRootQty: options.bomRootQty,
            bomRootCode: options.bomRootCode,
            productTypeOverride: options.productTypeOverride
        });
        result.issues.push(...expanded.issues);
        for (const item of expanded.demands) {
            add(result, item, '', { sheetName, column: 'BOM展开' });
        }
        if (expanded.demands.some(d => d.dimension === 'SLITTING_1D')) {
            result.dimension = 'SLITTING_1D';
        }
        return finish(result);
    }

    const colName = (field, fallback) => {
        const idx = mapping[field];
        return idx != null && effectiveHeaders[idx] ? effectiveHeaders[idx] : fallback;
    };
    const at = (row, field) => {
        const idx = mapping[field];
        return idx != null && idx >= 0 ? row[idx] : undefined;
    };

    const resultDimension =
        options.productTypeOverride && options.productTypeOverride !== 'AUTO'
            ? options.productTypeOverride
            : format === 'SLITTING_1D'
                ? 'SLITTING_1D'
                : 'RECT_2D';

    const result = {
        groups: [],
        issues: [],
        format: resultDimension === 'SLITTING_1D' ? '1D 分切订单 · mm' : '标准需求表 · mm',
        sheetName,
        dimension: resultDimension,
        detectedMapping: mapping
    };

    rows.slice(effectiveHeaderIdx).forEach((row, index) => {
        if (!Array.isArray(row) || !row.some(value => textVal(value))) return;
        const rowIndex = effectiveHeaderIdx + index + 1;
        const materialModel = textVal(at(row, 'materialModel'));
        const fabricCode = mapping.fabricCode !== undefined ? textVal(at(row, 'fabricCode')) : undefined;
        const order = textVal(at(row, 'order'));
        const note = mapping.note !== undefined ? textVal(at(row, 'note')) : '';
        const surfaceTreatment = mapping.surfaceTreatment !== undefined ? textVal(at(row, 'surfaceTreatment')) : '';
        const rowType =
            options.productTypeOverride && options.productTypeOverride !== 'AUTO'
                ? options.productTypeOverride
                : parseProductDimension(at(row, 'productType'), resultDimension);
        const partName = textVal(at(row, 'name')) || (rowType === 'SLITTING_1D' ? `${materialModel || '分切'}条` : '');

        const rowUnit = normalizeUnit(at(row, 'unit'), defaultUnit);
        const widthUnit = mapping.unit !== undefined && textVal(at(row, 'unit'))
            ? rowUnit
            : (schema.columnUnits.width || defaultUnit);
        const lengthUnit = mapping.unit !== undefined && textVal(at(row, 'unit'))
            ? rowUnit
            : (schema.columnUnits.length || defaultUnit);

        const rawWidth = at(row, 'width');
        const rawLength = at(row, 'length');
        const rawQty = at(row, 'quantity');
        const rotParsed = parseAllowRotationCell(at(row, 'allowRotation'));

        const rawWidthMm = isPositiveNum(rawWidth) ? convertToRawMm(rawWidth, widthUnit) : NaN;
        const rawLengthMm = isPositiveNum(rawLength) ? convertToRawMm(rawLength, lengthUnit) : NaN;
        const widthMm = Number.isFinite(rawWidthMm) ? convertToMm(rawWidth, widthUnit) : NaN;
        const lengthMm = Number.isFinite(rawLengthMm) ? convertToMm(rawLength, lengthUnit) : NaN;
        const isIntWidth = Number.isFinite(rawWidthMm) && Math.abs(rawWidthMm - Math.round(rawWidthMm)) < 1e-6;
        const isIntLength = Number.isFinite(rawLengthMm) && Math.abs(rawLengthMm - Math.round(rawLengthMm)) < 1e-6;

        let error = '';
        let errorColumn = '';
        let errorField = '';
        let errorCode = 'VALIDATION_ERROR';

        if (!materialModel) {
            error = '缺少材料型号';
            errorColumn = colName('materialModel', '材料型号');
            errorField = 'materialModel';
            errorCode = 'MISSING_MATERIAL';
        } else if (!partName) {
            error = '缺少裁片名称';
            errorColumn = colName('name', '裁片名称');
            errorField = 'name';
            errorCode = 'MISSING_NAME';
        } else if (!isPositiveNum(rawWidth) || !Number.isFinite(widthMm) || widthMm <= 0) {
            error = '宽度必须大于 0';
            errorColumn = colName('width', '宽度');
            errorField = 'width';
            errorCode = 'INVALID_DIM';
        } else if (!isPositiveNum(rawLength) || !Number.isFinite(lengthMm) || lengthMm <= 0) {
            error = '长度必须大于 0';
            errorColumn = colName('length', '长度');
            errorField = 'length';
            errorCode = 'INVALID_DIM';
        } else if (rowType === 'SLITTING_1D' && (!isIntWidth || !isIntLength)) {
            error = '1D 分切订单宽度与长度换算(mm)后必须为正整数';
            errorColumn = !isIntWidth ? colName('width', '宽度') : colName('length', '长度');
            errorField = !isIntWidth ? 'width' : 'length';
            errorCode = 'INVALID_DIM';
        } else if (!isPositiveNum(rawQty) || !Number.isSafeInteger(Number(rawQty)) || Number(rawQty) > 2147483647) {
            error = '数量必须是有效正整数';
            errorColumn = colName('quantity', '数量');
            errorField = 'quantity';
            errorCode = 'INVALID_QTY';
        } else if (!rotParsed.valid) {
            error = '允许旋转只能填是或否';
            errorColumn = colName('allowRotation', '允许旋转');
            errorField = 'allowRotation';
            errorCode = 'INVALID_ROTATION';
        }

        const line = {
            row: rowIndex,
            materialModel,
            ...(fabricCode ? { fabricCode } : {}),
            name: partName,
            width: widthMm,
            length: lengthMm,
            quantity: rawQty,
            order,
            allowRotation: rowType === 'SLITTING_1D' ? false : rotParsed.value,
            ...(rowType === 'SLITTING_1D' ? { dimension: 'SLITTING_1D', surfaceTreatment: surfaceTreatment || '默认' } : {}),
            ...(note ? { note } : {})
        };

        add(result, line, error, {
            sheetName,
            column: errorColumn,
            field: errorField,
            code: errorCode
        });
    });

    if (result.groups.some(g => g.dimension === 'SLITTING_1D')) {
        result.dimension = 'SLITTING_1D';
    }
    return finish(result);
}

function parseCurtainRows(rows, start, sheetName = 'Sheet1') {
    const result = {
        groups: [],
        issues: [],
        format: '9.28 订单格式 · cm → mm',
        sheetName,
        dimension: 'RECT_2D'
    };
    rows.slice(start).forEach((row, index) => {
        if (!textVal(row[2]) && (!isPositiveNum(row[0]) || ![3, 4, 7, 8, 13, 15].some(column => textVal(row[column])))) return;
        const number = start + index + 1;
        const pair = textVal(row[10]);
        const direction = textVal(row[12]);
        const cutWidth = pair === '双' ? row[15] : row[13];
        const splice = pair === '双' ? row[16] : row[14];
        let error = '';
        let column = '';
        let field = '';
        if (!textVal(row[2])) {
            error = '缺少订单编号'; column = '订单编号'; field = 'order';
        } else if (!textVal(row[4])) {
            error = '布料待定或缺少供应商型号'; column = '供应商编号'; field = 'materialModel';
        } else if (!['单', '双'].includes(pair)) {
            error = '单片 / 双片未填写或无法识别'; column = '单片/双片'; field = 'pair';
        } else if (!(direction === '横裁' || (!direction && textVal(row[11]).toUpperCase() === 'RH'))) {
            error = '裁切方向未确认；当前只转换 RH 横裁订单'; column = '裁切方向'; field = 'direction';
        } else if (!isPositiveNum(cutWidth) || !isPositiveNum(row[17])) {
            error = '缺少有效裁布宽度或裁布高度'; column = !isPositiveNum(cutWidth) ? '裁布宽(cm)' : '裁布高(cm)'; field = 'width';
        } else if (!isPositiveNum(row[9]) || !Number.isSafeInteger(Number(row[9]))) {
            error = '订单支数必须是正整数'; column = '订单支数'; field = 'quantity';
        }

        const note = Number(splice) > 1 ? `最多拼接 ${splice} 片；保留整片需求，未自动拆片` : '';
        add(
            result,
            {
                row: number,
                materialModel: textVal(row[4]),
                fabricCode: textVal(row[3]),
                order: textVal(row[2]),
                style: textVal(row[1]),
                pair,
                orderQuantity: Number(row[9]),
                cutWidthCm: Number(cutWidth),
                cutHeightCm: Number(row[17]),
                name: `订单 ${textVal(row[2])} · ${textVal(row[3])} · 第 ${number} 行`,
                width: cm(row[17]),
                length: cm(cutWidth),
                quantity: Number(row[9]) * (pair === '双' ? 2 : 1),
                allowRotation: false,
                note
            },
            error,
            { sheetName, column, field, code: error ? 'CURTAIN_ROW_INVALID' : '' }
        );
    });
    return finish(result);
}

function add(result, line, error = '', meta = {}) {
    let field = meta.field || '';
    let column = meta.column || '';
    let code = meta.code || 'VALIDATION_ERROR';
    if (!error) {
        if (!line.materialModel) {
            error = '缺少材料型号'; field = 'materialModel'; column = column || '材料型号'; code = 'MISSING_MATERIAL';
        } else if (!line.name) {
            error = '缺少裁片名称'; field = 'name'; column = column || '裁片名称'; code = 'MISSING_NAME';
        } else if (!isPositiveNum(line.width) || !isPositiveNum(line.length)) {
            error = '宽度、长度必须大于 0'; field = 'width'; column = column || '宽度/长度'; code = 'INVALID_DIM';
        } else if (!isPositiveNum(line.quantity) || !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) > 2147483647) {
            error = '数量必须是有效正整数'; field = 'quantity'; column = column || '数量'; code = 'INVALID_QTY';
        }
    }
    if (error) {
        result.issues.push(
            createImportIssue({
                rowIndex: line.row,
                sheetName: meta.sheetName || result.sheetName || 'Sheet1',
                column: column || field || '未知列',
                field,
                model: line.materialModel,
                reason: error,
                code,
                line
            })
        );
        return;
    }
    const dim = line.dimension || result.dimension || 'RECT_2D';
    let group = result.groups.find(
        item => item.materialModel === line.materialModel && item.fabricCode === line.fabricCode && (item.dimension || 'RECT_2D') === dim
    );
    if (!group) {
        group = {
            materialModel: line.materialModel,
            fabricCode: line.fabricCode,
            ...(line.dimension ? { dimension: line.dimension } : {}),
            demands: []
        };
        result.groups.push(group);
    }
    group.demands.push({
        ...line,
        id: line.row,
        width: Number(line.width),
        length: Number(line.length),
        quantity: Number(line.quantity)
    });
}

function finish(result) {
    if (!result.groups.length && !result.issues.length) throw new Error('工作表没有可导入的需求行。');
    return result;
}

export function parseDemandCsv(bytesOrText, options = {}) {
    const decoded = decodeTextBuffer(bytesOrText);
    const { rows, delimiter } = parseDelimitedText(decoded.text, options.delimiter);
    const parsed = parseDemandSheet(rows, { ...options, sheetName: options.sheetName || 'CSV' });
    return {
        ...parsed,
        encoding: decoded.encoding,
        delimiter
    };
}

export function inspectDemandWorkbook(book, options = {}) {
    if (!book || !Array.isArray(book.SheetNames) || !book.Sheets) {
        throw new Error('无效的工作簿对象。');
    }
    const hiddenMeta = book.Workbook?.Sheets || [];
    const sheets = [];

    book.SheetNames.forEach((sheetName, idx) => {
        const isHidden = hiddenMeta[idx]?.Hidden === 1 || hiddenMeta[idx]?.Hidden === 2;
        if (isHidden && !options.includeHidden) return;
        const sheet = book.Sheets[sheetName];
        const rows = extractSheetRows(sheet, options);
        sheets.push(inspectRowsSchema(rows, { sheetName }));
    });

    if (!sheets.length) {
        throw new Error('工作簿中不包含可解析的工作表。');
    }

    let bestIdx = 0;
    for (let i = 1; i < sheets.length; i++) {
        if (sheets[i].score > sheets[bestIdx].score) {
            bestIdx = i;
        }
    }
    sheets[bestIdx].recommended = true;
    return {
        recommendedSheetName: sheets[bestIdx].sheetName,
        sheets
    };
}

export function parseDemandWorkbook(book, options = {}) {
    const inspection = inspectDemandWorkbook(book, options);
    const targetName = options.sheetName || inspection.recommendedSheetName;
    const sheet = book.Sheets?.[targetName];
    if (!sheet) {
        throw new Error(`工作簿中未找到指定工作表：${targetName}`);
    }
    const rows = extractSheetRows(sheet, options);
    const parsed = parseDemandSheet(rows, { ...options, sheetName: targetName });
    return {
        ...parsed,
        sheetName: targetName,
        inspection
    };
}

export function parseDemandJSON(value) {
    if (!value || !Array.isArray(value.demands) || !textVal(value.materialModel)) {
        throw new Error('JSON 需包含 materialModel 和 demands，格式与现有切割任务一致。');
    }
    if (value.demands.length > 10000) throw new Error('需求超过 10000 行，请按批次拆分。');
    const result = {
        groups: [],
        issues: [],
        format: '现有任务 JSON · mm',
        name: textVal(value.name),
        externalRef: textVal(value.externalRef)
    };
    value.demands.forEach((line, index) =>
        add(
            result,
            {
                row: index + 1,
                materialModel: textVal(value.materialModel),
                ...(line?.shape == null ? {} : { shape: line.shape }),
                ...(line?.surfaceTreatment == null ? {} : { surfaceTreatment: textVal(line.surfaceTreatment) }),
                ...(line?.dimension == null ? {} : { dimension: line.dimension }),
                name: textVal(line?.name),
                width: line?.width,
                length: line?.length,
                quantity: line?.quantity,
                allowRotation: line?.allowRotation === true
            },
            line?.allowRotation != null && typeof line.allowRotation !== 'boolean' ? 'allowRotation 必须是布尔值' : '',
            { sheetName: 'JSON', column: 'allowRotation', field: 'allowRotation', code: 'INVALID_ROTATION' }
        )
    );
    return finish(result);
}

export function importedTask(result, index, source, selectedIds = null) {
    const group = result.groups[index];
    if (!group?.demands.length) throw new Error('请选择有有效需求的材料型号。');
    const demands = selectedIds === null ? group.demands : group.demands.filter(line => selectedIds.includes(line.id));
    if (!demands.length) throw new Error('请勾选本次需要导入的需求。');
    if (selectedIds && (new Set(selectedIds).size !== demands.length || selectedIds.length !== demands.length)) {
        throw new Error('勾选需求与当前布料不一致，请重新选择。');
    }
    return {
        name: result.name || `${source} · ${group.materialModel}`,
        materialModel: group.materialModel,
        externalRef: result.externalRef || source,
        ...(group.dimension === 'SLITTING_1D' ? { dimension: 'SLITTING_1D' } : {}),
        demands: demands.map(({ id, name, order, width, length, quantity, allowRotation, shape, surfaceTreatment, bomPath, allowHalfTurn }) => ({
            id,
            name: order && !name.includes(order) ? `订单 ${order} · ${name}` : name,
            width,
            length,
            quantity,
            allowRotation,
            ...(shape == null ? {} : { shape }),
            ...(surfaceTreatment == null ? {} : { surfaceTreatment }),
            ...(bomPath == null ? {} : { bomPath }),
            ...(allowHalfTurn == null ? {} : { allowHalfTurn })
        }))
    };
}

/** Include identified fabrics whose rows require correction, without making those rows importable. */
export function importGroups(result) {
    const groups = result.groups.map((group, index) => ({ ...group, index, issues: [] }));
    for (const issue of result.issues) {
        let group = groups.find(g => g.materialModel === issue.model && g.fabricCode === issue.line?.fabricCode);
        if (!group) {
            group = { materialModel: issue.model, fabricCode: issue.line?.fabricCode, demands: [], issues: [], index: -1 };
            groups.push(group);
        }
        group.issues.push(issue);
    }
    return groups.sort(
        (a, b) =>
            Math.min(...a.demands.map(d => d.row), ...a.issues.map(d => d.row)) -
            Math.min(...b.demands.map(d => d.row), ...b.issues.map(d => d.row))
    );
}

export function matchingImportRolls(group, rolls) {
    return rolls.filter(roll => roll.rollModel === group.materialModel && roll.currentRemainingLength > 0 && roll.inspectionStatus !== 'QUARANTINED');
}

/** 标准需求模板（CSV，可用 Excel 打开），列名与 parseDemandSheet 一致。 */
export function demandTemplateCsv() {
    return '\ufeff材料型号,裁片名称,宽度(mm),长度(mm),数量,订单编号,允许旋转\n2#A3A-Cream,示例窗帘,2170,3250,2,SO-0001,否\n';
}
