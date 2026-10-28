import {requestJSON} from '../../core/api-request.js';
import {reviewablePieces} from './quality-projection.js';
export {reviewablePieces, effectivePieceResults} from './quality-projection.js';

/** Local form owns an immutable command while a request's outcome is uncertain. */
export function openQualityReview(report, onSaved) {
    const pieces = reviewablePieces(report);
    if (!pieces.length) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'workflow-dialog quality-dialog';
    dialog.setAttribute('aria-labelledby','quality-title');
    dialog.innerHTML = `<form><div class="workflow-dialog-heading"><h2 id="quality-title">复检处置</h2><button type="button" class="tool-btn" data-close>关闭</button></div>
      <div class="workflow-dialog-body"><p class="muted">每次处置一件已切裁片。原报工和原料耗用保留；原良品处置后扣回完成量，形成补产需求。</p>
      <fieldset class="quality-fields"><label>裁片<select name="pieceId" required></select></label>
      <label>处置方式<select name="disposition"><option value="SCRAP">报废</option><option value="REMNANT">转料头</option></select></label>
      <label>检验人<input name="inspector" maxlength="80" required></label>
      <label>复检原因<textarea name="reason" maxlength="500" rows="2" required></textarea></label>
      <fieldset data-recovery hidden><legend>实际回收矩形 · mm</legend><p class="muted">坐标相对当前裁片左上角。填写实际可回收区域，异形外接框不等于可用材料。尺寸还须满足原方案最小回收要求。</p>
      <div class="quality-grid">${[['x','起点 X',0],['y','起点 Y',0],['width','宽度',''],['length','长度','']].map(([name,label,value])=>`<label>${label} / mm<input name="${name}" type="number" min="0" step="any" value="${value}"></label>`).join('')}</div>
      <label>库位<input name="location" maxlength="100"></label><label>回收区域质量<select name="quality"><option value="QUARANTINED">待检隔离（不能选料）</option><option value="RECOVERABLE">已验收可用</option></select></label></fieldset></fieldset>
      <p role="alert" class="quality-error"></p></div><div class="quality-actions"><button type="submit" class="tool-btn active">确认处置</button></div></form>`;
    const form = dialog.querySelector('form'), fields = form.elements;
    pieces.forEach(p => fields.pieceId.add(new Option(`#${p.pieceId} · ${p.name} · ${p.w} × ${p.l} mm · 原${p.outcome === 'QUALIFIED' ? '良品' : '异常'}`,p.pieceId)));
    const recovery = form.querySelector('[data-recovery]'), error = form.querySelector('[role=alert]'), submit = form.querySelector('[type=submit]');
    const change = () => {
        recovery.hidden = fields.disposition.value !== 'REMNANT'; recovery.disabled = recovery.hidden;
        for (const name of ['x','y','width','length','location']) fields.namedItem(name).required = !recovery.hidden;
    };
    fields.disposition.onchange = change; change();
    let pending = false, command = null, uncertain = false;
    dialog.querySelector('[data-close]').onclick = () => {if (!pending && !uncertain) dialog.close();};
    dialog.addEventListener('cancel',e => {if (pending || uncertain) e.preventDefault();});
    dialog.addEventListener('close',() => dialog.remove());
    form.onsubmit = async event => {
        event.preventDefault(); if (pending) return;
        if (!command) {
            command = {operationId:crypto.randomUUID(),expectedRevision:report.qualityRevision ?? (report.qualityDispositions || []).length,
                pieceId:Number(fields.pieceId.value),disposition:fields.disposition.value,inspector:fields.inspector.value.trim(),reason:fields.reason.value.trim(),recovery:null};
            if (command.disposition === 'REMNANT') command.recovery = Object.fromEntries(['x','y','width','length','location','quality'].map(n => [n,['x','y','width','length'].includes(n) ? Number(fields.namedItem(n).value) : fields.namedItem(n).value.trim()]));
        }
        pending = true; submit.disabled = true; form.querySelector('.quality-fields').disabled = true; error.textContent = '';
        try {
            await requestJSON('/api/cutting/reports/'+encodeURIComponent(report.planId)+'/quality-dispositions',command);
        } catch (failure) {
            pending = false;
            if (failure.httpStatus === 400) {uncertain = false;command = null;form.querySelector('.quality-fields').disabled = false;submit.textContent = '确认处置';}
            else if (failure.httpStatus === 409) {uncertain = false;error.textContent = failure.message+'。关闭此窗，重新打开报工记录后处理。';return;}
            else {uncertain = true;submit.textContent = '重试同一处置';}
            submit.disabled = false;
            error.textContent = failure.message+(uncertain ? ' 结果尚未确认，输入已保留。请重试同一处置，避免重复登记。' : '');return;
        }
        pending = false;uncertain = false;dialog.close();
        await onSaved();
    };
    document.body.append(dialog);dialog.showModal();
}
