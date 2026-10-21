import {requestJSON} from '../../core/api-request.js';

export const executionLabels = {DRAFT:'待下达',RELEASED:'已下达 · 预约中',RUNNING:'加工中',EXPIRED:'预约已过期',CANCELLED:'已取消',REPORTED:'已报工',REVERSED:'报工已冲销'};
export function executionForPlan(views = [], planId) {
    const matches=views.filter(v=>v.execution.planId===planId);
    return matches.find(v=>v.reservationActive) || matches.find(v=>v.effectiveState==='DRAFT') || matches.at(-1);
}
export const executionLocksPlan=(views,planId)=>views.some(v=>v.execution.planId===planId && v.reservationActive);

// Store before sending. An uncertain response can be retried after reload with the exact same identity and body.
export function executionWriter(storage = localStorage, send = requestJSON, uuid = () => crypto.randomUUID()) {
    const key='cutting-execution-commands-v1';
    const read=()=>JSON.parse(storage.getItem(key) || '{}');
    const save=rows=>storage.setItem(key,JSON.stringify(rows));
    async function transmit(slot, intent) {
        try {
            const result=await send(intent.url,intent.body,intent.headers);
            const rows=read();delete rows[slot];save(rows);
            return result;
        } catch(error) {
            // A definite validation/authorization/conflict response did not apply this command.
            if([400,401,403,409,422].includes(error.httpStatus)) {const rows=read();delete rows[slot];save(rows);}
            throw error;
        }
    }
    return {
        pending: taskId => Object.entries(read()).filter(([,v])=>v.taskId===taskId),
        retry: async slot => {const intent=read()[slot];if(!intent)throw new Error('待核对操作不存在，请刷新执行记录。');return transmit(slot,intent);},
        async command(action, {taskId,planId,id,version}, values = {}) {
            const slot=action==='create'?'create:'+planId:action+':'+id;
            const rows=read();
            if(rows[slot])throw new Error('上次操作结果尚未确认，请在执行记录中重试原操作；原输入已保留。');
            const token=uuid();
            const intent={taskId,action,url:'/api/v2/execution-orders'+(action==='create'?'':'/'+encodeURIComponent(id)+'/'+action),
                body:action==='create'?{planId,station:values.station}:{operationId:token,expectedVersion:version,reservationSeconds:action==='release'?values.reservationSeconds:0,reason:values.reason || ''},
                headers:action==='create'?{'Idempotency-Key':token}:{}};
            rows[slot]=intent;save(rows);
            return transmit(slot,intent);
        }
    };
}
