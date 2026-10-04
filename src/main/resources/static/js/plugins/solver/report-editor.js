import {classifyReport, outcomeLabels, reportRecoveryCandidates} from './report-outcomes.js';

export function readReportPieces() {
    return [...document.querySelectorAll('.report-piece-row')].map(row => ({pieceId:Number(row.dataset.pieceId),
        outcome:row.querySelector('select').value,reason:row.querySelector('input').value.trim()}));
}

export function renderReportPieces(pending, update) {
    const container = document.getElementById('report-pieces');container.replaceChildren();
    for (const piece of pending.result.pieces) {
        const previous = pending.reportPieceResults?.find(r => r.pieceId === piece.id);
        const row = document.createElement('div');row.className='report-piece-row';row.dataset.pieceId=piece.id;
        const label=document.createElement('label');label.textContent=`#${piece.id} ${piece.name} · 需求 ${piece.demandId} · ${piece.w} × ${piece.l} mm`;
        const select=document.createElement('select');select.className='prop-input';select.id='report-piece-'+piece.id;label.htmlFor=select.id;
        Object.entries(outcomeLabels).forEach(([value,text])=>select.add(new Option(text,value)));
        select.value=previous?.outcome || 'QUALIFIED';select.setAttribute('aria-label',`裁片 ${piece.id} 实际结果`);
        const reason=document.createElement('input');reason.className='prop-input';reason.maxLength=500;reason.placeholder='异常原因（必填）';
        reason.setAttribute('aria-label',`裁片 ${piece.id} 原因`);reason.value=previous?.reason || '';
        const changed=()=>{reason.hidden=select.value!=='REJECTED';reason.required=select.value==='REJECTED';update();};
        reason.hidden=select.value!=='REJECTED';reason.required=select.value==='REJECTED';select.onchange=changed;reason.oninput=update;
        row.append(label,select,reason);container.append(row);
    }
    for (const outcome of ['QUALIFIED','UNCUT']) document.getElementById('report-all-'+outcome.toLowerCase()).onclick=()=>{
        container.querySelectorAll('select').forEach(select=>select.value=outcome);
        container.querySelectorAll('input').forEach(input=>{input.hidden=true;input.required=false;});update();
    };
    document.getElementById('report-mark-tail').onclick=()=>{
        const len=Number(document.getElementById('report-actual-len').value);
        for(const piece of pending.result.pieces) if(piece.y+piece.l>len+.001){
            const row=container.querySelector(`[data-piece-id="${piece.id}"]`);row.querySelector('select').value='UNCUT';row.querySelector('input').hidden=true;row.querySelector('input').required=false;
        }
        update();
    };
    document.getElementById('report-mark-tail').hidden=pending.feedPortType==='remnant';
}

export function syncReportRemnants(pending, results, update) {
    const length=pending.feedPortType==='remnant' ? pending.bedL : Number(document.getElementById('report-actual-len').value);
    const candidates=reportRecoveryCandidates(pending.result,results,length);
    pending.reportCandidates=new Map(candidates.map(r=>[r.id,r]));
    const container=document.getElementById('report-remnants');
    for(const row of [...container.children]) if(!pending.reportCandidates.has(row.dataset.remnantId)) row.remove();
    for(const rem of candidates){
        let row=[...container.children].find(row=>row.dataset.remnantId===rem.id);
        if(row) {
            if(rem.uncut && !row.dataset.measured) row.querySelector('.report-l').value=rem.l;
            continue;
        }
        row=document.createElement('div');row.className='report-remnant-row';row.dataset.remnantId=rem.id;
        const previous=pending.reportRecovery?.[rem.id];
        const check=document.createElement('input');check.type='checkbox';
        check.checked=previous?.checked ?? (!rem.uncut && rem.w>=(pending.request.minRemnantWidth ?? 200) && rem.l>=(pending.request.minRemnantLength ?? 300));
        check.setAttribute('aria-label','回收 '+rem.id);check.onchange=update;
        const label=document.createElement('span');label.textContent=`${rem.status || '候选料头'} ${rem.id}`;
        const dimensions=['w','l'].map(key=>{const input=document.createElement('input');input.type='number';input.min='.1';input.step='.1';
            input.className='prop-input report-'+key;input.value=previous?.[key] ?? rem[key];input.setAttribute('aria-label',rem.id+(key==='w'?' 实测宽度':' 实测长度'));
            input.oninput=()=>{row.dataset.measured='true';update();};return input;});
        if(previous?.measured)row.dataset.measured='true';
        row.append(check,label,dimensions[0],document.createTextNode('×'),dimensions[1],document.createTextNode('mm'));container.append(row);
    }
}

export function readReportRemnants(pending) {
    pending.reportRecovery=Object.fromEntries([...document.querySelectorAll('.report-remnant-row')].map(row=>[row.dataset.remnantId,{
        checked:row.querySelector('input[type=checkbox]').checked,w:Number(row.querySelector('.report-w').value),l:Number(row.querySelector('.report-l').value),measured:!!row.dataset.measured}]));
    return Object.entries(pending.reportRecovery).filter(([,r])=>r.checked).map(([id,r])=>({...pending.reportCandidates.get(id),w:r.w,l:r.l}));
}

export function reportPieceError(pending, results) {
    const missing=results.find(r=>r.outcome==='REJECTED'&&!r.reason);
    if(missing)return {message:`裁片 #${missing.pieceId} 请填写异常原因`,selector:`[data-piece-id="${missing.pieceId}"] input`};
    const length=Number(document.getElementById('report-actual-len').value);
    if(pending.feedPortType==='roll'&&(!Number.isFinite(length)||length<=0||length>pending.bedL))return {message:'请核对实切长度，须大于 0 且不超过当前加工区',selector:'#report-actual-len'};
    const groups=classifyReport(pending.result.pieces,results);
    if(pending.feedPortType==='roll'&&[...groups.QUALIFIED,...groups.REJECTED].some(p=>p.y+p.l>length+.001))
        return {message:'实切长度未覆盖全部合格或异常裁片；请修正长度，或将未完成裁片设为未切',selector:'#report-actual-len'};
    return null;
}
