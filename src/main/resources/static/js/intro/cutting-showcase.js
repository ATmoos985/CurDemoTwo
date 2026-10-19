const showcase = document.getElementById('cutting-showcase');
const motion = document.getElementById('motion-toggle');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function setPaused(paused) {
    showcase.classList.toggle('is-paused', paused);
    motion.setAttribute('aria-pressed', String(paused));
    motion.textContent = paused ? '播放动效' : '暂停动效';
}
function applyMotionPreference() {
    setPaused(reducedMotion.matches);
    motion.disabled = reducedMotion.matches;
    if (reducedMotion.matches) motion.textContent = '已减少动态效果';
}
applyMotionPreference();
reducedMotion.addEventListener('change', applyMotionPreference);
motion.addEventListener('click', () => setPaused(motion.getAttribute('aria-pressed') !== 'true'));

for (const button of showcase.querySelectorAll('[data-cut-mode]')) {
    button.addEventListener('click', () => {
        const sheet = button.dataset.cutMode === 'sheet';
        showcase.dataset.mode = button.dataset.cutMode;
        for (const option of showcase.querySelectorAll('[data-cut-mode]')) option.setAttribute('aria-pressed', String(option === button));
        document.getElementById('cutting-caption').textContent = sheet ? '多种尺寸，一起排料' : '不同幅宽，共用一卷';
        document.getElementById('cutting-detail').textContent = sheet ? '矩形裁片紧凑组合，沿切线分开。' : '将不同订单的条宽搭配，沿幅宽方向分条。';
    });
}

// 离开视口或切到后台时停止绘制，保留用户选择的播放状态。
new IntersectionObserver(([entry]) => showcase.classList.toggle('is-offscreen', !entry.isIntersecting)).observe(showcase);
document.addEventListener('visibilitychange', () => showcase.classList.toggle('is-hidden', document.hidden));
