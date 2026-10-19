import test from 'node:test';
import assert from 'node:assert/strict';
import {polygon,rectangle} from '../../main/resources/static/js/nesting/nesting-scene.js';
import {layoutMetrics} from '../../main/resources/static/js/plugins/solver/material-accounting.js';
import {createWorkspaceScene} from '../../main/resources/static/js/plugins/cad/workspace-scene.js';
import {outlinesConflict,pieceVertices,rotateOutlinePiece} from '../../main/resources/static/js/plugins/cad/outline-geometry.js';
import {reportRecoveryCandidates,restoreRecordedGeometry} from '../../main/resources/static/js/plugins/solver/report-outcomes.js';
import {parseDemandJSON,importedTask} from '../../main/resources/static/js/plugins/solver/demand-import-model.js';
import {ticketBlueprint} from '../../main/resources/static/js/plugins/export/cut-ticket-model.js';
const shape=polygon([{x:0,y:0},{x:200,y:0},{x:0,y:200}]);
const piece={id:1,demandId:1,name:'衣片',x:0,y:5000,w:200,l:200,shape,rotationDegrees:0};

test('workbench geometry, net area and oblique cuts remain polygons at nonzero station offsets',()=>{
 const data={rollW:1500,bedL:1000,windowStartY:5000,totalRollL:30000,pieces:[piece],cuts:[{step:1,type:'轮廓切',startX:200,startY:5000,endX:0,endY:5200}]};
 const model=createWorkspaceScene(data);assert.deepEqual(model.scene.placements[0].shape,shape);assert.equal(model.scene.cuts.length,1);
 assert.equal(layoutMetrics(data).pieceArea,.02);assert.equal(layoutMetrics(data).deductLen,200);
});
test('concave outlines may interlock while real overlaps and insufficient gaps are rejected',()=>{
 const l=polygon([{x:0,y:0},{x:200,y:0},{x:200,y:100},{x:100,y:100},{x:100,y:200},{x:0,y:200}]);
 const a=pieceVertices({...piece,x:0,y:0,shape:l});
 assert.equal(outlinesConflict(a,pieceVertices({x:110,y:110,w:80,l:80})),false);
 assert.equal(outlinesConflict(a,a),true);
 assert.equal(outlinesConflict(a,pieceVertices({x:210,y:0,w:80,l:80}),11),true);
 assert.equal(outlinesConflict(a,pieceVertices({x:210,y:0,w:80,l:80}),10),false);
});
test('grain permission owns rotation and rotated outline matches its bounding dimensions',()=>{
 const p={...piece};assert.equal(rotateOutlinePiece(p,[{id:1,allowRotation:false}]),false);assert.equal(p.rotationDegrees,0);
 assert.equal(rotateOutlinePiece(p,[{id:1,allowRotation:true}]),true);assert.equal(p.rotationDegrees,90);assert.equal(p.rotated,true);
 assert.deepEqual(p.shape.vertices,[{x:200,y:0},{x:200,y:200},{x:0,y:0}]);
});
test('report reload preserves shapes and uncut polygons cannot become bounding-box remnants',()=>{
 assert.deepEqual(reportRecoveryCandidates({pieces:[piece]},[{pieceId:1,outcome:'UNCUT'}],6000),[]);
 const data={rollId:'R',pieces:[],remnants:[]};restoreRecordedGeometry(data,[{rollId:'R',feedPortType:'roll',planId:'P',status:'CONFIRMED',windowStartY:5000,pieceResults:[{...piece,y:0,pieceId:1,outcome:'QUALIFIED'}]}],[]);
 assert.deepEqual(data.pieces[0].shape,shape);assert.equal(data.pieces[0].y,5000);
});
test('JSON demand import and printed work orders keep actual outlines and oblique endpoints',()=>{
 const imported=importedTask(parseDemandJSON({materialModel:'布',demands:[{name:'衣片',width:200,length:200,quantity:2,allowRotation:false,shape}]}),0,'test');
 assert.deepEqual(imported.demands[0].shape,shape);
 const svg=ticketBlueprint({request:{rollW:1500,rollL:1000},pieces:[{...piece,y:0}],remnants:[],cuts:[{type:'轮廓切',startX:200,startY:0,endX:0,endY:200}]});
 assert.ok(svg.includes('<polygon'));assert.ok(svg.includes('x1="36" y1="0" x2="0" y2="36"'));
});
