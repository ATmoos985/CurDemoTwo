export function setStatus(html) {
    const el = document.getElementById('statusbar');
    if (el) el.innerHTML = html;
}
