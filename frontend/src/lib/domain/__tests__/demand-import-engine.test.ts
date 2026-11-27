import { describe, it, expect } from 'vitest';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { createRequire } from 'node:module';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { readFileSync } from 'node:fs';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { fileURLToPath } from 'node:url';
import { decodeTextBuffer, detectCsvDelimiter, parseDelimitedText } from '../demand-import-csv.js';
import { parseHeaderColumn } from '../demand-import-schema.js';
import {
  parseDemandSheet,
  parseDemandCsv,
  inspectDemandWorkbook,
  parseDemandWorkbook,
  parseDemandJSON,
  importedTask
} from '../demand-import-model.js';

const require = createRequire(import.meta.url);
const XLSX = require('../../../vendor/sheetjs/xlsx.mini.min.js');

describe('demand-import-engine', () => {
  it('自动识别 UTF-8 BOM、无 BOM UTF-8 与 GB18030 字节流并正确解码中文', () => {
    const csvUtf8 = '材料型号,裁片名称,宽度(mm),长度(mm),数量\n斜纹布,门幅片,600,1200,4\n';
    const utf8Bytes = new TextEncoder().encode(csvUtf8);
    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes]);

    const resBom = parseDemandCsv(bomBytes);
    expect(resBom.encoding).toBe('utf-8-bom');
    expect(resBom.groups[0].materialModel).toBe('斜纹布');
    expect(resBom.groups[0].demands[0].name).toBe('门幅片');

    const resUtf8 = parseDemandCsv(utf8Bytes.buffer);
    expect(resUtf8.encoding).toBe('utf-8');
    expect(resUtf8.groups[0].demands[0].length).toBe(1200);

    // "材料型号,裁片名称,宽度,长度,数量\n棉布A,前片,500,800,2" 的真实 GB18030 字节序列
    const gbBytes = Uint8Array.from([
      0xb2, 0xc4, 0xc1, 0xcf, 0xd0, 0xcd, 0xba, 0xc5, 0x2c,
      0xb2, 0xc3, 0xc6, 0xac, 0xc3, 0xfb, 0xb3, 0xc6, 0x2c,
      0xbf, 0xed, 0xb6, 0xc8, 0x2c,
      0xb3, 0xa4, 0xb6, 0xc8, 0x2c,
      0xca, 0xfd, 0xc1, 0xbf, 0x0a,
      0xc3, 0xde, 0xb2, 0xbc, 0x41, 0x2c,
      0xc7, 0xb0, 0xc6, 0xac, 0x2c,
      0x35, 0x30, 0x30, 0x2c, 0x38, 0x30, 0x30, 0x2c, 0x32
    ]);
    const decodedGb = decodeTextBuffer(gbBytes);
    expect(decodedGb.encoding).toBe('gb18030');
    const resGb = parseDemandCsv(gbBytes);
    expect(resGb.encoding).toBe('gb18030');
    expect(resGb.groups[0].materialModel).toBe('棉布A');
    expect(resGb.groups[0].demands[0]).toMatchObject({ name: '前片', width: 500, length: 800, quantity: 2 });
  });

  it('支持逗号/分号/制表符自动探测及 RFC 4180 引号转义与引号内换行', () => {
    const semiCsv = [
      'Material;PartName;Width(mm);Length(mm);Qty;Note',
      'MAT-01;"前片;含""加宽""边\n第二行备注";450;900;3;"备注,含逗号"'
    ].join('\r\n');
    expect(detectCsvDelimiter(semiCsv)).toBe(';');
    const parsedSemi = parseDemandCsv(semiCsv);
    expect(parsedSemi.delimiter).toBe(';');
    expect(parsedSemi.groups[0].demands[0].name).toBe('前片;含"加宽"边\n第二行备注');
    expect(parsedSemi.groups[0].demands[0].note).toBe('备注,含逗号');

    const tabCsv = 'SKU\tName\tWidth\tLength\tQty\nM-TAB\t侧片\t300\t700\t5\n';
    expect(detectCsvDelimiter(tabCsv)).toBe('\t');
    const parsedTab = parseDelimitedText(tabCsv);
    expect(parsedTab.delimiter).toBe('\t');
    expect(parsedTab.rows).toHaveLength(2);
  });

  it('支持中英文别名、表头括号单位与 Unit 列混排自动换算至 0.1 mm', () => {
    const rows = [
      ['SKU', 'PartName', 'Width(cm)', 'Length(in)', 'Qty', 'AllowRotation', 'OrderNo', 'Unit'],
      ['FAB-EN-01', 'Panel-A', 50, 10, 4, 'yes', 'SO-100', ''],
      ['FAB-EN-02', 'Panel-B', 1.2, 0.8, 2, 'no', 'SO-101', 'm']
    ];
    const res = parseDemandSheet(rows, { sheetName: 'EN_Sheet' });
    expect(res.groups).toHaveLength(2);
    expect(res.groups[0].demands[0]).toMatchObject({
      width: 500,
      length: 254,
      quantity: 4,
      allowRotation: true,
      order: 'SO-100'
    });
    expect(res.groups[1].demands[0]).toMatchObject({
      width: 1200,
      length: 800,
      quantity: 2,
      allowRotation: false
    });
  });

  it('支持多 Sheet 评分探测、推荐工作表与手动 sheetName + columnOverrides 覆写', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['填表说明'], ['请勿修改表头']]), '说明');
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '数量'],
        ['M-100', '背板', 400, 600, 3],
        ['M-100', '侧板', 300, 500, 4]
      ]),
      '正式订单'
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['ColA', 'ColB', 'ColC', 'ColD', 'ColE'],
        ['CUSTOM-SKU', '定制片', 550, 750, 6]
      ]),
      '自定义列'
    );

    const inspection = inspectDemandWorkbook(book);
    expect(inspection.recommendedSheetName).toBe('正式订单');
    expect(inspection.sheets.find(s => s.sheetName === '正式订单')?.recommended).toBe(true);
    expect(inspection.sheets.find(s => s.sheetName === '说明')?.format).toBe('UNKNOWN');

    const autoParsed = parseDemandWorkbook(book);
    expect(autoParsed.sheetName).toBe('正式订单');
    expect(autoParsed.groups[0].demands).toHaveLength(2);

    const manualParsed = parseDemandWorkbook(book, {
      sheetName: '自定义列',
      columnOverrides: {
        materialModel: 'ColA',
        name: 1,
        width: 2,
        length: 3,
        quantity: 4
      }
    });
    expect(manualParsed.sheetName).toBe('自定义列');
    expect(manualParsed.groups[0].materialModel).toBe('CUSTOM-SKU');
    expect(manualParsed.groups[0].demands[0]).toMatchObject({
      name: '定制片',
      width: 550,
      length: 750,
      quantity: 6
    });
  });

  it('支持 1D 分切订单解析、整型校验与表面处理透传', () => {
    const rows = [
      ['材料型号', '产品类型', '宽度(cm)', '长度(mm)', '数量', '表面处理', '订单号'],
      ['AL-6061', '1D', 12, 2400, 10, '阳极氧化', 'SL-001'],
      ['AL-6061', '1D', 10.55, 2400, 5, '拉丝', 'SL-002']
    ];
    const parsed = parseDemandSheet(rows, { sheetName: '1D分切' });
    expect(parsed.dimension).toBe('SLITTING_1D');
    expect(parsed.groups[0].demands).toHaveLength(1);
    expect(parsed.groups[0].demands[0]).toMatchObject({
      width: 120,
      length: 2400,
      quantity: 10,
      surfaceTreatment: '阳极氧化',
      allowRotation: false
    });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      sheetName: '1D分切',
      rowIndex: 3,
      column: '宽度(cm)',
      code: 'INVALID_DIM'
    });

    const task = importedTask(parsed, 0, 'slitting.xlsx');
    expect(task.dimension).toBe('SLITTING_1D');
    expect(task.demands[0].surfaceTreatment).toBe('阳极氧化');
  });

  it('支持 BOM 多层展开、循环引用 CIRCULAR_BOM 与非法单耗 INVALID_BOM_USAGE 精准行号报错', () => {
    const validBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)'],
      ['SOFA-SET', 'FRAME-ASM', 2, '', '', '', ''],
      ['FRAME-ASM', 'LEG-01', 4, 'WOOD-OAK', '实木支腿', 80, 350],
      ['SOFA-SET', 'CUSHION', 3, 'FABRIC-A', '座垫布', 600, 650]
    ];
    const expanded = parseDemandSheet(validBom, { sheetName: 'BOM表', bomRootQty: 2 });
    expect(expanded.issues).toHaveLength(0);
    const wood = expanded.groups.find(g => g.materialModel === 'WOOD-OAK');
    expect(wood?.demands[0]).toMatchObject({
      quantity: 16, // 2套 * 2框 * 4腿
      bomPath: 'SOFA-SET > FRAME-ASM > LEG-01'
    });
    const cushion = expanded.groups.find(g => g.materialModel === 'FABRIC-A');
    expect(cushion?.demands[0]).toMatchObject({
      quantity: 6,
      bomPath: 'SOFA-SET > CUSHION'
    });

    const badBom = [
      ['Parent', 'Child', 'QtyPer', 'Material', 'PartName', 'Width(mm)', 'Length(mm)'],
      ['A', 'B', 1, '', '', '', ''],
      ['B', 'C', 2, '', '', '', ''],
      ['C', 'A', 1, '', '', '', ''],
      ['D', 'E', 0, 'M-BAD', '零单耗', 100, 200]
    ];
    const badRes = parseDemandSheet(badBom, { sheetName: '坏BOM' });
    const cycleIssue = badRes.issues.find(i => i.code === 'CIRCULAR_BOM');
    expect(cycleIssue).toBeDefined();
    expect(cycleIssue?.sheetName).toBe('坏BOM');
    expect(cycleIssue?.rowIndex).toBe(4);
    expect(cycleIssue?.column).toBe('Child');

    const usageIssue = badRes.issues.find(i => i.code === 'INVALID_BOM_USAGE');
    expect(usageIssue).toBeDefined();
    expect(usageIssue?.sheetName).toBe('坏BOM');
    expect(usageIssue?.rowIndex).toBe(5);
    expect(usageIssue?.column).toBe('QtyPer');
  });

  it('保持 9.28 订单与 JSON 导入向后兼容，且精确输出 sheetName+rowIndex+column+reason', () => {
    const raw928 = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../../src/test/fixtures/9.28-orders.json', import.meta.url)), 'utf8')
    );
    const res928 = parseDemandSheet(raw928, { sheetName: '9.28订单' });
    expect(res928.groups.flatMap(g => g.demands)).toHaveLength(100);
    expect(res928.issues.map(i => i.row)).toEqual([78, 79, 108, 109]);
    expect(res928.issues[0]).toMatchObject({
      sheetName: '9.28订单',
      rowIndex: 78,
      column: expect.any(String),
      reason: expect.any(String)
    });

    const jsonRes = parseDemandJSON({
      name: '标准任务',
      materialModel: 'M-2D',
      demands: [{ name: 'P1', width: 300, length: 400, quantity: 2, allowRotation: false }]
    });
    const task = importedTask(jsonRes, 0, 'test.json');
    expect(Object.keys(task.demands[0])).toEqual(['id', 'name', 'width', 'length', 'quantity', 'allowRotation']);
  });

  it('2D 订单含表面处理列判为 STANDARD_2D 并保留 allowRotation，同时纯 1D 表仍判为 SLITTING_1D', () => {
    const rows2dWithSurface = [
      ['材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '数量', '表面处理', '允许旋转'],
      ['PLATE-A', '面板1', 600.5, 800, 2, '拉丝', '是'],
      ['PLATE-A', '面板2', 400, 500, 3, '阳极氧化', '否']
    ];
    const res2d = parseDemandSheet(rows2dWithSurface, { sheetName: '2D表面处理' });
    expect(res2d.dimension).toBe('RECT_2D');
    expect(res2d.issues).toHaveLength(0);
    expect(res2d.groups[0].demands[0]).toMatchObject({ width: 600.5, allowRotation: true });
    expect(res2d.groups[0].demands[1]).toMatchObject({ allowRotation: false });

    const pure1dRows = [
      ['材料型号', '分切宽度(mm)', '定长(mm)', '数量', '表面处理'],
      ['STRIP-1', 120, 2400, 5, '拉丝']
    ];
    const res1d = parseDemandSheet(pure1dRows, { sheetName: '纯1D分切' });
    expect(res1d.dimension).toBe('SLITTING_1D');
    expect(res1d.groups[0].demands[0].allowRotation).toBe(false);
  });

  it('1D 分切基于未量化原始毫米校验整数，拦截 10.504cm 等亚毫米输入', () => {
    const rows = [
      ['材料型号', '产品类型', '宽度(cm)', '长度(mm)', '数量'],
      ['AL-1', '1D', 10.5, 2000, 2],
      ['AL-1', '1D', 10.504, 2000, 2]
    ];
    const parsed = parseDemandSheet(rows, { sheetName: '1D亚毫米' });
    expect(parsed.groups[0].demands).toHaveLength(1);
    expect(parsed.groups[0].demands[0].width).toBe(105);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      rowIndex: 3,
      field: 'width',
      code: 'INVALID_DIM'
    });
  });

  it('支持菱形 BOM 共享子件规格继承、规格冲突精确报错及混合环零次生 INVALID_DIM 噪音', () => {
    const diamondBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)'],
      ['P', 'A', 2, '', '', '', ''],
      ['P', 'B', 3, '', '', '', ''],
      ['B', 'C', 5, '', '', '', ''], // 省略行在定义行之前，验证反向亦可继承
      ['A', 'C', 4, 'WOOD-C', '共享子板C', 200, 300]
    ];
    const diamondRes = parseDemandSheet(diamondBom, { sheetName: '菱形BOM', bomRootQty: 2 });
    expect(diamondRes.issues).toHaveLength(0);
    const totalC = diamondRes.groups[0].demands.reduce((s: number, d: any) => s + d.quantity, 0);
    expect(totalC).toBe(46); // 2*2*4 + 2*3*5 = 16 + 30 = 46
    expect(diamondRes.groups[0].demands.every((d: any) => d.width === 200 && d.length === 300)).toBe(true);

    const conflictBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '宽度(mm)', '长度(mm)'],
      ['A', 'C', 2, 'M-C', 200, 300],
      ['B', 'C', 3, 'M-C', 250, 300]
    ];
    const conflictRes = parseDemandSheet(conflictBom, { sheetName: '冲突BOM' });
    expect(conflictRes.issues.some((i: any) => i.rowIndex === 3 && i.code === 'INVALID_DIM')).toBe(true);

    const mixedCycleBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '宽度(mm)', '长度(mm)'],
      ['P', 'X', 1, '', '', ''],
      ['X', 'Y', 1, '', '', ''],
      ['Y', 'X', 1, '', '', ''],
      ['P', 'OK', 2, 'M-OK', 300, 400]
    ];
    const cycleRes = parseDemandSheet(mixedCycleBom, { sheetName: '混合环' });
    expect(cycleRes.issues.filter((i: any) => i.code === 'CIRCULAR_BOM')).toHaveLength(1);
    expect(cycleRes.issues.filter((i: any) => i.code === 'INVALID_DIM')).toHaveLength(0);
    expect(cycleRes.groups[0].demands).toHaveLength(1);
    expect(cycleRes.groups[0].demands[0].materialModel).toBe('M-OK');
  });

  it('精确锚定表头单位后缀并容错 CSV 引号前导空白及中文单字“宽/长”别名', () => {
    expect(parseHeaderColumn('order_in_progress').unit).toBeNull();
    expect(parseHeaderColumn('width_in_cm').unit).toBe('cm');
    expect(parseHeaderColumn('length_in').unit).toBe('inch');

    const csv = '材料型号; 裁片名称; 宽(cm); 长(cm); 数量\nMAT-S; "片A;含分号"; 50; 80; 3\n';
    const parsed = parseDemandCsv(csv);
    expect(parsed.delimiter).toBe(';');
    expect(parsed.groups[0].demands[0]).toMatchObject({
      name: '片A;含分号',
      width: 500,
      length: 800,
      quantity: 3
    });
  });

  it('Challenge 1 双向判别：纯 1D（幅宽/条宽+定长 含或不含表面处理）判 SLITTING_1D，2D（含表面处理或旋转）判 RECT_2D', () => {
    for (const widthCol of ['幅宽(mm)', '条宽(mm)']) {
      const res1dSurface = parseDemandSheet(
        [
          ['材料型号', widthCol, '定长(mm)', '数量', '表面处理'],
          ['STRIP-A', 120, 2400, 5, '阳极氧化']
        ],
        { sheetName: `1D-${widthCol}` }
      );
      expect(res1dSurface.dimension).toBe('SLITTING_1D');
      expect(res1dSurface.issues).toHaveLength(0);
      expect(res1dSurface.groups).toHaveLength(1);
      expect(res1dSurface.groups[0].demands[0]).toMatchObject({
        name: 'STRIP-A条',
        width: 120,
        length: 2400,
        quantity: 5,
        allowRotation: false,
        surfaceTreatment: '阳极氧化'
      });

      const res1dNoSurface = parseDemandSheet(
        [
          ['材料型号', widthCol, '定长(mm)', '数量'],
          ['STRIP-B', 90, 1800, 4]
        ],
        { sheetName: `1D-无表面-${widthCol}` }
      );
      expect(res1dNoSurface.dimension).toBe('SLITTING_1D');
      expect(res1dNoSurface.issues).toHaveLength(0);
      expect(res1dNoSurface.groups[0].demands[0]).toMatchObject({
        name: 'STRIP-B条',
        allowRotation: false
      });
    }

    const plate2dNoRotCol = parseDemandSheet(
      [
        ['材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '数量', '表面处理'],
        ['PLATE-B', '面板A', 600, 1200, 3, '拉丝']
      ],
      { sheetName: '2D无旋转列板材' }
    );
    expect(plate2dNoRotCol.dimension).toBe('RECT_2D');
    expect(plate2dNoRotCol.issues).toHaveLength(0);

    const plate2dRollWidthNoFixedLen = parseDemandSheet(
      [
        ['材料型号', '裁片名称', '幅宽(mm)', '长度(mm)', '数量', '表面处理'],
        ['PLATE-C', '面板B', 500, 1000, 2, '电泳']
      ],
      { sheetName: '2D幅宽加通用长' }
    );
    expect(plate2dRollWidthNoFixedLen.dimension).toBe('RECT_2D');
    expect(plate2dRollWidthNoFixedLen.issues).toHaveLength(0);

    const plate2dWithRot = parseDemandSheet(
      [
        ['材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '数量', '表面处理', '允许旋转'],
        ['PLATE-D', '面板C', 600.5, 800, 2, '阳极氧化', '是']
      ],
      { sheetName: '2D含表面与旋转' }
    );
    expect(plate2dWithRot.dimension).toBe('RECT_2D');
    expect(plate2dWithRot.groups[0].demands[0]).toMatchObject({
      width: 600.5,
      allowRotation: true
    });
  });

  it('同源表头单位正则：支持 width_in_cm / width_in_mm(参考) 端到端映射，防误伤 order_in_progress / Check in / Size M', () => {
    expect(parseHeaderColumn('width_in_cm')).toMatchObject({ key: 'width', unit: 'cm' });
    expect(parseHeaderColumn('width_in_mm(参考)')).toMatchObject({ key: 'width', unit: 'mm' });
    expect(parseHeaderColumn('length_in')).toMatchObject({ key: 'length', unit: 'inch' });
    expect(parseHeaderColumn('order_in_progress')).toMatchObject({ key: 'orderinprogress', unit: null });
    expect(parseHeaderColumn('Check in').unit).toBeNull();
    expect(parseHeaderColumn('Size M').unit).toBeNull();

    const parsed = parseDemandSheet(
      [
        ['Material', 'PartName', 'width_in_cm', 'length_in', 'Qty'],
        ['MAT-EN', 'Panel-1', 50, 10, 4]
      ],
      { sheetName: 'EN_IN_UNIT' }
    );
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.groups[0].demands[0]).toMatchObject({
      width: 500,
      length: 254,
      quantity: 4
    });
  });

  it('BOM 共享子件三态旋转继承（是/否/省略）、表面处理合并同组及 INVALID_ROTATION 校验', () => {
    const rotBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '允许旋转'],
      ['P', 'A', 1, '', '', '', '', ''],
      ['P', 'B', 1, '', '', '', '', ''],
      ['P', 'D', 1, '', '', '', '', ''],
      ['A', 'C', 2, 'M-C', '子件C', 200, 300, '是'],
      ['B', 'C', 3, 'M-C', '子件C', 200, 300, '否'],
      ['D', 'C', 4, '', '', '', '', '']
    ];
    const rotRes = parseDemandSheet(rotBom, { sheetName: 'BOM三态旋转' });
    expect(rotRes.issues).toHaveLength(0);
    const byPath = Object.fromEntries(rotRes.groups[0].demands.map((d: any) => [d.bomPath, d.allowRotation]));
    expect(byPath['P > A > C']).toBe(true);
    expect(byPath['P > B > C']).toBe(false);
    expect(byPath['P > D > C']).toBe(true);

    const surfaceBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '表面处理'],
      ['P', 'A', 2, '', '', '', '', ''],
      ['P', 'B', 3, '', '', '', '', ''],
      ['A', 'C', 4, 'STRIP-C', '分条C', 100, 2000, '烤漆'],
      ['B', 'C', 5, '', '', '', '', '']
    ];
    const surfaceRes = parseDemandSheet(surfaceBom, { sheetName: 'BOM表面合并', bomRootQty: 2 });
    expect(surfaceRes.issues).toHaveLength(0);
    expect(surfaceRes.groups).toHaveLength(1);
    expect(surfaceRes.groups[0].dimension).toBe('SLITTING_1D');
    expect(surfaceRes.groups[0].demands).toHaveLength(2);
    expect(surfaceRes.groups[0].demands.reduce((s: number, d: any) => s + d.quantity, 0)).toBe(46);
    expect(surfaceRes.groups[0].demands.every((d: any) => d.surfaceTreatment === '烤漆' && d.allowRotation === false)).toBe(true);

    const badRotBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '允许旋转'],
      ['P', 'C', 2, 'M-C', '子件C', 200, 300, 'maybe']
    ];
    const badRotRes = parseDemandSheet(badRotBom, { sheetName: 'BOM非法旋转' });
    expect(badRotRes.issues).toHaveLength(1);
    expect(badRotRes.issues[0]).toMatchObject({
      rowIndex: 2,
      field: 'allowRotation',
      code: 'INVALID_ROTATION'
    });
  });

  it('混排表前 20 行全为 2D、第 21+ 行出现无裁片名 1D 行时，按行级 rowType 自动补齐缺省条名', () => {
    const rows: any[][] = [
      ['材料型号', '产品类型', '裁片名称', '宽度(mm)', '长度(mm)', '数量']
    ];
    for (let i = 1; i <= 20; i++) {
      rows.push(['MAT-MIX', '2D', `裁片-${i}`, 500, 800, 1]);
    }
    rows.push(['MAT-SLIT', '1D', '', 1200, 1500000, 3]);
    rows.push(['MAT-SLIT', 'SLITTING_1D', '', 900, 1500000, 2]);

    const res = parseDemandSheet(rows, { sheetName: '前20全2D后1D' });
    expect(res.issues).toHaveLength(0);
    expect(res.groups).toHaveLength(2);
    const group2D = res.groups.find((g: any) => g.materialModel === 'MAT-MIX');
    const group1D = res.groups.find((g: any) => g.materialModel === 'MAT-SLIT');
    expect(group2D?.dimension).toBeUndefined();
    expect(group2D?.demands).toHaveLength(20);
    expect(group1D?.dimension).toBe('SLITTING_1D');
    expect(group1D?.demands).toHaveLength(2);
    expect(group1D?.demands[0]).toMatchObject({
      name: 'MAT-SLIT条',
      allowRotation: false
    });
    expect(group1D?.demands[1]).toMatchObject({
      name: 'MAT-SLIT条',
      allowRotation: false
    });
  });

  it('BOM 模式显式传入 productTypeOverride（SLITTING_1D 与 RECT_2D）覆盖默认与表面处理推断', () => {
    const bomWithoutSurface = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)', '允许旋转'],
      ['TOP', 'LEAF-1', 2, 'FILM-01', '膜条A', 800, 1200, '是']
    ];
    const forced1D = parseDemandSheet(bomWithoutSurface, {
      sheetName: 'BOM强制1D',
      productTypeOverride: 'SLITTING_1D'
    });
    expect(forced1D.issues).toHaveLength(0);
    expect(forced1D.dimension).toBe('SLITTING_1D');
    expect(forced1D.groups[0].dimension).toBe('SLITTING_1D');
    expect(forced1D.groups[0].demands[0]).toMatchObject({
      allowRotation: false
    });

    const bomWith1DSignal = [
      ['父件编码', '子件编码', '单耗', '材料型号', '产品类型', '裁片名称', '宽度(mm)', '长度(mm)', '表面处理', '允许旋转'],
      ['TOP', 'LEAF-2', 3, 'PLATE-02', '1D', '面板B', 600, 900, '烤漆', '是']
    ];
    const forced2D = parseDemandSheet(bomWith1DSignal, {
      sheetName: 'BOM强制2D',
      productTypeOverride: 'RECT_2D'
    });
    expect(forced2D.issues).toHaveLength(0);
    expect(forced2D.dimension).toBe('RECT_2D');
    expect(forced2D.groups[0].dimension).toBe('RECT_2D');
    expect(forced2D.groups[0].demands[0]).toMatchObject({
      allowRotation: true,
      surfaceTreatment: '烤漆'
    });
  });

  it('拦截非法的 bomRootQty（-5 / 0 / "abc"）并阻断静默放行，未传或空串维持默认 1', () => {
    const validBom = [
      ['父件编码', '子件编码', '单耗', '材料型号', '裁片名称', '宽度(mm)', '长度(mm)'],
      ['SOFA-SET', 'CUSHION', 3, 'FABRIC-A', '座垫布', 600, 650]
    ];

    for (const badQty of [-5, 0, '0', '-3', 'abc']) {
      const badRes = parseDemandSheet(validBom, { sheetName: 'BOM非法套数', bomRootQty: badQty });
      expect(badRes.groups).toHaveLength(0);
      expect(badRes.issues.length).toBeGreaterThan(0);
      expect(badRes.issues[0]).toMatchObject({
        code: 'INVALID_BOM_ROOT_QTY',
        field: 'bomRootQty',
        sheetName: 'BOM非法套数'
      });
    }

    for (const defaultQty of [undefined, null, '', '   ']) {
      const okRes = parseDemandSheet(validBom, { sheetName: 'BOM默认套数', bomRootQty: defaultQty });
      expect(okRes.issues).toHaveLength(0);
      expect(okRes.groups).toHaveLength(1);
      expect(okRes.groups[0].demands[0].quantity).toBe(3);
    }
  });
});
