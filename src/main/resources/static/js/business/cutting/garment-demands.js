import {MARKER_STYLES} from '../../nesting/marker-demo.js';
import {garmentDemands} from './garment-demand-model.js';
import {state} from '../../core/state.js';
import {importDemandTask, taskInputChanged} from './task-workspace.js';
import {updateUIInfo} from './solver-client.js';
import {showToast} from '../../core/toast.js';

export {garmentDemands};

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
