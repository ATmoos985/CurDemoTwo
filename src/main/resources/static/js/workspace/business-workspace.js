import {WORKSPACE_GROUPS,workspaceRoute} from './workspace-routes.js';
const menu=document.getElementById('workspace-menu'),tabs=document.getElementById('workspace-tabs');
const pages=document.getElementById('workspace-pages'),feedback=document.getElementById('workspace-feedback');
const brand=document.getElementById('workspace-brand');
const mounted=new Map();let active=null;
function say(message){feedback.textContent=message;feedback.hidden=!message;}
brand?.addEventListener('click',()=>openPage('/intro.html'));
for(const group of WORKSPACE_GROUPS){
    const section=document.createElement(group.collapsed?'details':'section');
    if(group.collapsed){const summary=document.createElement('summary');summary.textContent=group.name;section.append(summary);}
    else{const heading=document.createElement('h2');heading.textContent=group.name;section.append(heading);}
    for(const item of group.items){const button=document.createElement('button');button.type='button';button.textContent=item.name;button.dataset.page=item.id;
        button.addEventListener('click',()=>openPage(item.href));section.append(button);}
    menu.append(section);
}
function visibility(item,visible){
    item.panel.classList.toggle('is-active',visible);item.panel.inert=!visible;item.panel.setAttribute('aria-hidden',String(!visible));
    item.tab.setAttribute('aria-selected',String(visible));item.tab.tabIndex=visible?0:-1;
    item.frame.contentWindow?.postMessage({type:'cutdemo-workspace:visibility',visible},location.origin);
}
function activate(item){
    for(const entry of mounted.values())visibility(entry,entry===item);
    active=item;document.querySelectorAll('.workspace-navigation [data-page]').forEach(button=>{if(button.dataset.page===(item.id==='counts'?'transfers':item.id))button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    item.tab.scrollIntoView({block:'nearest',inline:'nearest'});document.title=item.name+' · 搭切工作台';
    history.replaceState(null,'','#'+encodeURIComponent(item.url));
}
function frameUrl(url){const target=new URL(url,location.origin);target.searchParams.set('workspace','1');return target.pathname+target.search+target.hash;}
function openPage(input,{handoff=null}={}){
    const route=workspaceRoute(input,location.origin);if(!route)return say('这个地址不是已登记的业务功能，请从左侧选择。');say('');
    let item=mounted.get(route.id);
    if(item){
        activate(item);
        // Plain navigation always returns to the existing document without touching its state.
        const specific=new URL(route.url,location.origin);
        if(specific.search || specific.hash || handoff){
            const request={type:'cutdemo-workspace:navigate',url:route.url,handoff};
            if(item.ready)item.frame.contentWindow.postMessage(request,location.origin);else item.navigation=request;
        }
        return;
    }
    const tab=document.createElement('button');tab.type='button';tab.id='workspace-tab-'+route.id;tab.setAttribute('role','tab');tab.textContent=route.name;
    const panel=document.createElement('section');panel.id='workspace-page-'+route.id;panel.className='workspace-page';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);tab.setAttribute('aria-controls',panel.id);
    const frame=document.createElement('iframe');frame.title=route.name;frame.dataset.workspaceFrame=route.id;
    item={...route,tab,panel,frame,ready:false,navigation:handoff?{type:'cutdemo-workspace:navigate',url:route.url,handoff}:null};mounted.set(route.id,item);panel.append(frame);pages.append(panel);tabs.append(tab);
    tab.addEventListener('click',()=>{say('');activate(item);});
    frame.addEventListener('load',()=>{
        // A link that missed the bridge must not silently turn this tab into another application.
        try{const current=workspaceRoute(frame.contentWindow.location.href,location.origin);if(current&&current.id!==item.id)say('页面已跳转，请使用左侧功能导航切换。');}catch{say('无法读取此页面，请使用左侧功能导航。');}
        visibility(item,item===active);
    });
    frame.src=frameUrl(route.url);activate(item);
}
window.addEventListener('message',event=>{
    if(event.origin!==location.origin)return;
    const item=[...mounted.values()].find(entry=>entry.frame.contentWindow===event.source);if(!item)return;
    const data=event.data;if(!data || typeof data!=='object')return;
    if(data.type==='cutdemo-workspace:open'&&typeof data.url==='string')openPage(data.url,{handoff:workspaceRoute(data.url,location.origin)?.id==='linear'?data.handoff:null});
    else if(data.type==='cutdemo-workspace:ready'){item.ready=true;visibility(item,item===active);if(item.navigation){item.frame.contentWindow.postMessage(item.navigation,location.origin);item.navigation=null;}}
    else if(data.type==='cutdemo-workspace:location'&&typeof data.url==='string'){
        const next=workspaceRoute(data.url,location.origin);if(next?.id===item.id){item.url=next.url;if(item===active)history.replaceState(null,'','#'+encodeURIComponent(item.url));}
    }else if(data.type==='cutdemo-workspace:error'&&typeof data.message==='string')say(data.message);
});
tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const list=[...mounted.values()],index=list.indexOf(active);let next;
    if(event.key==='Home')next=list[0];else if(event.key==='End')next=list.at(-1);else next=list[(index+(event.key==='ArrowRight'?1:-1)+list.length)%list.length];
    if(next){event.preventDefault();activate(next);next.tab.focus();}
});
window.addEventListener('hashchange',()=>{try{openPage(decodeURIComponent(location.hash.slice(1))||'/index.html');}catch{say('页签地址无效。');}});
try{openPage(decodeURIComponent(location.hash.slice(1))||'/index.html');}catch{openPage('/index.html');}
