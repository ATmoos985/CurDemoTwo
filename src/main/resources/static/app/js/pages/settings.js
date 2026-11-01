// 设置：个人偏好、下一次计算参数及只读运行能力；不修改任务或历史方案。
import {loadPrefs, savePrefs, solverSettings, requestJSON, esc, toast} from '../util.js';
import {presets, describePreset} from '../../../js/industry/industry-profiles.js';

export async function mount(el) {
    const prefs = loadPrefs(), solve = solverSettings();
    const dpi = Math.round(25.4 / prefs.mmPerPx);
    el.innerHTML = `<div class="ph"><h1>设置</h1><span class="crumb">本机偏好与任务工艺分开保存</span></div>
      <div class="body" style="max-width:760px">
        <div class="box"><div class="pane-h">个人偏好 · 画布</div><div class="form">
          <label>画布方向</label><select class="field" id="p-vert"><option value="1" ${prefs.vertical ? 'selected' : ''}>竖向（卷长沿 Y 向下，默认）</option><option value="0" ${prefs.vertical ? '' : 'selected'}>横向</option></select>
          <label>全卷显示</label><select class="field" id="p-full"><option value="strip" ${prefs.fullMode === 'strip' ? 'selected' : ''}>整条（连续一条，缩放查看）</option><option value="tile" ${prefs.fullMode === 'tile' ? 'selected' : ''}>平铺（按列 / 行折返）</option></select>
          <label>打开时视图</label><select class="field" id="p-view"><option value="station" ${prefs.view === 'station' ? 'selected' : ''}>工位</option><option value="full" ${prefs.view === 'full' ? 'selected' : ''}>全卷</option></select>
          <label>右侧栏</label><select class="field" id="p-side"><option value="0" ${prefs.sideCollapsed ? '' : 'selected'}>展开</option><option value="1" ${prefs.sideCollapsed ? 'selected' : ''}>收起</option></select>
          <label>显示器 DPI</label><input class="field num" id="p-dpi" value="${dpi}" title="用于把屏幕比例换算为真实 1:N；可用尺子量屏幕上 100 mm 校准">
        </div><div class="foot" style="background:#fff"><span class="sp"></span><button class="btn pri" id="p-save">保存</button></div></div>
        <div class="box"><div class="pane-h">下一次排料 · 本机参数</div>
          <form id="solver-form"><div class="form">
            <label for="s-width">候选料头最小宽 mm</label><input class="field num" id="s-width" type="number" min="50" max="1000" step="50" required value="${esc(solve.minRemnantWidth)}">
            <label for="s-length">候选料头最小长 mm</label><input class="field num" id="s-length" type="number" min="50" max="2000" step="50" required value="${esc(solve.minRemnantLength)}">
            <label for="s-time">求解时限 s</label><input class="field num" id="s-time" type="number" min="1" max="60" step="1" required value="${esc(solve.timeLimitSeconds)}">
          </div><div class="notice">仅保存在当前浏览器，下一次排料使用；已有方案、回执和库存保持原值。时限另留 5 秒退出时间。</div>
          <div class="foot"><span class="sp"></span><button class="btn pri" type="submit">保存排料参数</button></div></form></div>
        <div class="box"><div class="pane-h">任务工艺与参考模板<span class="sp"></span><a class="btn sm" href="#/tasks">选择任务修改工艺</a></div>
          <div class="pane-b"><p>工位长度、间距、加工基准、旋转和纵切许可在任务编辑中修改，保存时核对任务版本；历史方案保留原请求。</p>
            <details><summary>查看现有行业模板</summary>${presets().map(p => `<p><b>${esc(p.name)}</b>：${esc(describePreset(p.values).map(d => d.label + ' ' + d.text).join('，'))}</p>`).join('')}
            <p class="muted">模板为参考值，查看不会自动套用。工厂级模板版本管理尚未接入。</p></details></div></div>
        <details class="box"><summary class="pane-h">运行能力与接口接入</summary><div class="pane-b">
          <button class="btn sm" id="refresh-capabilities">刷新运行能力</button><p id="capabilities-state" role="status">正在读取…</p><div id="capabilities-error" class="notice" role="alert" hidden></div>
          <div style="overflow:auto"><table class="t"><thead><tr><th>算法</th><th>状态</th><th>工艺 / 形状</th><th>精度</th></tr></thead><tbody id="engine-rows"></tbody></table></div><div class="kv" id="runtime-limits"></div>
          <p>此处只读取服务端能力与限额，不修改服务器配置。</p>
          <h3>AI 接入</h3><p>本机 MCP 可查询能力、校验输入、计算、读取及比较结果；需在 AI 客户端配置，不会由本页启动或授权。使用 Node.js 22 或更新版本，通过 stdio 连接；入口 <code>integrations/mcp/src/index.mjs</code>，配置见同目录 README。</p>
          <p>默认仅开放计算信息读取与输入校验；计算提交和业务读取由宿主分别开启。计算结果不能代替报工。远程认证、多租户、下达与报工工具尚未开放。</p>
          <h3>外部库存事件</h3><p>服务端配置专用凭据后，可领取已提交库存事件并提交接收回执。该通道默认关闭，本页不保存凭据；外部确认不再次扣减库存，也不等于双方余额已对账。外部权威库存预约、导入与差异处理尚未接入。</p>
          <p>部署与恢复说明：<code>docs/外部库存事件与投递接口.md</code>。</p><a href="/api-v2/openapi.json" target="_blank" rel="noopener">查看标准接口契约 ↗</a>
        </div></details>
      </div>`;
    el.querySelector('#p-save').onclick = () => {
        const d = Number(el.querySelector('#p-dpi').value);
        if (!(d >= 50 && d <= 400)) return toast('DPI 须在 50–400', true);
        savePrefs({...prefs, vertical: el.querySelector('#p-vert').value === '1', fullMode: el.querySelector('#p-full').value,
            view: el.querySelector('#p-view').value, sideCollapsed: el.querySelector('#p-side').value === '1', mmPerPx: 25.4 / d});
        toast('偏好已保存');
    };
    el.querySelector('#solver-form').onsubmit = e => {
        e.preventDefault();
        if (!e.currentTarget.reportValidity()) return;
        try {
            for (const [id, key] of [['s-width', 'cam_min_rem_w'], ['s-length', 'cam_min_rem_l'], ['s-time', 'cam_timeout']])
                localStorage.setItem(key, el.querySelector('#' + id).value);
            toast('本机参数已保存，下一次排料生效');
        } catch { toast('本机保存未完成，请核对浏览器存储后重试', true); }
    };
    let generation = 0;
    async function refresh() {
        const my = ++generation, button = el.querySelector('#refresh-capabilities');
        button.disabled = true; el.querySelector('#capabilities-error').hidden = true;
        try {
            const data = await requestJSON('/api/v2/capabilities');
            if (my !== generation) return;
            const engines = [...data.engines, ...(data.slittingEngine ? [{...data.slittingEngine, modes: ['一维分切'], shapes: ['幅宽订单'], coordinateResolutionMm: data.slittingEngine.lengthResolutionMm}] : [])];
            el.querySelector('#engine-rows').innerHTML = engines.map(e => `<tr><td>${esc(e.id)}</td><td>${e.available ? '可用' : '不可用'}</td><td>${esc([...(e.modes || []), ...(e.shapes || [])].join(' / '))}</td><td>${esc(e.coordinateResolutionMm ?? '未知')} mm</td></tr>`).join('');
            el.querySelector('#runtime-limits').innerHTML = Object.entries({workers:'并行作业数',queueCapacity:'等待队列容量',maxStoredJobs:'归档作业上限',maxPieces:'矩形裁片上限',maxContourPieces:'轮廓裁片上限',maxTimeLimitSeconds:'单作业时限上限（秒）',maxRequestBytes:'请求大小上限（字节）'}).map(([k,v]) => `<div>${v}</div><div>${esc(data.limits?.[k] ?? '未知')}</div>`).join('');
            el.querySelector('#capabilities-state').textContent = `契约 ${data.schemaVersion} · ${data.features?.distributedWorkers ? '多实例调度' : '本机调度'} · 查询时间 ${new Date().toLocaleTimeString('zh-CN')}`;
        } catch (e) {
            if (my === generation) { const n = el.querySelector('#capabilities-error'); n.hidden = false; n.textContent = '能力读取失败：' + e.message + '，上次结果可能已过期，可刷新重试。'; }
        } finally { if (my === generation) button.disabled = false; }
    }
    el.querySelector('#refresh-capabilities').onclick = refresh;
    void refresh();
    return () => { ++generation; };
}
