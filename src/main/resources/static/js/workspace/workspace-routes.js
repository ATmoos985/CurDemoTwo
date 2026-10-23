import {ENTRIES} from '../product-entries.js';

// Existing applications are mounted intact. No copies of their algorithm or business state.
export const WORKSPACE_GROUPS = [
    {name:'生产作业',items:[['tasks','任务管理'],['workbench','二维排料与切割'],['linear','一维分切']]},
    {name:'材料管理',items:[['inventory','库存与料头'],['transfers','材料单据'],['inspection','跑布验疵']]},
    {name:'管理',items:[['analysis','分析与对账'],['settings','系统设置']]},
    {name:'演示与帮助',collapsed:true,items:[['intro','使用说明'],['demos','行业演示'],['lab','二维算法场景'],['marker','服装齐套排料演示'],['compare','一维搭切对比']]}
].map(group=>({...group,items:group.items.map(([id,name])=>({...ENTRIES.find(entry=>entry.id===id),name}))}));
const menuPages=WORKSPACE_GROUPS.flatMap(group=>group.items);
// Detail documents can open inside the shell without becoming extra top-level menu buttons.
const pages=ENTRIES.map(entry=>menuPages.find(item=>item.id===entry.id)??entry);
export function workspaceRoute(input, origin) {
    try {
        const url=new URL(input,origin);
        if(url.origin!==new URL(origin).origin || !['http:','https:'].includes(url.protocol))return null;
        if(url.pathname==='/'||url.pathname==='/cutting.html')url.pathname='/index.html';
        const entry=pages.find(item=>item.href===url.pathname);
        if(!entry)return null;
        url.searchParams.delete('workspace');url.searchParams.delete('embed');
        return {id:entry.id,name:entry.name,url:url.pathname+url.search+url.hash};
    }catch{return null;}
}
