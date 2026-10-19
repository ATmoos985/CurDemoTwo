const modes = {marker:{url:'/marker-demo.html?embed=1',name:'服装唛架'},rectangle:{url:'/index.html?embed=1',name:'矩形裁切工作台'}};
function activate(key, focus = false) {
    if (!Object.hasOwn(modes,key)) key='marker';
    for (const button of document.querySelectorAll('[data-cutting-mode]')) {
        const selected=button.dataset.cuttingMode===key;
        button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
        document.getElementById(button.getAttribute('aria-controls')).hidden=!selected;
        if(selected&&focus)button.focus();
    }
    const panel=document.getElementById(`workspace-${key}`);
    if(!panel.firstChild) {
        const frame=document.createElement('iframe');frame.title=modes[key].name;frame.src=modes[key].url;panel.append(frame);
    }
    // Keep each mode mounted so switching retains drafts, pending reports and preview results.
    history.replaceState(null,'',`${location.pathname}${location.search}#${key}`);
}
document.querySelector('.cutting-modes').addEventListener('click',event=>{const button=event.target.closest('[data-cutting-mode]');if(button)activate(button.dataset.cuttingMode);});
document.querySelector('.cutting-modes').addEventListener('keydown',event=>{
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
        event.preventDefault();activate(event.key==='Home'?'marker':event.key==='End'?'rectangle':event.target.dataset.cuttingMode==='marker'?'rectangle':'marker',true);
    }
});
window.addEventListener('hashchange',()=>activate(location.hash.slice(1)));
activate(location.hash.slice(1));
