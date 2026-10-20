/**
 * 实体绘制只标记命中图过期，下一次真正拾取前再同步重画。
 * 仍由 Konva 的原命中图处理描边、遮挡、点选和右键；不改变 listening 或节点事件。
 * 带显式目标画布的 drawHit（如 cache/export）保留原行为。
 */
export function deferHitGraph(layer) {
    const drawHit = layer.drawHit, getIntersection = layer.getIntersection;
    let dirty = true;
    layer.drawHit = function (...args) {
        if (args.some(arg => arg !== undefined)) return drawHit.apply(this, args);
        dirty = true;
        return this;
    };
    layer.getIntersection = function (...args) {
        if (dirty && this.shouldDrawHit()) {
            drawHit.call(this);
            dirty = false;
        }
        return getIntersection.apply(this, args);
    };
}
