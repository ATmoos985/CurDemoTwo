// 设置：个人偏好（本机保存）。求解引擎与计算能力暂不在界面展示。
import {loadPrefs, savePrefs, toast} from '../util.js';

export async function mount(el) {
    const prefs = loadPrefs();
    const dpi = Math.round(25.4 / prefs.mmPerPx);
    el.innerHTML = `<div class="ph"><h1>设置</h1><span class="sp"></span><a class="btn" href="/settings.html">工艺模板与接入 ↗</a></div>
      <div class="body" style="max-width:760px">
        <div class="box"><div class="pane-h">个人偏好 · 画布</div><div class="form">
          <label>画布方向</label><select class="field" id="p-vert"><option value="1" ${prefs.vertical ? 'selected' : ''}>竖向（卷长沿 Y 向下，默认）</option><option value="0" ${prefs.vertical ? '' : 'selected'}>横向</option></select>
          <label>全卷显示</label><select class="field" id="p-full"><option value="strip" ${prefs.fullMode === 'strip' ? 'selected' : ''}>整条（连续一条，缩放查看）</option><option value="tile" ${prefs.fullMode === 'tile' ? 'selected' : ''}>平铺（按列 / 行折返）</option></select>
          <label>打开时视图</label><select class="field" id="p-view"><option value="station" ${prefs.view === 'station' ? 'selected' : ''}>工位</option><option value="full" ${prefs.view === 'full' ? 'selected' : ''}>全卷</option></select>
          <label>右侧栏</label><select class="field" id="p-side"><option value="0" ${prefs.sideCollapsed ? '' : 'selected'}>展开</option><option value="1" ${prefs.sideCollapsed ? 'selected' : ''}>收起</option></select>
          <label>显示器 DPI</label><input class="field num" id="p-dpi" value="${dpi}" title="用于把屏幕比例换算为真实 1:N；可用尺子量屏幕上 100 mm 校准">
        </div><div class="foot" style="background:#fff"><span class="sp"></span><button class="btn pri" id="p-save">保存</button></div></div>
      </div>`;
    el.querySelector('#p-save').onclick = () => {
        const d = Number(el.querySelector('#p-dpi').value);
        if (!(d >= 50 && d <= 400)) return toast('DPI 须在 50–400', true);
        savePrefs({...prefs, vertical: el.querySelector('#p-vert').value === '1', fullMode: el.querySelector('#p-full').value,
            view: el.querySelector('#p-view').value, sideCollapsed: el.querySelector('#p-side').value === '1', mmPerPx: 25.4 / d});
        toast('偏好已保存');
    };
}
