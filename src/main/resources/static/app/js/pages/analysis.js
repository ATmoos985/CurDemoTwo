// 新版分析宿主：与经典入口共用只读对账、分页和导出用例。
import {requestJSON, esc} from '../util.js';
import {mountAnalysis} from '../../../js/business/analysis/analysis-view.js';

export function mount(el) {
    el.innerHTML = `<div class="ph"><h1>生产分析</h1><span class="crumb">实际产出与库存对账</span>
        <div class="hub-tabs" role="navigation" aria-label="材料与台账视图">
          <a href="#/inventory">实物库存</a>
          <a href="#/inspection">跑布验疵</a>
          <a href="#/documents">移库与盘点单</a>
          <a class="on" href="#/analysis">产出对账</a>
        </div>
        <span class="sp"></span><button class="btn" id="refresh-analysis">刷新对账</button></div>
      <div class="body">
        <div id="analysis-status" role="status"></div><div id="analysis-error" class="notice" role="alert" hidden></div>
        <div class="cards" id="actual-metrics" aria-label="实际报工指标"></div>
        <div class="muted" id="task-summary" role="status">正在读取任务汇总…</div>
        <details class="box"><summary class="pane-h">指标口径与适用范围</summary><div class="pane-b">
          <p>只统计未冲销、面积资料完整的二维报工，良品已扣除复检降级。实际良品产出率 = 净良品面积总和 ÷ 加工投入面积总和；可回收率 = 回收面积总和 ÷ 加工投入面积总和。按面积加权，单位 m²。</p>
          <p>料头再次裁切会再次计入加工投入；回收后再领用不抹去原回收产出。未切尾料不计入投入。预览方案、旧一维作业与外部 WMS 不计入；历史面积缺失或对账异常时不显示汇总百分比。</p></div></details>
        <div id="analysis-issues" role="status"></div>
        <div class="box"><div class="pane-h">逐单面积分解<span class="sub">单位 m²</span></div><div style="overflow:auto">
          <table class="t"><thead><tr><th>报工编号</th><th>投入</th><th>净良品</th><th>回收</th><th>不良</th><th>其他废料与损耗</th><th>差异</th><th>良品产出率</th></tr></thead><tbody id="area-rows"></tbody></table></div></div>
        <section class="box" id="ledger"><div class="pane-h">库存与需求流水<span class="sp"></span><button class="btn sm" id="export-ledger" disabled>导出已载入流水 CSV</button></div>
          <div class="notice">流水按顺序追加。迁移期初是历史余额快照，不代表当时发生过入库或裁切。</div>
          <form id="ledger-filters" class="toolbar" style="flex-wrap:wrap">
            <label for="ledger-type">对象类型</label><select class="field" id="ledger-type"><option value="">全部</option>${[['ROLL','母卷'],['REMNANT','料头'],['DEMAND','需求'],['REPORT','报工'],['TRANSFER','移库单'],['COUNT','盘点单'],['CHECKPOINT','迁移检查点']].map(([v,t]) => `<option value="${v}">${t}</option>`).join('')}</select>
            <label for="ledger-id">对象编号</label><input class="field" id="ledger-id" placeholder="精确匹配对象编号"><button class="btn" type="submit">查询流水</button><span id="ledger-status" role="status"></span></form>
          <div id="ledger-error" class="notice" role="alert" hidden></div><div style="overflow:auto"><table class="t"><thead><tr><th>序号 / 时间</th><th>业务事件</th><th>对象 / 编号</th><th>业务编号 / 来源报告</th><th>变更证据</th></tr></thead><tbody id="ledger-rows"></tbody></table></div>
          <button class="btn" style="margin:8px 12px" id="load-ledger" hidden>加载下一页</button></section>
      </div>`;
    const dispose = mountAnalysis(el, {extended: true});
    let disposed = false;
    requestJSON('/api/cutting/task-summaries').then(rows => {
        if (!disposed) el.querySelector('#task-summary').textContent = `已完成任务 ${rows.filter(r => r.status === 'COMPLETED').length} / ${rows.length}`;
    }).catch(e => { if (!disposed) el.querySelector('#task-summary').innerHTML = `任务汇总读取失败：${esc(e.message)}`; });
    return () => { disposed = true; dispose(); };
}
