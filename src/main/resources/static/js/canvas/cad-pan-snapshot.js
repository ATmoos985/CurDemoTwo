import {localBounds} from './cad-view.js';

/**
 * 全卷已完整落在视口内时，拖动画布复用这一帧的实体像素。
 * 仅平移整数设备像素，缩放/尺寸/内容变化立即回退；不缩放位图、不简化描边。
 * 缓存始终是一张视口大小画布，与母卷的毫米长度无关。
 */
export function cacheOverviewPan(layer, stage, isOverview) {
    const drawScene = layer.drawScene;
    let snapshot = null;
    const invalidate = () => { snapshot = null; };
    stage.on('dragstart.pan-snapshot', event => {
        invalidate();
        if (event.target !== stage || !isOverview()) return;
        // localBounds 包含被视口裁剪隐藏的节点，防止第二次拖动误缓存不完整的实体集合。
        const bounds = localBounds(layer), width = stage.width(), height = stage.height(), scale = stage.scaleX();
        // 留足非缩放描边；任何实体被视口截断时，不能用不完整的旧图平移。
        if (!bounds || stage.x() + (layer.x() + bounds.x1) * scale < 32
            || stage.y() + (layer.y() + bounds.y1) * scale < 32
            || stage.x() + (layer.x() + bounds.x2) * scale > width - 32
            || stage.y() + (layer.y() + bounds.y2) * scale > height - 32) return;
        drawScene.call(layer);
        const source = layer.getCanvas(), image = document.createElement('canvas');
        image.width = source.getWidth(); image.height = source.getHeight();
        image.getContext('2d').drawImage(layer.getNativeCanvasElement(), 0, 0);
        snapshot = {image, x:stage.x(), y:stage.y(), scale:stage.scaleX(), width, height, ratio:source.getPixelRatio()};
    });
    stage.on('dragend.pan-snapshot', event => {
        if (event.target !== stage) return;
        invalidate(); layer.batchDraw();
    });
    layer.drawScene = function (...args) {
        const s = snapshot;
        if (!s || args.some(arg => arg != null) || !isOverview()
            || stage.scaleX() !== s.scale || stage.scaleY() !== s.scale
            || stage.width() !== s.width || stage.height() !== s.height)
            return drawScene.apply(this, args);
        const dx = (stage.x()-s.x)*s.ratio, dy = (stage.y()-s.y)*s.ratio;
        if (Math.abs(dx-Math.round(dx)) > 1e-7 || Math.abs(dy-Math.round(dy)) > 1e-7)
            return drawScene.apply(this, args);
        this.fire('beforeDraw');
        const context = this.getCanvas().getContext();
        context.save();
        context.setTransform(1,0,0,1,0,0);
        context.clearRect(0,0,s.image.width,s.image.height);
        context.drawImage(s.image,Math.round(dx),Math.round(dy));
        context.restore();
        this.fire('draw');
        return this;
    };
    return invalidate;
}
