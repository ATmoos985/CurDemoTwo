import {rulerStep} from '../canvas/cad-view.js';
import {round, clamp, dragDefect, pointAt, screenRect} from './inspection-model.js';

export function mountInspectionCanvas(container, {onMark, onSelect, onEdit, onBrowse, onPointer, onView, onSize}) {
    const stage=new Konva.Stage({container,width:container.clientWidth,height:container.clientHeight});
    const layer=new Konva.Layer();stage.add(layer);
    let model={roll:null,pending:[],position:0,selected:null,mode:'mark'}, view={left:80,bottom:0,offset:0,scale:.2};
    let following=true, overview=false, anchor=null, preview=null, transforming=false, zoom=1;
    const key=d=>d.captureId || 'saved-'+d.id;
    const text=(value,x,y,options={})=>layer.add(new Konva.Text({text:value,x,y,fontSize:11,fontFamily:'Consolas, Microsoft YaHei',fill:'#637889',listening:false,...options}));
    const line=(points,stroke='#cedae2',options={})=>layer.add(new Konva.Line({points,stroke,strokeWidth:1,listening:false,...options}));
    function layout() {
        const {roll,position}=model;if(!roll)return;
        const w=stage.width(),h=stage.height();view.bottom=h-34;
        if(overview) {view.scale=Math.min((w-180)/roll.width,(h-100)/roll.totalLength);view.offset=0;}
        else if(following) {view.scale=Math.max(.002,(w-230)/roll.width*zoom);view.offset=position-(view.bottom-h*.68)/view.scale;}
        view.left=70+Math.max(0,(w-180-roll.width*view.scale)/2);
    }
    function draw() {
        if(transforming)return;
        layout();layer.destroyChildren();
        const {roll,pending,position,selected,mode}=model,w=stage.width(),h=stage.height();
        layer.add(new Konva.Rect({width:w,height:h,fill:'#f2f6f8',listening:false}));
        if(!roll){layer.draw();return;}
        const k=view.scale,right=view.left+roll.width*k,sy=y=>view.bottom-(y-view.offset)*k;
        const low=Math.max(0,view.offset),high=Math.min(roll.totalLength,view.offset+view.bottom/k);
        layer.add(new Konva.Rect({name:'inspection-cloth',x:view.left,y:sy(roll.totalLength),width:roll.width*k,height:roll.totalLength*k,fill:'#fff',stroke:'#93aebb',strokeWidth:1,listening:false}));
        const step=rulerStep(k);
        for(let y=Math.ceil(low/step)*step;y<=high;y+=step) {line([view.left,sy(y),right,sy(y)],'#e7eef2');text((y/1000).toFixed(2)+' m',view.left-58,sy(y)-6,{width:50,align:'right'});}
        for(let x=0;x<=roll.width;x+=step) line([view.left+x*k,Math.max(0,sy(high)),view.left+x*k,Math.min(h,sy(low))],'#f1f5f7');
        let selectedNode=null;
        const all=[...(roll.defects || []).map(d=>({...d,saved:true})),...pending];
        for(const d of all) {
            if(d.y+d.h<low || d.y>high)continue;
            const r=screenRect(d,view),active=key(d)===selected,color=active?'#285f79':d.saved?'#9b6d6d':'#ba5555';
            const group=new Konva.Group();
            group.add(new Konva.Rect({x:r.x-d.margin*k,y:r.y-d.margin*k,width:r.width+2*d.margin*k,height:r.height+2*d.margin*k,fill:'#bf5b5b0b',stroke:'#c6818180',dash:[4,3],strokeWidth:1,listening:false}));
            const rect=new Konva.Rect({...r,name:'inspection-defect',defectKey:key(d),fill:active?'#387b9e40':d.saved?'#b36e6e40':'#c4626260',stroke:color,strokeWidth:active?2:1,hitStrokeWidth:10,draggable:mode==='select'&&!d.saved});group.add(rect);layer.add(group);
            if(r.width>35&&r.height>20)line([r.x,r.y,r.x+r.width,r.y+r.height],color);
            if(r.width>60&&r.height>34)text(d.typeName || '疵点',r.x+5,r.y+6,{fill:color,width:r.width-10,ellipsis:true,wrap:'none'});
            rect.on('click tap',()=>{if(mode==='select')onSelect(key(d));});
            rect.on('dragstart transformstart',()=>{transforming=true;onBrowse();});
            rect.on('dragend transformend',()=>{
                const width=Math.abs(rect.width()*rect.scaleX()),height=Math.abs(rect.height()*rect.scaleY());
                transforming=false;
                onEdit(key(d),{...d,x:round((rect.x()-view.left)/k),y:round(view.offset+(view.bottom-rect.y()-height)/k),w:round(width/k),h:round(height/k)});
                draw();
            });
            if(active&&!d.saved&&mode==='select')selectedNode=rect;
        }
        if(selectedNode){const tr=new Konva.Transformer({nodes:[selectedNode],rotateEnabled:false,flipEnabled:false,keepRatio:false,enabledAnchors:['top-left','top-right','bottom-left','bottom-right'],anchorSize:9,borderStroke:'#285f79',anchorStroke:'#285f79',boundBoxFunc:(old,next)=>next.width<1||next.height<1?old:next});layer.add(tr);}
        if(preview){const r=screenRect(preview,view);layer.add(new Konva.Rect({...r,fill:'#285f7920',stroke:'#285f79',dash:[5,3],strokeWidth:2,listening:false}));}
        const feedY=sy(position);
        if(feedY>=25&&feedY<h-20){
            line([view.left,feedY,right+12,feedY],'#285f79',{name:'inspection-feed-line',strokeWidth:1.5});
            for(let x=0;x<=roll.width;x+=step/2){const px=right-x*k;line([px,feedY-6,px,feedY+6],'#285f79');if(Math.round(x/(step/2))%2===0)text(String(round(x)),px-25,feedY+10,{width:50,align:'center',fill:'#285f79'});}
            const labelX=Math.min(right+14,w-96);
            layer.add(new Konva.Rect({x:labelX-4,y:feedY-23,width:93,height:42,fill:'#285f79',cornerRadius:3,listening:false}));
            text((position/1000).toFixed(3)+' m',labelX,feedY-16,{fill:'#fff',fontSize:13});text('累计跑布 · 距右 mm',labelX,feedY+2,{fill:'#d4e5ed',fontSize:9});
        }
        if(sy(0)<h&&sy(0)>0)text('卷头 0 m · 右侧为横向基准',view.left+6,sy(0)+9,{fill:'#285f79'});
        const mapTop=35,mapHeight=h-80,mapBottom=mapTop+mapHeight;
        layer.add(new Konva.Rect({x:14,y:mapTop,width:15,height:mapHeight,fill:'#dce6eb',cornerRadius:2}));
        layer.add(new Konva.Rect({x:14,y:mapBottom-position/roll.totalLength*mapHeight,width:15,height:position/roll.totalLength*mapHeight,fill:'#83ac9e',listening:false}));
        for(const d of all)line([12,mapBottom-d.y/roll.totalLength*mapHeight,31,mapBottom-d.y/roll.totalLength*mapHeight],d.saved?'#ac7777':'#b04949');
        layer.add(new Konva.Rect({x:11,y:mapBottom-high/roll.totalLength*mapHeight,width:21,height:Math.max(3,(high-low)/roll.totalLength*mapHeight),stroke:'#285f79',strokeWidth:1.5,listening:false}));
        const mapHit=new Konva.Rect({x:5,y:mapTop,width:32,height:mapHeight,fill:'#ffffff00'});layer.add(mapHit);
        mapHit.on('click',()=>locateY(clamp((mapBottom-stage.getPointerPosition().y)/mapHeight*roll.totalLength,0,roll.totalLength)));
        text('全卷',7,12,{fontSize:10});text((roll.totalLength/1000).toFixed(0)+'m',7,h-26,{fontSize:10});
        layer.draw();onView(`${overview?'全卷':following?'跟随验布线':'浏览'} · ${(low/1000).toFixed(2)}–${(high/1000).toFixed(2)} m · ${(k*100).toFixed(1)}%`);
    }
    function locateY(y){onBrowse();overview=false;following=false;view.scale=Math.max(.002,(stage.width()-230)/model.roll.width);view.offset=y-(stage.height()/2-34)/view.scale;draw();}
    function pointer(event){const box=container.getBoundingClientRect();return pointAt({x:event.clientX-box.left,y:event.clientY-box.top},view);}
    container.addEventListener('pointerdown',event=>{
        if(event.button!==0||model.mode!=='mark'||!model.roll||event.target.closest('button'))return;
        const p=pointer(event);if(p.x<0||p.x>model.roll.width||p.y<0||p.y>model.roll.totalLength)return;
        anchor=p;container.setPointerCapture(event.pointerId);event.preventDefault();container.focus();
    });
    container.addEventListener('pointermove',event=>{
        if(!model.roll)return;const p=pointer(event);onPointer(p);
        if(!anchor)return;
        try{preview=dragDefect(anchor,{x:clamp(p.x,0,model.roll.width),y:clamp(p.y,0,model.roll.totalLength)},model.roll);onSize(`${preview.w} × ${preview.h} mm · 距卷头 ${preview.y} mm`);draw();}catch{preview=null;}
    });
    container.addEventListener('pointerup',event=>{
        if(!anchor)return;
        const p=pointer(event);let defect=null;
        try{defect=dragDefect(anchor,{x:clamp(p.x,0,model.roll.width),y:clamp(p.y,0,model.roll.totalLength)},model.roll);}catch{}
        cancel();if(defect)onMark(defect);if(container.hasPointerCapture(event.pointerId))container.releasePointerCapture(event.pointerId);
    });
    function cancel(){anchor=null;preview=null;onSize('');draw();}
    container.addEventListener('pointercancel',cancel);
    container.addEventListener('wheel',event=>{
        if(!model.roll)return;event.preventDefault();if(anchor||transforming)return;onBrowse();overview=false;following=false;
        if(event.ctrlKey){const box=container.getBoundingClientRect(),p=pointAt({x:event.clientX-box.left,y:event.clientY-box.top},view);view.scale=clamp(view.scale*(event.deltaY>0?.9:1.1),.002,3);view.offset=p.y-(view.bottom-(event.clientY-box.top))/view.scale;}
        else view.offset=clamp(view.offset+event.deltaY/view.scale*.6,-model.roll.width,model.roll.totalLength);
        draw();
    },{passive:false});
    new ResizeObserver(()=>{stage.size({width:container.clientWidth,height:container.clientHeight});draw();}).observe(container);
    return {
        set(next){model={...model,...next};draw();},cancel,
        follow(){overview=false;following=true;zoom=1;draw();},
        overview(){onBrowse();overview=true;following=false;draw();},
        locate(d){locateY(d.y+d.h/2);},
        isDrawing:()=>!!anchor||transforming
    };
}
