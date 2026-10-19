import test from 'node:test';
import assert from 'node:assert/strict';
import {dragDefect,validateDefect,pointAt,screenRect,advance} from '../../main/resources/static/js/inspection/inspection-model.js';
const roll={width:2000,totalLength:100000};
test('drag in either direction records whole-roll geometry at tenth-millimetre resolution',()=>{
    const a={x:200.1,y:15550.2},b={x:400.3,y:15000.1};
    assert.deepEqual(dragDefect(a,b,roll),dragDefect(b,a,roll));
    assert.deepEqual(dragDefect(a,b,roll),{x:200.1,y:15000.1,w:200.2,h:550.1,margin:20});
});
test('panning and zooming preserve the physical point and right-edge distance',()=>{
    const d={x:100.1,y:15000.2,w:200.3,h:300.4};
    for(const v of [{left:80,bottom:700,offset:14000,scale:.2},{left:160,bottom:650,offset:10000,scale:.05}]){
        const r=screenRect(d,v);assert.deepEqual(pointAt({x:r.x,y:r.y+r.height},v),{x:d.x,y:d.y});
        assert.equal(Math.round((roll.width-d.x-d.w)*10)/10,1699.6);
    }
});
test('rejects outside, zero-size and nonfinite marks',()=>{
    for(const d of [{x:-1,y:0,w:10,h:10,margin:0},{x:0,y:99990,w:10,h:11,margin:0},{x:0,y:0,w:0,h:10,margin:0},{x:0,y:0,w:1,h:10,margin:NaN},{x:0,y:0,w:.15,h:10,margin:0}])assert.throws(()=>validateDefect(d,roll));
});
test('constant-speed feed uses elapsed time and stops at roll end',()=>{
    assert.equal(advance(1000,3,2,100000),1100);
    assert.equal(advance(99990,3,2,100000),100000);
    assert.throws(()=>advance(0,-1,1,100000));
});
