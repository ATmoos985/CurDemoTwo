import {navGroups} from './product-entries.js';

for(const host of document.querySelectorAll('[data-product-nav]')) {
    const active=host.dataset.productNav, hub=active==='intro';
    // 介绍页没有需要保留的作业内容，直接在本页跳转；其余页面新开标签，避免丢失当前内容。
    const link=item=>`<a href="${item.href}" ${item.id===active?'aria-current="page"':hub?'':'target="_blank" rel="noopener" title="新页面打开，保留当前内容"'}>${item.name}</a>`;
    const groups=navGroups(active).map(group=>group.label
        ?`<details class="nav-group"><summary ${group.items.some(item=>item.id===active)?'class="nav-current"':''}>${group.label==='二维'?'二维裁切':'一维分切'}</summary><div class="nav-dropdown">${group.items.map(link).join('')}</div></details>`
        :group.items.map(link).join('')).join('');
    host.innerHTML=`<nav class="product-nav" aria-label="功能区域">${groups}</nav>${active==='workbench'||hub ? '' : '<button type="button" class="tool-btn" data-capabilities>能力说明</button>'}`;
    if(host.querySelector('[data-capabilities]'))host.querySelector('[data-capabilities]').onclick=openCapabilities;
    if(host.querySelector('[data-inventory]'))host.querySelector('[data-inventory]').onclick=()=>window.camApp.openMaterialModal('rolls');
    host.querySelector('[aria-current]').onclick=event=>event.preventDefault();
    for(const menu of host.querySelectorAll('.nav-group')) {
        menu.addEventListener('toggle',()=>{if(menu.open)for(const other of host.querySelectorAll('.nav-group'))if(other!==menu)other.open=false;});
        menu.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.open=false;menu.querySelector('summary').focus();event.stopPropagation();}});
        menu.addEventListener('focusout',event=>{if(!menu.contains(event.relatedTarget))menu.open=false;});
    }
    document.addEventListener('click',event=>{for(const menu of host.querySelectorAll('.nav-group[open]'))if(!menu.contains(event.target))menu.open=false;});
}

function openCapabilities() {
    document.getElementById('capability-dialog')?.remove();
    const dialog=document.createElement('dialog');dialog.id='capability-dialog';dialog.className='action-dialog capability-dialog';dialog.setAttribute('aria-labelledby','capability-title');
    dialog.innerHTML=`<div class="capability-heading"><h2 id="capability-title">选择适合的裁切入口</h2><button type="button" class="tool-btn" data-close>关闭</button></div>
        <p class="capability-lead">行业场景、规则配置与一维 / 二维对照见 <a href="/intro.html" target="_blank" rel="noopener">介绍页 ↗</a>。</p>
        <table><thead><tr><th>入口</th><th>适用内容</th><th>保存与结果</th></tr></thead><tbody>
        <tr><th>通用操作台</th><td>母卷、料头上的矩形裁切；整幅横切及贯通套裁；窗帘、服装、板材的参数预设</td><td>保存任务和方案；实切报工扣库存，可按依赖撤回误报</td></tr>
        <tr><th>场景演示</th><td>标准材料与需求输入；窗帘、服装、板材示例；矩形及简单凹凸多边形排样</td><td>只计算预览、导出标准结果；不保存业务任务或操作库存</td></tr>
        <tr><th>分切工作台</th><td>长阳订单导入、按幅宽组合分切、选组重切及 Excel 导出</td><td>独立任务预览，不扣二维库存；本页保留需求，服务重启后重新计算</td></tr>
        <tr><th>搭切对比</th><td>同一批订单对比逐单独立分切与搭切（快速 / 精细）</td><td>只做预览比较，不导出、不扣库存；可带入分切工作台继续调整</td></tr>
        <tr><th>跑布验疵</th><td>整卷跑布、按速度滚动、拖框录入疵点</td><td>本地保留记录，批量保存到母卷；手动校准跑布位置，不连接设备</td></tr>
        <tr><th>库存档案</th><td>母卷、疵点、料头来源与库位管理</td><td>录入及维护库存档案；选料和报工在通用操作台内完成</td></tr></tbody></table>
        <p>异形结果目前是裁片边界预览，尚无可执行轮廓刀路、轮廓生产报工或余料划分。暂不支持孔洞、圆弧、任意角旋转、非零刀缝和多材料联合优化。</p>
        <details class="detail-disclosure"><summary>标准输入 / 输出与接入</summary><p>在场景演示页展开“标准输入 / 输出”，编辑完整 JSON 并导出输入和结果。长度为 mm，JSON 面积为 mm²，坐标原点为加工区左上角。生产库存与报工由通用操作台管理。</p>
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
