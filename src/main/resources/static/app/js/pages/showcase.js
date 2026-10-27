// 能力展示：示例数据只在这里，不写入任务与库存。本版链接到现有演示页。
const CASES = [
    ['二维排料试验台', '矩形 / 异形、禁入区、刀序', '/nesting.html'],
    ['服装齐套唛架', '多尺码齐套、缩短唛架长度', '/marker-demo.html'],
    ['一维分切对比', '多种一维求解方式对比', '/linear-demo.html'],
    ['布料避疵场景', '带疵纵切、短料复用、多疵点排料', '/cloth_cad_nesting.html'],
    ['一维分切工作台', '序号组、组合宽度、导出方案', '/linear.html'],
    ['场景总览', '二维裁切、服装唛架、一维搭切', '/demos.html']
];
export async function mount(el) {
    el.innerHTML = `<div class="ph"><h1>能力展示</h1><span class="crumb">用内置示例展示求解能力，不写入任务和库存</span></div>
      <div class="body"><div class="cards">${CASES.map(([t, d, u]) => `<a class="card" href="${u}" style="color:inherit"><small>${d}</small><b style="font-size:15px;font-family:inherit;margin:4px 0">${t}</b><div class="d">打开 ↗</div></a>`).join('')}</div>
      <div class="notice" style="margin:0">后续会把这些演示统一成能力展示页内的场景，生产工作台不再包含示例数据。</div></div>`;
}
