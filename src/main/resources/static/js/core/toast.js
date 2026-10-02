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
