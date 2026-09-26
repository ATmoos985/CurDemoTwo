/**
 * 工业 CAD 统一轻量消息提示 (Toast Notifications)
 * 替代原生阻塞式 window.alert，保证界面丝滑流转与自动化无感核查
 */
export function showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('cad-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'cad-toast-container';
        container.style.cssText = `
            position: fixed;
            bottom: 42px;
            right: 24px;
            z-index: 100000;
            display: flex;
            flex-direction: column;
            gap: 8px;
            pointer-events: none;
            max-width: 440px;
        `;
        document.body.appendChild(container);
    }

    const typeThemes = {
        success: { bg: '#064e3b', border: '#10b981', text: '#ecfdf5', icon: '✓', title: '操作成功' },
        info:    { bg: '#0c284e', border: '#0284c7', text: '#f0f9ff', icon: 'ℹ', title: '系统提示' },
        warning: { bg: '#451a03', border: '#f59e0b', text: '#fffbeb', icon: '⚠', title: '工艺注意' },
        error:   { bg: '#4c0519', border: '#ef4444', text: '#fff1f2', icon: '✕', title: '错误警告' }
    };
    const t = typeThemes[type] || typeThemes.info;

    const toast = document.createElement('div');
    toast.style.cssText = `
        background: ${t.bg};
        border: 1px solid ${t.border};
        color: ${t.text};
        padding: 9px 14px;
        border-radius: 6px;
        font-size: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        pointer-events: auto;
        cursor: pointer;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        line-height: 1.45;
        transition: opacity 0.25s cubic-bezier(0.4,0,0.2,1), transform 0.25s cubic-bezier(0.4,0,0.2,1);
        transform: translateY(0);
        opacity: 1;
    `;

    toast.innerHTML = `
        <span style="font-weight: 700; font-size: 14px; color: ${t.border}; flex-shrink: 0; margin-top: -1px;">${t.icon}</span>
        <div style="flex: 1;">
            <div style="font-weight: 600; font-size: 11px; margin-bottom: 2px; color: ${t.border}; text-transform: uppercase; letter-spacing: 0.5px;">${t.title}</div>
            <div style="word-break: break-word;">${message.replace(/\n/g, '<br>')}</div>
        </div>
    `;

    const dismiss = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 250);
    };

    toast.onclick = dismiss;
    container.appendChild(toast);
    setTimeout(dismiss, duration);
}

window.showToast = showToast;
