export const taskLabels={PLAN_PENDING:'待排料',EXECUTION_PENDING:'待执行',REPORT_PENDING:'待报工',ATTENTION:'需处理',COMPLETED:'已完成'};
export function filterTasks(rows,search='',status='all') {
    const query=search.trim().toLocaleLowerCase();
    return rows.filter(row=>(status==='all' || row.status===status) &&
        [row.task.id,row.task.name,row.task.materialModel,row.task.externalRef].some(value=>String(value || '').toLocaleLowerCase().includes(query))).slice().reverse();
}
export function taskLink(row) {
    const params=new URLSearchParams({taskId:row.task.id});
    if(['executions','reports','plans'].includes(row.nextAction))params.set('view',row.nextAction);
    return '/index.html?'+params;
}
