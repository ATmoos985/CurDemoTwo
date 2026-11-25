export const round = n => Math.round(n * 10) / 10;
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export function validateDefect(d, roll) {
    if (![d.x,d.y,d.w,d.h,d.margin].every(Number.isFinite) || d.w < .1 || d.h < .1 || d.margin < 0)
        throw new Error('请填写有效的位置、尺寸和避让外扩。');
    if ([d.x,d.y,d.w,d.h,d.margin].some(n=>Math.abs(n*10-Math.round(n*10))>.000001))
        throw new Error('位置、尺寸和避让外扩请精确到 0.1 mm。');
    if (d.x < 0 || d.y < 0 || d.x+d.w > roll.width+.001 || d.y+d.h > roll.totalLength+.001)
        throw new Error('疵点超出母卷边界，请核对位置和尺寸。');
    return d;
}
export function dragDefect(a, b, roll, margin=20) {
    return validateDefect({x:round(Math.min(a.x,b.x)),y:round(Math.min(a.y,b.y)),
        w:round(Math.abs(a.x-b.x)),h:round(Math.abs(a.y-b.y)),margin},roll);
}
export function pointAt(screen, view) {
    return {x:round((screen.x-view.left)/view.scale),y:round(view.offset+(view.bottom-screen.y)/view.scale)};
}
export function screenRect(d, view) {
    return {x:view.left+d.x*view.scale,y:view.bottom-(d.y+d.h-view.offset)*view.scale,width:d.w*view.scale,height:d.h*view.scale};
}
export function advance(position, speed, seconds, total) {
    if (![position,speed,seconds,total].every(Number.isFinite) || speed <= 0 || seconds < 0) throw new Error('跑布速度必须大于 0。');
    return clamp(position+speed*1000/60*seconds,0,total);
}
