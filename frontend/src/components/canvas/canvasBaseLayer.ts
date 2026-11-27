import type { MutableRefObject } from 'react';
import Konva from '../../vendor/konva';
import { round1 } from './canvasGeometry';
import {
  buildBaseSignature,
  ensureHatchTiles,
  type BoardCanvasLiveProps,
  type BoardCanvasRefs,
  type DragFeedbackState,
  type ValidateRollPlacementFn
} from './canvasKonvaHelpers';
import type { CameraController } from './canvasCamera';
import { renderStagingArea } from './canvasStagingArea';

export interface RenderBaseLayerParams {
  refs: BoardCanvasRefs;
  propsRef: MutableRefObject<BoardCanvasLiveProps>;
  cam: CameraController;
  validateRollPlacement: ValidateRollPlacementFn;
  setDragFeedback: (fb: DragFeedbackState | null) => void;
}

export function renderBaseLayer(params: RenderBaseLayerParams): void {
  const { refs, propsRef, cam, validateRollPlacement, setDragFeedback } = params;
  const stagingGroup = refs.stagingGroupRef.current;
  const rollGroup = refs.baseRollGroupRef.current;
  const host = refs.hostRef.current;
  if (!Konva || !stagingGroup || !rollGroup || !host) return;

  const p = propsRef.current;
  const sig = buildBaseSignature({
    rollTitle: p.rollTitle,
    rollWidthMm: p.rollWidthMm,
    rollLengthMm: p.rollLengthMm,
    occupiedLengthMm: p.occupiedLengthMm,
    trimStartMm: p.trimStartMm,
    demands: p.demands,
    zones: p.zones,
    rollShape: p.rollShape,
    showStaging: p.showStaging,
    interactivePieces: p.interactivePieces,
    vertical: p.vertical,
    tool: p.tool,
    dark: p.darkTheme
  });
  if (sig === refs.lastBaseSigRef.current) {
    return;
  }
  refs.lastBaseSigRef.current = sig;

  stagingGroup.destroyChildren();
  rollGroup.destroyChildren();
  refs.baseScaleNodesRef.current = [];
  refs.pieceNodeMapRef.current = refs.pieceNodeMapRef.current.filter((it) => it.layerKind !== 'base');

  ensureHatchTiles(refs.hatchCacheRef.current);
  cam.syncAllRollGroupsTransform();
  rollGroup.draggable(p.tool === 'pan');

  // 1.1 左侧待排区
  renderStagingArea({
    refs,
    propsRef,
    host,
    stagingGroup,
    getRollWorldRect: cam.getRollWorldRect,
    validateRollPlacement,
    setDragFeedback
  });

  // 1.2 母卷顶部拖动手柄条
  const handleGroup = new Konva.Group();
  const handleBg = new Konva.Rect({
    fill: p.darkTheme ? '#1e293b' : '#ffffff',
    stroke: p.darkTheme ? 'rgba(148, 163, 184, 0.28)' : 'rgba(15, 23, 42, 0.14)',
    strokeWidth: 1,
    strokeScaleEnabled: false,
    cornerRadius: 6,
    shadowColor: 'rgba(15, 23, 42, 0.12)',
    shadowBlur: 6,
    shadowOffsetY: 2
  });
  const handleTitle = new Konva.Text({
    text: `${p.rollTitle} · ${Math.round(p.rollWidthMm)}×${Math.round(p.rollLengthMm)} mm`,
    fill: p.darkTheme ? '#f8fafc' : '#18181b',
    fontStyle: '600',
    wrap: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
    listening: false
  });
  const handleHint = new Konva.Text({
    text: '拖动整卷',
    fill: p.darkTheme ? '#94a3b8' : '#8e929b',
    wrap: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
    listening: false
  });
  handleGroup.add(handleBg, handleTitle, handleHint);
  handleGroup.on('mouseenter', () => {
    if (propsRef.current.tool === 'pan') host.style.cursor = 'grab';
  });
  handleGroup.on('mouseleave', () => {
    host.style.cursor =
      propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure'
        ? 'crosshair'
        : '';
  });
  rollGroup.add(handleGroup);

  const syncHandleBar = () => {
    const s = Math.max(0.002, refs.camRef.current.scale);
    const isVert = propsRef.current.vertical;
    const barH = 26 / s;
    const gap = 8 / s;
    const padX = 10 / s;
    handleTitle.fontSize(11.5 / s);
    handleHint.fontSize(10.5 / s);
    const titleW = handleTitle.width();
    const hintW = handleHint.width();
    const baseSpan = isVert ? p.rollWidthMm : p.rollLengthMm;
    const showHint = baseSpan * s >= (titleW + hintW) * s + 34 && propsRef.current.tool === 'pan';
    const barW = Math.max(
      baseSpan,
      titleW + padX * 2 + (showHint ? hintW + 14 / s : 0)
    );

    if (isVert) {
      handleGroup.rotation(0);
      const hx = propsRef.current.showStaging ? 0 : (p.rollWidthMm - barW) / 2;
      handleGroup.position({ x: hx, y: -(barH + gap) });
    } else {
      handleGroup.rotation(90);
      const hy = propsRef.current.showStaging ? 0 : (p.rollLengthMm - barW) / 2;
      handleGroup.position({ x: p.rollWidthMm + barH + gap, y: hy });
    }
    handleBg.position({ x: 0, y: 0 });
    handleBg.size({ width: barW, height: barH });
    handleBg.cornerRadius(6 / s);
    handleTitle.position({ x: padX, y: 7 / s });
    handleHint.visible(showHint);
    if (showHint) {
      handleHint.position({ x: barW - hintW - padX, y: 7.5 / s });
    }
  };
  syncHandleBar();
  refs.baseScaleNodesRef.current.push(syncHandleBar);

  // 1.3 母卷纸面
  const sheetFill = p.darkTheme ? '#1e293b' : '#ffffff';
  const sheetStroke = p.darkTheme ? '#475569' : '#cbd5e1';
  const rollSheet =
    p.rollShape?.type === 'POLYGON' && p.rollShape.vertices && p.rollShape.vertices.length >= 3
      ? new Konva.Line({
          points: p.rollShape.vertices.flatMap((pt) => [pt.x, pt.y]),
          closed: true,
          fill: sheetFill,
          stroke: sheetStroke,
          strokeWidth: 1.5,
          strokeScaleEnabled: false,
          shadowColor: p.darkTheme ? 'rgba(0, 0, 0, 0.42)' : 'rgba(15, 23, 42, 0.13)',
          shadowBlur: 20,
          shadowOffsetY: 6
        })
      : new Konva.Rect({
          x: 0,
          y: 0,
          width: p.rollWidthMm,
          height: p.rollLengthMm,
          fill: sheetFill,
          stroke: sheetStroke,
          strokeWidth: 1.5,
          strokeScaleEnabled: false,
          shadowColor: p.darkTheme ? 'rgba(0, 0, 0, 0.42)' : 'rgba(15, 23, 42, 0.13)',
          shadowBlur: 20,
          shadowOffsetY: 6
        });
  rollSheet.on('mouseenter', () => {
    if (propsRef.current.tool === 'pan') host.style.cursor = 'grab';
  });
  rollSheet.on('mouseleave', () => {
    host.style.cursor =
      propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure'
        ? 'crosshair'
        : '';
  });
  rollSheet.on('click tap', (e: any) => {
    e.cancelBubble = true;
    propsRef.current.onSelectPiece?.(null);
    propsRef.current.onSelectLeftover?.(null);
  });
  rollSheet.on('contextmenu', (e: any) => {
    const cur = propsRef.current;
    if (!cur.onContextMenu && !cur.onContextInspect) return;
    e.evt.preventDefault();
    e.cancelBubble = true;
    const pt = refs.stageRef.current?.getPointerPosition();
    const local = pt ? cam.stageToRollLocal(pt) : null;
    const lx = local ? round1(local.x) : 0;
    const ly = local ? round1(local.y) : 0;
    cur.onContextMenu?.({
      kind: 'empty',
      clientX: e.evt.clientX,
      clientY: e.evt.clientY,
      localX: lx,
      localY: ly
    });
    if (local) cur.onContextInspect?.({ x: lx, y: ly });
  });
  rollGroup.add(rollSheet);

  // 1.4 内部米线参考
  const meterStep =
    p.rollLengthMm > 60000
      ? 10000
      : p.rollLengthMm > 20000
      ? 5000
      : p.rollLengthMm > 10000
      ? 2000
      : 1000;
  for (let y = meterStep; y < p.rollLengthMm; y += meterStep) {
    rollGroup.add(
      new Konva.Line({
        points: [0, y, p.rollWidthMm, y],
        stroke: 'rgba(15, 23, 42, 0.06)',
        strokeWidth: 1,
        strokeScaleEnabled: false,
        listening: false
      })
    );
  }

  // 1.5 分区
  for (const z of p.zones) {
    const zy = Math.max(0, z.startY);
    const zh = Math.max(0, Math.min(p.rollLengthMm - zy, z.lengthMm));
    if (zh <= 0.1) continue;
    if (z.kind === 'window') {
      rollGroup.add(
        new Konva.Rect({
          x: 0,
          y: zy,
          width: p.rollWidthMm,
          height: zh,
          fill: 'rgba(16, 185, 129, 0.04)',
          stroke: 'rgba(16, 185, 129, 0.55)',
          strokeWidth: 1.3,
          dash: [6, 4],
          strokeScaleEnabled: false,
          listening: false
        })
      );
    } else {
      const isCut = z.kind === 'cut';
      const isPlanned = z.kind === 'planned';
      rollGroup.add(
        new Konva.Rect({
          x: 0,
          y: zy,
          width: p.rollWidthMm,
          height: zh,
          ...(isPlanned
            ? { fill: 'rgba(91, 97, 246, 0.08)' }
            : {
                fillPatternImage: isCut ? refs.hatchCacheRef.current.cut : refs.hatchCacheRef.current.used
              }),
          stroke: isPlanned ? 'rgba(91, 97, 246, 0.5)' : '#94a3b8',
          strokeWidth: 1.1,
          dash: isPlanned ? [5, 4] : undefined,
          strokeScaleEnabled: false,
          listening: false
        })
      );
      if (z.label) {
        const zTxt = new Konva.Text({
          text: z.label,
          fill: isPlanned ? '#4338ca' : '#475569',
          fontStyle: '600',
          wrap: 'none',
          ellipsis: true,
          fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
          listening: false
        });
        rollGroup.add(zTxt);
        const syncZoneTxt = () => {
          const s = Math.max(0.002, refs.camRef.current.scale);
          const isVert = propsRef.current.vertical;
          const visible = isVert
            ? zh * s >= 18 && p.rollWidthMm * s >= 52
            : zh * s >= 48 && p.rollWidthMm * s >= 20;
          zTxt.visible(visible);
          zTxt.fontSize(10.5 / s);
          zTxt.rotation(isVert ? 0 : 90);
          if (isVert) {
            zTxt.width(Math.max(10, p.rollWidthMm - 14 / s));
            zTxt.position({ x: 7 / s, y: zy + 5 / s });
          } else {
            zTxt.width(Math.max(10, zh - 12 / s));
            zTxt.position({ x: p.rollWidthMm - 6 / s, y: zy + 6 / s });
          }
        };
        syncZoneTxt();
        refs.baseScaleNodesRef.current.push(syncZoneTxt);
      }
    }
  }

  // 1.6 首端切头修边区
  if (p.trimStartMm > 0) {
    const trimH = Math.min(p.trimStartMm, p.rollLengthMm);
    rollGroup.add(
      new Konva.Rect({
        x: 0,
        y: 0,
        width: p.rollWidthMm,
        height: trimH,
        fillPatternImage: refs.hatchCacheRef.current.trim,
        stroke: '#94a3b8',
        strokeWidth: 1,
        dash: [4, 4],
        strokeScaleEnabled: false,
        listening: false
      })
    );
    const trimLabel = new Konva.Text({
      text: `切头修边 ${Math.round(p.trimStartMm)} mm`,
      fill: '#64748b',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      listening: false
    });
    rollGroup.add(trimLabel);
    const syncTrimLabel = () => {
      const s = Math.max(0.002, refs.camRef.current.scale);
      const isVert = propsRef.current.vertical;
      trimLabel.visible(trimH * s >= 14);
      trimLabel.fontSize(10 / s);
      trimLabel.rotation(isVert ? 0 : 90);
      if (isVert) {
        trimLabel.position({ x: 8 / s, y: Math.max(2 / s, (trimH - 11 / s) / 2) });
      } else {
        trimLabel.position({ x: p.rollWidthMm - 8 / s, y: 4 / s });
      }
    };
    syncTrimLabel();
    refs.baseScaleNodesRef.current.push(syncTrimLabel);
  }

  // 1.7 实占长度标记线
  if (p.occupiedLengthMm > 0 && p.occupiedLengthMm <= p.rollLengthMm) {
    rollGroup.add(
      new Konva.Line({
        points: [0, p.occupiedLengthMm, p.rollWidthMm, p.occupiedLengthMm],
        stroke: '#10b981',
        strokeWidth: 1.4,
        dash: [6, 4],
        strokeScaleEnabled: false,
        listening: false
      })
    );
    const occTag = new Konva.Text({
      text: `实占 ${round1(p.occupiedLengthMm)} mm`,
      fill: p.darkTheme ? '#34d399' : '#047857',
      fontStyle: '600',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      listening: false
    });
    rollGroup.add(occTag);
    const syncOcc = () => {
      const s = Math.max(0.002, refs.camRef.current.scale);
      const isVert = propsRef.current.vertical;
      occTag.fontSize(10.5 / s);
      occTag.rotation(isVert ? 0 : 90);
      if (isVert) {
        occTag.position({ x: p.rollWidthMm + 8 / s, y: p.occupiedLengthMm - 6 / s });
      } else {
        occTag.position({ x: -8 / s, y: p.occupiedLengthMm - 4 / s });
      }
    };
    syncOcc();
    refs.baseScaleNodesRef.current.push(syncOcc);
  }

  const fitSig = `${p.rollWidthMm}x${p.rollLengthMm}-${p.vertical ? 'V' : 'H'}-${p.showStaging ? 'S' : 'N'}-${p.demands.map((d) => d.key).join(',')}`;
  if (!refs.didInitialFitRef.current || fitSig !== refs.lastFitSigRef.current) {
    refs.lastFitSigRef.current = fitSig;
    refs.didInitialFitRef.current = true;
    cam.fitView();
  } else {
    cam.applyCameraImmediate();
  }
}
