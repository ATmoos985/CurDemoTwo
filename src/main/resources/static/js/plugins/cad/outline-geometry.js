import {rotateShape} from '../../canvas/outline-geometry.js';
import {shapeVertices} from '../../canvas/nesting-scene.js';
export {pieceVertices, outlinesConflict} from '../../canvas/outline-geometry.js';

export function rotateOutlinePiece(piece, demands) {
    if(piece.shape && !demands?.find(d=>d.id===piece.demandId)?.allowRotation)return false;
    if(piece.shape){
        const old=piece.shape;
        piece.shape=rotateShape({...old,type:'POLYGON',vertices:shapeVertices(old)},90);
        piece.rotationDegrees=((piece.rotationDegrees || 0)+90)%360;
    }
    [piece.w,piece.l]=[piece.l,piece.w];piece.rotated=!piece.rotated;
    return true;
}
