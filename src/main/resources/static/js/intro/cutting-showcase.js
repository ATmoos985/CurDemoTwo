import {CUT_PATHS, COMPLETED_MS, cuttingFrame} from './cutting-timeline.js';
const showcase = document.getElementById('cutting-showcase');
const motion = document.getElementById('motion-toggle');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const ns = 'http://www.w3.org/2000/svg';
let elapsed = 0, last = null, paused = false, visible = true;
for (const [mode, paths] of Object.entries(CUT_PATHS)) {
    const scene = showcase.querySelector(`.${mode}-scene`);
    scene.querySelectorAll('.cut-trace,.cut-head').forEach(node => node.remove());
    for (const [x1,y1,x2,y2] of paths) {
        const line = document.createElementNS(ns,'path'); line.setAttribute('class','cut-trace');
        line.setAttribute('d',`M${x1} ${y1}L${x2} ${y2}`); line.setAttribute('pathLength','1'); scene.append(line);
        const head = document.createElementNS(ns,'circle'); head.setAttribute('class','cut-head'); head.setAttribute('r','5'); scene.append(head);
    }
}
function draw() {
    const mode = showcase.dataset.mode, scene = showcase.querySelector(`.${mode}-scene`);
    const frame = cuttingFrame(reduced.matches ? COMPLETED_MS : elapsed, mode);
    showcase.dataset.phase = frame.phase; showcase.dataset.completedCuts = frame.complete;
    scene.querySelectorAll('.cut-piece').forEach(piece => {
        const style = getComputedStyle(piece);
        piece.setAttribute('transform',`translate(${parseFloat(style.getPropertyValue('--dx')) * frame.offset},${parseFloat(style.getPropertyValue('--dy')) * frame.offset})`);
    });
    scene.querySelectorAll('.cut-trace').forEach((line,index) => {
        line.style.strokeDashoffset = 1 - frame.progress[index];
        line.style.opacity = frame.phase === '裁片分离' ? '0' : '1';
    });
    scene.querySelectorAll('.cut-head').forEach((head,index) => {
        const path = frame.paths[index], p = frame.progress[index];
        head.setAttribute('cx',path[0]+(path[2]-path[0])*p); head.setAttribute('cy',path[1]+(path[3]-path[1])*p);
        head.style.opacity = p > 0 && p < 1 ? '1' : '0';
    });
    document.getElementById('cutting-detail').textContent = `${frame.phase} · ${frame.complete} / ${frame.paths.length} 刀完成`;
}
function updateMotion() {
    motion.disabled = reduced.matches; motion.setAttribute('aria-pressed',String(paused || reduced.matches));
    motion.textContent = reduced.matches ? '已减少动态效果' : paused ? '播放动效' : '暂停动效';
    draw();
}
motion.onclick = () => { paused = !paused; updateMotion(); };
reduced.addEventListener('change',updateMotion);
for (const button of showcase.querySelectorAll('[data-cut-mode]')) button.onclick = () => {
    showcase.dataset.mode = button.dataset.cutMode; elapsed = 0;
    for (const option of showcase.querySelectorAll('[data-cut-mode]')) option.setAttribute('aria-pressed',String(option===button));
    document.getElementById('cutting-caption').textContent = button.dataset.cutMode === 'sheet' ? '多种尺寸，一起排料' : '不同幅宽，共用一卷';
    draw();
};
new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(showcase);
function tick(now) {
    if (last !== null && visible && !document.hidden && !paused && !reduced.matches) { elapsed += now-last; draw(); }
    last = now; requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange', () => { last = null; });
updateMotion(); requestAnimationFrame(tick);
