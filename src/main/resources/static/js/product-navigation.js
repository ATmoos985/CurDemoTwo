const surfaces=[['workbench','裁切作业','/'],['lab','裁切试验','/nesting.html'],['inventory','库存档案','/inventory.html']];
for(const host of document.querySelectorAll('[data-product-nav]')) {
    const active=host.dataset.productNav;
    host.innerHTML=`<nav class="product-nav" aria-label="功能区域">${surfaces.filter(([id])=>id!=='inventory' || active==='inventory').map(([id,label,url])=>`<a href="${url}" ${id===active?'aria-current="page"':'target="_blank" rel="noopener" title="新页面打开，保留当前内容"'}>${label}</a>`).join('')}</nav>${active==='workbench' ? '' : '<button type="button" class="tool-btn" data-capabilities>能力说明</button>'}`;
    if(host.querySelector('[data-capabilities]'))host.querySelector('[data-capabilities]').onclick=openCapabilities;
    if(host.querySelector('[data-inventory]'))host.querySelector('[data-inventory]').onclick=()=>window.camApp.openMaterialModal('rolls');
    host.querySelector('[aria-current]').onclick=event=>event.preventDefault();
}

function openCapabilities() {
    document.getElementById('capability-dialog')?.remove();
    const dialog=document.createElement('dialog');dialog.id='capability-dialog';dialog.className='action-dialog capability-dialog';dialog.setAttribute('aria-labelledby','capability-title');
    dialog.innerHTML=`<div class="capability-heading"><h2 id="capability-title">选择适合的裁切入口</h2><button type="button" class="tool-btn" data-close>关闭</button></div>
        <table><thead><tr><th>入口</th><th>适用内容</th><th>保存与结果</th></tr></thead><tbody>
        <tr><th>裁切作业</th><td>母卷、料头上的矩形裁切；整幅横切及贯通套裁</td><td>保存任务和方案；实切报工扣库存，可按依赖撤回误报</td></tr>
        <tr><th>裁切试验</th><td>标准材料与需求输入；矩形及简单凹凸多边形排样</td><td>只计算预览、导出标准结果；不保存业务任务或操作库存</td></tr>
        <tr><th>库存档案</th><td>母卷、疵点、料头来源与库位管理</td><td>录入及维护库存档案；选料和报工在裁切作业内完成</td></tr></tbody></table>
        <p>异形结果目前是裁片边界预览，尚无可执行轮廓刀路、轮廓生产报工或余料划分。暂不支持孔洞、圆弧、任意角旋转、非零刀缝和多材料联合优化。</p>
        <details class="detail-disclosure"><summary>标准输入 / 输出与接入</summary><p>在裁切试验台展开“标准输入 / 输出”，编辑完整 JSON 并导出输入和结果。长度为 mm，JSON 面积为 mm²，坐标原点为加工区左上角。生产库存与报工由业务工作台管理。</p>
        <p><code>POST /api/v1/nesting/solve</code> 接收材料、需求和工艺，返回加工区、裁片位置、刀路或轮廓、未排入数量及面积；成功结果允许部分未排入，不承诺全局最优。</p><a class="tool-btn" href="/nesting.html#protocol-details" target="_blank" rel="noopener">打开标准输入 / 输出 ↗</a></details>
        <details class="detail-disclosure"><summary>当前服务器引擎</summary><p id="capability-engine-status" role="status">正在读取…</p></details>`;
    document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('keydown',event=>event.stopPropagation());dialog.showModal();
    fetch('/api/v1/nesting/engines',{cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error();return response.json();}).then(engines=>{
        dialog.querySelector('#capability-engine-status').textContent=engines.map(e=>`${e.id}：${e.available?'可用':'未就绪'} · 精度 ${e.coordinateResolutionMm} mm`).join('\n');
    }).catch(()=>{dialog.querySelector('#capability-engine-status').textContent='暂时无法读取引擎状态，重新打开可重试。';});
}

if(location.hash==='#protocol-details') {
    const section=document.getElementById('protocol-details');if(section){section.open=true;section.scrollIntoView({block:'nearest'});}
}
