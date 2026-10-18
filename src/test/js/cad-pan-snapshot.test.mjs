import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheOverviewPan} from '../../main/resources/static/js/plugins/cad/cad-pan-snapshot.js';

function fixture() {
    let x=50,y=50,scale=1,width=800,overview=true,draws=0,replays=0;
    const handlers={}, context={save(){},restore(){},setTransform(){},clearRect(){},drawImage(){replays++;}};
    const stage={on(name,fn){handlers[name]=fn;},x:()=>x,y:()=>y,scaleX:()=>scale,scaleY:()=>scale,width:()=>width,height:()=>600};
    const canvas={getWidth:()=>800,getHeight:()=>600,getElement:()=>({}),getPixelRatio:()=>1,getContext:()=>context};
    const layer={drawScene(){draws++;return this;},batchDraw(){},fire(){},getNativeCanvasElement:()=>({}),getCanvas:()=>canvas};
    for(const key of ['x','y','rotation','skewX','skewY','offsetX','offsetY']) layer[key]=()=>0;
    layer.scaleX=layer.scaleY=()=>1;
    layer.hasStroke=()=>false;
    layer.getSelfRect=()=>({x:0,y:0,width:100,height:100});
    const previous=globalThis.document;
    globalThis.document={createElement:()=>({getContext:()=>({drawImage(){}})})};
    const invalidate=cacheOverviewPan(layer,stage,()=>overview);
    return {layer,stage,invalidate,draws:()=>draws,replays:()=>replays,
        start:()=>handlers['dragstart.pan-snapshot']({target:stage}),end:()=>handlers['dragend.pan-snapshot']({target:stage}),
        move:(dx,dy)=>{x+=dx;y+=dy;},zoom:()=>{scale=2;},resize:()=>{width=900;},station:()=>{overview=false;},
        cleanup:()=>{globalThis.document=previous;}};
}
test('overview pan replays integer pixels, but fractional movement uses original geometry',()=>{
    const f=fixture();try {
        f.start();assert.equal(f.draws(),1);
        f.move(4,3);f.layer.drawScene();assert.equal(f.replays(),1);assert.equal(f.draws(),1);
        f.move(.25,0);f.layer.drawScene();assert.equal(f.draws(),2);
        f.end();f.layer.drawScene();assert.equal(f.draws(),3);
    }finally{f.cleanup();}
});
test('content invalidation, zoom, resize and explicit target each fall back',()=>{
    for(const mutation of ['invalidate','zoom','resize','station']) {
        const f=fixture();try {f.start();f[mutation]();f.layer.drawScene();assert.equal(f.draws(),2);assert.equal(f.replays(),0);}finally{f.cleanup();}
    }
    const f=fixture();try {f.start();f.layer.drawScene({exportCanvas:true});assert.equal(f.draws(),2);}finally{f.cleanup();}
});
test('partly clipped entities and station view never capture an incomplete image',()=>{
    const f=fixture();try {
        f.layer.getSelfRect=()=>({x:-51,y:0,width:100,height:100});f.start();f.layer.drawScene();assert.equal(f.draws(),1);
        f.layer.getSelfRect=()=>({x:0,y:0,width:100,height:100});f.station();f.start();f.layer.drawScene();assert.equal(f.draws(),2);
        assert.equal(f.replays(),0);
    }finally{f.cleanup();}
});
