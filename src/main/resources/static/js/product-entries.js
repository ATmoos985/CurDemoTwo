/** 功能入口目录：导航栏与介绍页共用，页面路径只在这里维护。 */
export const ENTRIES = Object.freeze([
    {id:'transfers', name:'材料移库', href:'/transfers.html', group:'', navHidden:true, summary:'材料移库单、原目标库位与过账追溯'},
    {id:'tasks', name:'任务', href:'/tasks.html', group:'', navHidden:true, summary:'生产任务、净良品履约与执行预约'},
    {id:'analysis', name:'分析', href:'/analysis.html', group:'', summary:'实际报工面积、库存对账与流水'},
    {id:'settings', name:'设置', href:'/settings.html', group:'', summary:'工艺参数入口、本机显示与服务端运行能力'},
    {id:'marker', name:'服装唛架', href:'/marker-demo.html', group:'', navHidden:true, summary:'固定布宽、齐套衣片、缩短唛架'},
    {id:'demos', name:'功能演示', href:'/demos.html', group:'', summary:'二维场景、服装唛架与一维搭切的统一演示'},
    {id: 'intro', name: '介绍', href: '/intro.html', group: '', summary: '切割能力、行业场景与演示入口总览'},
    {id: 'workbench', name: '通用操作台', href: '/index.html', group: '二维',
        summary: '任务、排料、切割、报工与余料的完整作业流程；行业规则在“设置 → 工艺与切刀”中一键套用'},
    {id: 'lab', name: '场景演示', href: '/nesting.html', group: '二维',
        summary: '内置窗帘、服装、板材示例，一键排料预览；只计算预览，不写入业务库存'},
    {id: 'linear', name: '分切工作台', href: '/linear.html', group: '一维',
        summary: '导入长阳订单，幅宽搭切、选组重切并导出 Excel；独立于二维库存'},
    {id: 'compare', name: '搭切对比', href: '/linear-demo.html', group: '一维',
        summary: '同一批订单对比逐单独立分切与搭切（快速 / 精细），实时调用搭切求解器'},
    {id: 'inspection', name: '跑布验疵', href: '/inspection.html', group: '',
        summary: '整卷跑布、按速度滚动、拖框录入疵点，批量保存到母卷'},
    {id: 'inventory', name: '库存档案', href: '/inventory.html', group: '', navHidden: true,
        summary: '母卷、疵点、料头来源与库位管理'}
]);

export const entry = id => ENTRIES.find(item => item.id === id) ?? null;

/** Production management destinations; legacy URLs remain valid. */
export function navGroups() {
    return [entry('tasks'), {...entry('inventory'), name:'材料'}, entry('analysis'), entry('settings')]
        .map(item => ({label:'', items:[item]}));
}
