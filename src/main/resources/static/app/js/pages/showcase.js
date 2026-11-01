// 能力展示：保留独立演示入口；旧一维生产作业从经典版本访问。
const CASES = [
    ['二维排料试验台', '矩形 / 异形、禁入区、刀序', '/nesting.html'],
    ['服装齐套唛架', '多尺码齐套、缩短唛架长度', '/marker-demo.html'],
    ['一维分切对比', '多种一维求解方式对比', '/linear-demo.html'],
    ['布料避疵场景', '带疵纵切、短料复用、多疵点排料', '/cloth_cad_nesting.html'],
    ['场景总览', '二维裁切、服装唛架、一维搭切', '/demos.html']
];
export async function mount(el) {
    el.innerHTML = `<div class="ph"><h1>能力展示</h1><span class="crumb">独立演示入口</span></div>
      <div class="body"><div class="cards">${CASES.map(([t, d, u]) => `<a class="card" href="${u}" style="color:inherit"><small>${d}</small><b style="font-size:15px;font-family:inherit;margin:4px 0">${t}</b><div class="d">打开 ↗</div></a>`).join('')}</div>
      <div class="notice" style="margin:0">以上打开独立演示页，尚未统一为新版页面。正式一维 / 二维生产请从<a href="#/tasks">任务</a>进入；历史一维作业仍可从顶部“经典版本”访问。</div></div>`;
}
