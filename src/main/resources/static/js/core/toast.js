/** Shared, non-blocking workbench feedback. */
export function showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('cad-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'cad-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'workbench-toast';
    toast.dataset.type = type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提示');
    close.onclick = () => toast.remove();
    toast.appendChild(close);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}
window.showToast = showToast;

/** Shared keyboard-accessible confirmation; Escape cancels without changing data. */
export function confirmAction(message, {title = '确认操作', action = '确认', reason = false} = {}) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'action-dialog';
        const heading = document.createElement('h2'); heading.textContent = title;
        const copy = document.createElement('p'); copy.textContent = message;
        const form = document.createElement('form'); form.method = 'dialog';
        form.append(heading, copy);
        let input;
        if (reason) {
            const label = document.createElement('label'); label.textContent = '撤回原因';
            input = document.createElement('textarea'); input.required = true; input.maxLength = 500;
            input.className = 'prop-input'; input.rows = 3; label.append(input); form.append(label);
        }
        const actions = document.createElement('div'); actions.className = 'dialog-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'tool-btn';
        cancel.textContent = '取消'; cancel.onclick = () => dialog.close();
        const accept = document.createElement('button'); accept.type = 'submit'; accept.className = 'tool-btn active';
        accept.value = 'confirm'; accept.textContent = action;
        actions.append(cancel, accept); form.append(actions); dialog.append(form); document.body.append(dialog);
        form.onsubmit = event => { if (reason && !input.value.trim()) { event.preventDefault(); input.focus(); } };
        dialog.addEventListener('close', () => {
            resolve(dialog.returnValue === 'confirm' ? (reason ? input.value.trim() : true) : false); dialog.remove();
        }, {once:true});
        dialog.showModal(); (input || cancel).focus();
    });
}
