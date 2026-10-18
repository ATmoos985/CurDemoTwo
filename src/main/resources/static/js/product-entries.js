/** 功能入口目录：导航栏与介绍页共用，页面路径只在这里维护。 */
export const ENTRIES = Object.freeze([
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

/** 导航分组：相邻且 group 相同的入口合成一组；navHidden 的入口仅在自己的页面显示。 */
export function navGroups(active) {
    const groups = [];
    for (const item of ENTRIES) {
        if (item.navHidden && item.id !== active) continue;
        const last = groups[groups.length - 1];
        if (last && item.group && last.label === item.group) last.items.push(item);
        else groups.push({label: item.group, items: [item]});
    }
    return groups;
}
