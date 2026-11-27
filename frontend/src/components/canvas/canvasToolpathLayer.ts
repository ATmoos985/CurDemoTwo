import type { MutableRefObject } from 'react';
import Konva from '../../vendor/konva';
import { computeToolpathSegments, round1 } from './canvasGeometry';
import {
  createLabelUpdater,
  ensureHatchTiles,
  makeShapeNode,
  type BoardCanvasLiveProps,
  type BoardCanvasRefs
} from './canvasKonvaHelpers';
import type { CameraController } from './canvasCamera';

export function renderToolpathLayer(
  refs: BoardCanvasRefs,
  propsRef: MutableRefObject<BoardCanvasLiveProps>,
  cam: CameraController
): void {
  const tpRollGroup = refs.toolpathRollGroupRef.current;
  const host = refs.hostRef.current;
  if (!Konva || !tpRollGroup || !host) return;

  const p0 = propsRef.current;
  tpRollGroup.destroyChildren();
  refs.toolpathScaleNodesRef.current = [];
  ensureHatchTiles(refs.hatchCacheRef.current);
  cam.syncAllRollGroupsTransform();

  // 3.1 计划余料（料头）虚线绿框渲染 + 点击高亮 + 右键抛弃菜单
  const activeLeftovers = (p0.leftovers || []).filter(
    (rm) => !rm.discarded && rm.width > 0 && rm.height > 0
  );
  if (activeLeftovers.length > 0) {
    const remGroup = new Konva.Group();
    tpRollGroup.add(remGroup);

    for (const rm of activeLeftovers) {
      const isSel =
        p0.selectedLeftoverId != null && String(p0.selectedLeftoverId) === String(rm.id);
      const areaM2 = ((rm.width * rm.height) / 1_000_000).toFixed(2);
      const strokeColor = isSel ? '#059669' : rm.hasDefect ? '#d97706' : '#10b981';

      const boxGroup = new Konva.Group({ x: rm.x, y: rm.y });
      const boxShape = makeShapeNode(Konva, rm.shape, rm.width, rm.height, {
        fill: isSel
          ? 'rgba(16, 185, 129, 0.22)'
          : rm.hasDefect
          ? 'rgba(245, 158, 11, 0.1)'
          : undefined,
        fillPatternImage:
          !isSel && !rm.hasDefect ? refs.hatchCacheRef.current.leftover : undefined,
        stroke: strokeColor,
        strokeWidth: isSel ? 2.4 : 1.5,
        dash: [6, 4],
        shadowEnabled: isSel,
        shadowColor: 'rgba(16, 185, 129, 0.35)',
        shadowBlur: 10
      });
      boxGroup.add(boxShape);

      const syncRemLbl = createLabelUpdater(
        Konva,
        boxGroup,
        `余料 #${rm.id}${rm.hasDefect ? ' · 含疵' : ''}`,
        `${Math.round(rm.width)}×${Math.round(rm.height)} · ${areaM2}m²`,
        rm.width,
        rm.height,
        rm.hasDefect ? '#92400e' : '#065f46',
        true,
        refs.camRef,
        propsRef
      );
      syncRemLbl();
      refs.toolpathScaleNodesRef.current.push(syncRemLbl);

      boxGroup.on('mouseenter', () => {
        host.style.cursor = 'pointer';
      });
      boxGroup.on('mouseleave', () => {
        host.style.cursor = '';
      });
      boxGroup.on('click tap', (e: any) => {
        e.cancelBubble = true;
        propsRef.current.onSelectPiece?.(null);
        propsRef.current.onSelectLeftover?.(String(rm.id));
      });
      boxGroup.on('contextmenu', (e: any) => {
        const p = propsRef.current;
        if (!p.onContextMenu) return;
        e.evt.preventDefault();
        e.cancelBubble = true;
        p.onSelectPiece?.(null);
        p.onSelectLeftover?.(String(rm.id));
        p.onContextMenu({
          kind: 'leftover',
          leftoverId: String(rm.id),
          entityId: rm.id,
          clientX: e.evt.clientX,
          clientY: e.evt.clientY,
          localX: round1(rm.x),
          localY: round1(rm.y)
        });
      });

      remGroup.add(boxGroup);
    }
  }

  // 3.2 切割刀路与走刀仿真动画（含提刀空程 G00 路径）
  const shouldRenderPath = (p0.showPath || p0.simCutStep != null) && p0.cuts.length > 0;
  if (shouldRenderPath) {
    const pathGroup = new Konva.Group({ listening: false });
    tpRollGroup.add(pathGroup);

    const { segments } = computeToolpathSegments(
      p0.cuts,
      p0.startCorner,
      p0.rollWidthMm,
      p0.occupiedLengthMm > 0 ? p0.occupiedLengthMm : p0.rollLengthMm
    );
    const isSimMode = p0.simCutStep != null;
    const activeStep = isSimMode
      ? Math.max(0, Math.min(segments.length, p0.simCutStep!))
      : segments.length;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const stepIdx = i + 1;
      const isCurrent = isSimMode && stepIdx === activeStep;
      const isDone = !isSimMode || stepIdx < activeStep;

      if (isSimMode && stepIdx <= activeStep && seg.rapidDistMm > 0.5) {
        pathGroup.add(
          new Konva.Line({
            points: [seg.rapidStart.x, seg.rapidStart.y, seg.rapidEnd.x, seg.rapidEnd.y],
            stroke: isCurrent ? '#0284c7' : 'rgba(2, 132, 199, 0.35)',
            strokeWidth: isCurrent ? 1.8 : 1.1,
            dash: [4, 4],
            strokeScaleEnabled: false,
            listening: false
          })
        );
      }

      pathGroup.add(
        new Konva.Line({
          points: [seg.cutStart.x, seg.cutStart.y, seg.cutEnd.x, seg.cutEnd.y],
          stroke: isCurrent ? '#f97316' : isDone ? '#e11d48' : 'rgba(225, 29, 72, 0.22)',
          strokeWidth: isCurrent ? 3.2 : isDone ? 1.6 : 1,
          dash: isCurrent ? undefined : isDone ? (isSimMode ? undefined : [6, 4]) : [3, 4],
          strokeScaleEnabled: false,
          listening: false
        })
      );

      if (isCurrent) {
        const headHalo = new Konva.Circle({
          x: seg.cutEnd.x,
          y: seg.cutEnd.y,
          fill: 'rgba(249, 115, 22, 0.25)',
          stroke: '#f97316',
          strokeWidth: 1.8,
          strokeScaleEnabled: false,
          listening: false
        });
        const headDot = new Konva.Circle({
          x: seg.cutEnd.x,
          y: seg.cutEnd.y,
          fill: '#ea580c',
          listening: false
        });
        const startDot = new Konva.Circle({
          x: seg.cutStart.x,
          y: seg.cutStart.y,
          fill: '#0284c7',
          listening: false
        });
        const stepBadge = new Konva.Text({
          x: (seg.cutStart.x + seg.cutEnd.x) / 2,
          y: (seg.cutStart.y + seg.cutEnd.y) / 2,
          text: `#${seg.step}`,
          fill: '#ea580c',
          fontStyle: '700',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          listening: false
        });
        pathGroup.add(headHalo, headDot, startDot, stepBadge);
        const syncSimHead = () => {
          const s = Math.max(0.002, refs.camRef.current.scale);
          headHalo.radius(10 / s);
          headDot.radius(4.5 / s);
          startDot.radius(3.5 / s);
          stepBadge.fontSize(11 / s);
          stepBadge.rotation(propsRef.current.vertical ? 0 : 90);
        };
        syncSimHead();
        refs.toolpathScaleNodesRef.current.push(syncSimHead);
      }
    }
  }

  refs.toolpathLayerRef.current?.batchDraw();
}
