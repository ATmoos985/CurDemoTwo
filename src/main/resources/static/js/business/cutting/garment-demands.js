import {MARKER_STYLES, markerExample} from '../../nesting/marker-demo.js';
import {state} from '../../core/state.js';
import {importDemandTask, taskInputChanged} from './task-workspace.js';
import {updateUIInfo} from './solver-client.js';
import {showToast} from '../../core/toast.js';

export function garmentDemands(style) {
    return markerExample(1500,style).parts.map(p=>({id:p.id,name:p.name,width:p.shape.width,length:p.shape.height,
        quantity:p.quantity,allowRotation:p.allowRotation,shape:p.shape}));
}

const select=document.getElementById('garment-style');
if(select){
    select.replaceChildren(...MARKER_STYLES.map(s=>new Option(s.name+' · M/L 齐套',s.id)));
    let loading=false;
    document.getElementById('demand-manager-garment').addEventListener('click',async()=>{
        if(loading)return;loading=true;
        try{
            const style=MARKER_STYLES.find(s=>s.id===select.value);
            if(await importDemandTask({externalRef:'服装案例 · '+style.name,materialModel:document.getElementById('task-material').value,
                demands:garmentDemands(style.id)})){
                document.getElementById('task-name').value=style.name+' · M/L 齐套裁切';
                Object.assign(state.getCurrentCaseData(),{bedL:5000,trimStart:0,pieceGap:5,allowRotation:false,allowLongitudinal:true});
                updateUIInfo();taskInputChanged();
                showToast('已载入衣片轮廓。选择材料后，在当前工作台完成排料、走刀预览和报工。','success');
            }
        }catch(error){showToast(error.message,'error');}finally{loading=false;}
    });
}
