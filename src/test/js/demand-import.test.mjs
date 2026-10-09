import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseDemandSheet, parseDemandJSON, importedTask, importGroups, matchingImportRolls} from '../../main/resources/static/js/plugins/solver/demand-import-model.js';
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
    assert.equal(result.groups.length,2);assert.equal(result.issues[0].row,4);assert.match(result.issues[0].message,/裁切方向未确认/);
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


test('the original 9.28 order cells identify 27 fabrics and preserve all 104 source rows', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/9.28-orders.json',import.meta.url)));
    const result = parseDemandSheet(raw), groups = importGroups(result);
    assert.equal(groups.filter(g=>g.materialModel).length,27);
    assert.equal(groups.length,28);
    assert.equal(result.groups.flatMap(g=>g.demands).length,100);
    assert.deepEqual(result.issues.map(i=>i.row),[78,79,108,109]);
    assert.equal(result.groups.flatMap(g=>g.demands).reduce((n,d)=>n+d.quantity,0),156);
    const cream = result.groups.find(g=>g.fabricCode === '893292');
    assert.equal(cream.demands.length,11);
    assert.equal(cream.demands.reduce((n,d)=>n+d.quantity,0),23);
    const line13=cream.demands.find(d=>d.row===13);
    assert.deepEqual([line13.width,line13.length,line13.quantity],[2715,2930,4]);
    assert.equal(groups.find(g=>g.fabricCode==='894512').issues.length,2);
    assert.equal(groups.at(-1).fabricCode,'待定');
});
test('only checked rows from the selected fabric enter the current task', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/9.28-orders.json',import.meta.url)));
    const result = parseDemandSheet(raw), index = result.groups.findIndex(g=>g.fabricCode==='893292');
    const task = importedTask(result,index,'9.28.xlsx',[10,13]);
    assert.deepEqual(task.demands.map(d=>d.id),[10,13]);
    assert.equal(task.demands.reduce((n,d)=>n+d.quantity,0),6);
    assert.throws(()=>importedTask(result,index,'9.28.xlsx',[6,13]),/不一致/);
    assert.throws(()=>importedTask(result,index,'9.28.xlsx',[]),/勾选/);
    assert.throws(()=>importedTask(result,index,'9.28.xlsx',[10,10]),/不一致/);
});
test('inventory matches exact models, never similar colors or names, and excludes unusable stock', () => {
    const group={materialModel:'2#1A-Off White'};
    const rolls=[
        {rollId:'yes',rollModel:group.materialModel,currentRemainingLength:1000},
        {rollId:'similar',rollModel:group.materialModel+' NEW',currentRemainingLength:1000},
        {rollId:'empty',rollModel:group.materialModel,currentRemainingLength:0},
        {rollId:'blocked',rollModel:group.materialModel,currentRemainingLength:1000,inspectionStatus:'QUARANTINED'}
    ];
    assert.deepEqual(matchingImportRolls(group,rolls).map(r=>r.rollId),['yes']);
});
test('different fabric codes stay separate even if a supplier model name is reused', () => {
    const a=row(),b=row();b[3]='F-2';
    assert.equal(parseDemandSheet([header,a,b]).groups.length,2);
});
