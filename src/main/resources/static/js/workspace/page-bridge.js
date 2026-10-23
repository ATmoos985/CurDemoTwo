import {workspaceRoute} from './workspace-routes.js';

export const inWorkspace = window.parent !== window && (()=>{
    try{return new URLSearchParams(location.search).get('workspace')==='1' || window.parent.document.documentElement.classList.contains('workspace-embedded');}
    catch{return false;}
})();
let navigate=null, ready=false;
export function workspaceReady(handler=null){
    if(!inWorkspace)return;
    navigate=handler;ready=true;
    window.parent.postMessage({type:'cutdemo-workspace:ready'},location.origin);
}
export function openWorkspacePage(url, options={}){
    if(!inWorkspace || !workspaceRoute(url,location.origin))return false;
    window.parent.postMessage({type:'cutdemo-workspace:open',url,handoff:options.handoff??null},location.origin);return true;
}
function forwardVisibility(visible){
    document.documentElement.dataset.workspaceActive=String(visible);
    window.dispatchEvent(new CustomEvent('workspace:visibility',{detail:{visible}}));
    // Only registered embedded applications receive the lifecycle event, never print frames.
    for(const frame of document.querySelectorAll('iframe')){
        if(workspaceRoute(frame.src,location.origin))frame.contentWindow?.postMessage({type:'cutdemo-workspace:visibility',visible:visible&&!frame.closest('[hidden]')},location.origin);
    }
}
if(inWorkspace){
    document.documentElement.classList.add('workspace-embedded');
    document.addEventListener('click',event=>{
        const anchor=event.target.closest('a[href]');
        if(!anchor || anchor.hasAttribute('download') || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
        const raw=anchor.getAttribute('href');if(!raw || raw.startsWith('#'))return;
        const next=workspaceRoute(anchor.href,location.origin);if(!next)return;
        event.preventDefault();event.stopImmediatePropagation();openWorkspacePage(next.url);
    },true);
    let navigating=false;
    window.addEventListener('message',async event=>{
        if(event.origin!==location.origin || !event.data || typeof event.data!=='object')return;
        const data=event.data;
        if(event.source!==window.parent){
            const child=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source&&workspaceRoute(frame.src,location.origin));
            if(!child)return;
            if(data.type==='cutdemo-workspace:open'&&typeof data.url==='string')openWorkspacePage(data.url,{handoff:data.handoff});
            if(data.type==='cutdemo-workspace:ready')child.contentWindow.postMessage({type:'cutdemo-workspace:visibility',visible:document.documentElement.dataset.workspaceActive!=='false'&&!child.closest('[hidden]')},location.origin);
            return;
        }
        if(data.type==='cutdemo-workspace:visibility'&&typeof data.visible==='boolean')forwardVisibility(data.visible);
        if(data.type!=='cutdemo-workspace:navigate'||typeof data.url!=='string'||!ready)return;
        const next=workspaceRoute(data.url,location.origin),current=workspaceRoute(location.href,location.origin);
        if(!next||next.id!==current?.id)return;
        if(navigating)return;
        navigating=true;
        try{
            if(navigate){if(await navigate(new URL(next.url,location.origin),data.handoff)===false)return;}
            else {
                // Read-only filter pages may navigate; input applications must provide their own guard.
                if(['tasks','analysis'].includes(next.id)){location.href=new URL(next.url,location.origin).pathname+new URL(next.url,location.origin).search+(next.url.includes('?')?'&':'?')+'workspace=1'+new URL(next.url,location.origin).hash;return;}
                if(new URL(next.url,location.origin).search)throw Error('此作业已打开，请在当前页面选择对象，已有输入已保留。');
                const hash=new URL(next.url,location.origin).hash;if(hash){location.hash=hash;document.getElementById(hash.slice(1))?.scrollIntoView();}
            }
            window.parent.postMessage({type:'cutdemo-workspace:location',url:next.url},location.origin);
        }catch(error){window.parent.postMessage({type:'cutdemo-workspace:error',message:error.message},location.origin);}
        finally{navigating=false;}
    });
}
