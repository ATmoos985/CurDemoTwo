/** Import only demand facts. Inventory, defects, reports and task identities are never imported. */
const text = value => String(value ?? '').trim();
const positive = value => ['number','string'].includes(typeof value) && text(value) !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const cm = value => Math.round(Number(value) * 1000000) / 100000;

export function parseDemandSheet(rows) {
    if (rows.length > 10001) throw new Error('工作表超过 10000 行，请按批次拆分。');
    const header = rows.findIndex(row => text(row[2]).replace(/\s/g,'') === '订单编号' && text(row[4]).replace(/\s/g,'') === '供应商编号');
    if (header >= 0) return parseCurtainRows(rows, header + 1);
    const standard = rows.findIndex(row => row.includes('材料型号') && row.includes('宽度(mm)') && row.includes('长度(mm)'));
    if (standard < 0) throw new Error('未识别表头。请选择 9.28 订单格式，或下载标准需求模板。');
    const columns = rows[standard].map(text), at = (row, name) => row[columns.indexOf(name)];
    const result = {groups:[], issues:[], format:'标准需求表 · mm'};
    rows.slice(standard + 1).forEach((row, index) => {
        if (!row.some(value => text(value))) return;
        const rotation = text(at(row, '允许旋转'));
        add(result, {row:standard + index + 2, materialModel:text(at(row, '材料型号')), name:text(at(row, '裁片名称')),
            width:at(row, '宽度(mm)'), length:at(row, '长度(mm)'), quantity:at(row, '数量'),
            order:text(at(row, '订单编号')), allowRotation:['是','true','1'].includes(rotation)},
        !['','否','false','0','是','true','1'].includes(rotation) ? '允许旋转只能填是或否' : '');
    });
    return finish(result);
}

function parseCurtainRows(rows, start) {
    const result = {groups:[], issues:[], format:'9.28 订单格式 · cm → mm'};
    rows.slice(start).forEach((row, index) => {
        // Header continuations / formatting-only rows have no order or sequence.
        if (!text(row[2]) && (!positive(row[0]) || ![3,4,7,8,13,15].some(column => text(row[column])))) return;
        const number = start + index + 1, pair = text(row[10]), direction = text(row[12]);
        const cutWidth = pair === '双' ? row[15] : row[13], splice = pair === '双' ? row[16] : row[14];
        let error = !text(row[2]) ? '缺少订单编号' : !['单','双'].includes(pair) ? '单片 / 双片未填写或无法识别'
            : !(direction === '横裁' || (!direction && text(row[11]).toUpperCase() === 'RH')) ? '裁切方向未确认；当前只转换 RH 横裁订单'
            : !positive(cutWidth) || !positive(row[17]) ? '缺少有效裁布宽度或裁布高度'
            : !positive(row[9]) || !Number.isSafeInteger(Number(row[9])) ? '订单支数必须是正整数' : '';
        const note = Number(splice) > 1 ? `最多拼接 ${splice} 片；保留整片需求，未自动拆片` : '';
        add(result, {row:number, materialModel:text(row[4]), order:text(row[2]),
            name:`订单 ${text(row[2])} · ${text(row[3])} · 第 ${number} 行`,
            width:cm(row[17]), length:cm(cutWidth), quantity:Number(row[9]) * (pair === '双' ? 2 : 1),
            allowRotation:false, note}, error);
    });
    return finish(result);
}

function add(result, line, error = '') {
    error ||= !line.materialModel ? '缺少材料型号' : !line.name ? '缺少裁片名称'
        : !positive(line.width) || !positive(line.length) ? '宽度、长度必须大于 0'
        : !positive(line.quantity) || !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) > 2147483647 ? '数量必须是有效正整数' : '';
    if (error) {result.issues.push({row:line.row, model:line.materialModel, message:error});return;}
    let group = result.groups.find(item => item.materialModel === line.materialModel);
    if (!group) {group = {materialModel:line.materialModel, demands:[]};result.groups.push(group);}
    group.demands.push({...line, id:line.row, width:Number(line.width), length:Number(line.length), quantity:Number(line.quantity)});
}

function finish(result) {
    if (!result.groups.length && !result.issues.length) throw new Error('工作表没有可导入的需求行。');
    return result;
}

export function parseDemandJSON(value) {
    if (!value || !Array.isArray(value.demands) || !text(value.materialModel)) throw new Error('JSON 需包含 materialModel 和 demands，格式与现有切割任务一致。');
    if (value.demands.length > 10000) throw new Error('需求超过 10000 行，请按批次拆分。');
    const result = {groups:[], issues:[], format:'现有任务 JSON · mm', name:text(value.name), externalRef:text(value.externalRef)};
    value.demands.forEach((line, index) => add(result, {row:index + 1, materialModel:text(value.materialModel),
        name:text(line?.name), width:line?.width, length:line?.length, quantity:line?.quantity,
        allowRotation:line?.allowRotation === true}, line?.allowRotation != null && typeof line.allowRotation !== 'boolean' ? 'allowRotation 必须是布尔值' : ''));
    return finish(result);
}

export function importedTask(result, index, source) {
    const group = result.groups[index];
    if (!group?.demands.length) throw new Error('请选择有有效需求的材料型号。');
    return {name:result.name || `${source} · ${group.materialModel}`, materialModel:group.materialModel,
        externalRef:result.externalRef || source,
        demands:group.demands.map(({id, name, order, width, length, quantity, allowRotation}) => ({id,
            name:order && !name.includes(order) ? `订单 ${order} · ${name}` : name,
            width, length, quantity, allowRotation}))};
}
