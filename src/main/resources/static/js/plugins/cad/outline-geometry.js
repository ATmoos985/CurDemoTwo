import {shapeVertices, rectangle} from '../../nesting/nesting-scene.js';

export function pieceVertices(p, x=p.x, y=p.y) {
    return shapeVertices(p.shape || rectangle(p.w,p.l)).map(v=>({x:v.x+x,y:v.y+y}));
}
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function distance(p,a,b) {
    const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));
    return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
function inside(p,vertices) {
    let result=false;
    for(let i=0,j=vertices.length-1;i<vertices.length;j=i++) {
        const a=vertices[i],b=vertices[j];
        if(distance(p,a,b)<1e-7)return false;
        if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)result=!result;
    }
    return result;
}
export function outlinesConflict(a,b,gap=0) {
    for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){
        const p=a[i],q=a[(i+1)%a.length],r=b[j],s=b[(j+1)%b.length];
        if(cross(p,q,r)*cross(p,q,s)<-1e-8 && cross(r,s,p)*cross(r,s,q)<-1e-8)return true;
        if(gap>0 && Math.min(distance(p,r,s),distance(q,r,s),distance(r,p,q),distance(s,p,q))+.001<gap)return true;
    }
    if(a.some(p=>inside(p,b)) || b.some(p=>inside(p,a)))return true;
    // Probe just inside each edge to detect coincident outlines without rejecting shared boundaries.
    for(const ring of [a,b])for(let i=0;i<ring.length;i++){
        const p=ring[i],q=ring[(i+1)%ring.length],len=Math.hypot(q.x-p.x,q.y-p.y);
        for(const side of [-1,1]){
            const probe={x:(p.x+q.x)/2+side*(q.y-p.y)/len*.0001,y:(p.y+q.y)/2-side*(q.x-p.x)/len*.0001};
            if(inside(probe,a)&&inside(probe,b))return true;
        }
    }
    return false;
}

export function rotateOutlinePiece(piece, demands) {
    if(piece.shape && !demands?.find(d=>d.id===piece.demandId)?.allowRotation)return false;
    if(piece.shape){
        const old=piece.shape;
        piece.shape={...old,width:old.height,height:old.width,vertices:shapeVertices(old).map(v=>({x:old.height-v.y,y:v.x})),type:'POLYGON'};
        piece.rotationDegrees=((piece.rotationDegrees || 0)+90)%360;
    }
    [piece.w,piece.l]=[piece.l,piece.w];piece.rotated=!piece.rotated;
    return true;
}
