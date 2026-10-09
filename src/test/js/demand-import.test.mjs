import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseDemandSheet, parseDemandJSON, importedTask} from '../../main/resources/static/js/plugins/solver/demand-import-model.js';
const require = createRequire(import.meta.url);
const XLSX = require('../../main/resources/static/vendor/sheetjs/xlsx.mini.min.js');
const header = ['序号','缝纫方式','订单\n编号','布料\n编号','供应\n商\n编号'];
const row = (pair='单', model='布料 A') => [1,'AG','O-1','F-1',model,0,0,200,220,3,pair,'RH','横裁',500,2,260,1,231.3];
const standard = ['订单编号','材料型号','裁片名称','宽度(mm)','长度(mm)','数量','允许旋转'];

test('RH maps cut height to physical roll width, cm to mm, and pairs to quantity without rotation', () => {
    const result = parseDemandSheet([header,[],[],[],[],row(),row('双')]);
    const [single, pair] = result.groups[0].demands;
    assert.equal(single.width,2313);assert.equal(single.length,5000);assert.equal(single.quantity,3);
    assert.equal(pair.length,2600);assert.equal(pair.quantity,6);assert.equal(pair.allowRotation,false);
    assert.equal(single.row,6);assert.match(single.note,/未自动拆片/);assert.equal(result.issues.length,0);
});
test('material groups stay separate and incomplete rows remain visible as issues', () => {
    const missing = row();missing[11]='';missing[12]='';
    const result = parseDemandSheet([header,row(),row('双','布料 B'),missing]);
    assert.equal(result.groups.length,2);assert.deepEqual(result.issues,[{row:4,model:'布料 A',message:'裁切方向未确认；当前只转换 RH 横裁订单'}]);
    assert.equal(importedTask(result,1,'input.xlsx / Sheet1').demands.length,1);
});
test('merged header continuations, numbered empty rows and totals are not mistaken for orders', () => {
    const continued=[];continued[7]='轨道\n宽度\nCM';
    const blank=[];blank[0]=105;blank[9]=115;blank[17]=0;
    const total=[];total[7]='合计';
    const parsed=parseDemandSheet([header,continued,row(),blank,total]);
    assert.equal(parsed.issues.length,0);assert.equal(parsed.groups[0].demands.length,1);
});
test('invalid dimensions, fractional base quantities and ambiguous pair values cannot become orders', () => {
    for (const [column,value] of [[9,.5],[9,true],[10,''],[13,0],[17,'bad']]) {
        const invalid = row();invalid[column]=value;
        assert.equal(parseDemandSheet([header,invalid]).groups.length,0);
    }
});
test('standard template has explicit mm units, requires integral quantities and parses rotation', () => {
    const result = parseDemandSheet([standard,['O','M','裁片',600,800,2,'否'],['O','M','可转',200,300,1,'是'],['O','M','错误',200,300,1.5,'否']]);
    assert.equal(result.groups[0].demands[0].width,600);assert.equal(result.groups[0].demands[1].allowRotation,true);
    assert.equal(result.issues.length,1);
    assert.equal(importedTask(result,0,'需求表.csv').demands[0].name,'订单 O · 裁片');
});
test('JSON imports fresh demand facts, excluding identity, reports, completed counts, source material and defects', () => {
    const result = parseDemandJSON({id:'old',revision:5,name:'任务',materialModel:'M',completed:{9:2},defects:[{}],demands:[{id:9,name:'裁片',width:600,length:800,quantity:3,allowRotation:false}]});
    assert.deepEqual(importedTask(result,0,'file.json'), {name:'任务',materialModel:'M',externalRef:'file.json',demands:[{id:1,name:'裁片',width:600,length:800,quantity:3,allowRotation:false}]});
    assert.throws(()=>parseDemandJSON({demands:[]}),/materialModel/);
    assert.throws(()=>parseDemandSheet([['其他报表'],['任意文字']]),/未识别/);
});
test('vendored reader supports real XLSX roundtrip and UTF-8 CSV template in Chinese', () => {
    const workbook = XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([header,row('双')]),'订单');
    const bytes=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
    const decoded=XLSX.read(bytes,{type:'buffer'});
    assert.equal(parseDemandSheet(XLSX.utils.sheet_to_json(decoded.Sheets['订单'],{header:1})).groups[0].demands[0].quantity,6);
    const csv=XLSX.read(Buffer.from('\ufeff'+standard.join(',')+'\r\nO,布料,窗帘,600,800,2,否'),{type:'buffer'});
    assert.equal(parseDemandSheet(XLSX.utils.sheet_to_json(csv.Sheets[csv.SheetNames[0]],{header:1})).groups[0].materialModel,'布料');
});

test('evaluateModelMatches accurately classifies roll match, oversize, and alternative inventory rolls', async () => {
    const {evaluateModelMatches, importedTasks} = await import('../../main/resources/static/js/plugins/solver/demand-import-model.js');
    const groups = [
        {materialModel:'2#1A-Off White', demands:[{id:1,width:2500,length:3000,quantity:2}]},
        {materialModel:'2#A3A-Cream', demands:[{id:2,width:2900,length:3200,quantity:3}]},
        {materialModel:'DEMO-LINEN', demands:[{id:3,width:1800,length:2000,quantity:1}]}
    ];
    const targetRoll = {rollId:'ROLL-1', rollModel:'2#1A-Off White', width:2800};
    const allRolls = [targetRoll, {rollId:'ROLL-2', rollModel:'2#A3A-Cream', width:2800}];

    const matches = evaluateModelMatches(groups, targetRoll, allRolls);
    assert.equal(matches.length, 3);
    assert.equal(matches[0].matchStatus, 'MATCHED');
    assert.match(matches[0].statusText, /当前母卷可切/);

    // 针对Cream母卷测试超幅
    const creamRoll = {rollId:'ROLL-2', rollModel:'2#A3A-Cream', width:2800};
    const creamMatches = evaluateModelMatches(groups, creamRoll, allRolls);
    assert.equal(creamMatches[1].matchStatus, 'OVERSIZE');
    assert.match(creamMatches[1].statusText, /幅宽超限/);

    // 批量抽取任务
    const result = {groups, format:'标准'};
    const tasks = importedTasks(result, [0, 1], '测试批次');
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].materialModel, '2#1A-Off White');
    assert.equal(tasks[1].materialModel, '2#A3A-Cream');
});

