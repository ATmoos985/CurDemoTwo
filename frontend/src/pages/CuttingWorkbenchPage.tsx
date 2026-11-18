import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandItem,
  SavedScheme2D,
  SlittingSchemeRun,
  DemandFamilySummary,
  Scenario2DType
} from '../store/useStudioStore';
import { StudioSettings, DEFAULT_STUDIO_SETTINGS } from '../store/studioSettings';
import { CadCanvasView } from '../components/CadCanvasView';
import { ModalDialog } from '../components/ModalDialog';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import { showcaseScene } from '@static/app/js/model/showcase.js';
import { rectangle, shapeArea } from '@static/js/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '@static/js/plugins/export/cam-format.js';
import { independentBaseline, planSummary } from '@static/js/linear/linear-model.js';
import { carStart, assignCar } from '@static/app/js/model/slitting.js';
import { requestJSON, toast, fmtN, fmtM, loadSheetLib } from '@static/app/js/util.js';

interface SolverStrategyDef {
  id: string;
  name: string;
  shortTag: string;
  badge: string;
  description: string;
  halfTurn: boolean;
  forceRotateRect?: boolean;
  shorten: boolean;
  gapFill: boolean;
  enginePref: 'auto' | 'java' | 'deepnest';
  timeLimit: number;
}

const STRATEGIES_2D: SolverStrategyDef[] = [
  {
    id: 'SHORTEN_FIXED',
    name: 'PackingSolver 严格经向缩长',
    shortTag: '0° 保丝缕 · 二分缩长压紧',
    badge: 'C++ 原生',
    description: '保持全部裁片严格 0° 丝缕方向，多轮二分缩短并压紧唛架长度（或矩形最优直刀）',
    halfTurn: false,
    forceRotateRect: false,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'SHORTEN_HALF_TURN',
    name: 'PackingSolver 180°倒顺缩长',
    shortTag: '异形 180° / 矩形 90° · 最短版长',
    badge: 'C++ 原生',
    description: '异形片允许 180° 倒顺对排、矩形允许 90° 旋转，追求最短长度与最低单耗',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'DEEPNEST_NFP_GA',
    name: 'Deepnest NFP+GA 进化嵌套',
    shortTag: 'Minkowski 临界多边形 + 遗传共边寻优',
    badge: 'NFP+GA',
    description: '使用 Minkowski 临界多边形卷积与遗传算法进化搜索凹凸互补与共边奖励',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 8
  },
  {
    id: 'DEEPNEST_FIXED_GRAIN',
    name: 'Deepnest 严格经向直排',
    shortTag: '0° 固定丝缕 · NFP 精确凹凸贴合',
    badge: 'NFP 经向',
    description: '保持 0° 丝缕方向，采用 Deepnest NFP 精确凹凸嵌套进化直排对照',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 5
  },
  {
    id: 'JAVA_HEURISTIC',
    name: 'Java 天际线/直刀快速基线',
    shortTag: '毫秒级启发式快速对照基线',
    badge: 'Java 内置',
    description: '独立线程并行运行内置天际线/直刀快速启发式引擎，作多算法交叉验证基线',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'java',
    timeLimit: 5
  }
];

const SCENARIOS_2D: { id: Scenario2DType; label: string; desc: string }[] = [
  { id: 'SHORTEN_KIT', label: '齐套最短版长', desc: '装入全部待排需求并自动压紧最短用布长度' },
  { id: 'SHORTEN_GAP_FILL', label: '齐套 + 空隙补备片', desc: '主片齐套后在空隙内自动填补同款小件提利用率' },
  { id: 'FIXED_BED', label: '定长台板装入', desc: '按设定版长上限单次装入最大裁片面积（适合单床或料头）' },
  { id: 'MULTI_WIDTH', label: '多门幅阶梯比选', desc: '在虚拟新母卷模式下批量测算不同门幅的用料单耗' }
];

const STRIP_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4f46e5'];

export function SlittingStripBar({
  motherWidthMm,
  leftTrimMm,
  rightTrimMm,
  stations
}: {
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  stations: { widthMm: number; countPerRepetition: number }[];
}) {
  const strips = stations.flatMap((s) => Array(s.countPerRepetition).fill(s.widthMm));
  const usedWidth = strips.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, motherWidthMm - leftTrimMm - rightTrimMm - usedWidth);

  return (
    <div className="slit-bar-wrap" title={`总幅宽 ${motherWidthMm}mm · 已用 ${usedWidth}mm · 余宽 ${spare}mm`}>
      {leftTrimMm > 0 && (
        <div className="slit-seg slit-trim" style={{ width: `${(leftTrimMm / motherWidthMm) * 100}%` }}>
          {leftTrimMm >= 60 ? `${leftTrimMm}` : ''}
        </div>
      )}
      {strips.map((w, idx) => (
        <div
          key={idx}
          className="slit-seg"
          style={{
            width: `${(w / motherWidthMm) * 100}%`,
            backgroundColor: STRIP_COLORS[w % STRIP_COLORS.length]
          }}
        >
          <span>{w}</span>
        </div>
      ))}
      {spare > 0 && (
        <div className="slit-seg slit-spare" style={{ width: `${(spare / motherWidthMm) * 100}%` }}>
          {spare >= 80 ? `余 ${spare}` : ''}
        </div>
      )}
      {rightTrimMm > 0 && (
        <div className="slit-seg slit-trim" style={{ width: `${(rightTrimMm / motherWidthMm) * 100}%` }}>
          {rightTrimMm >= 60 ? `${rightTrimMm}` : ''}
        </div>
      )}
    </div>
  );
}

function buildOptimizationRequest2D(
  strategy: SolverStrategyDef,
  scenario: Scenario2DType,
  widthMm: number,
  lengthMm: number,
  pieceGapMm: number,
  trimStartMm: number,
  demands: DemandItem[],
  defects: any[] = [],
  maxLengthCapMm?: number,
  settings: StudioSettings = DEFAULT_STUDIO_SETTINGS
) {
  const hasPolygon = demands.some((d) => d.shape?.type === 'POLYGON');
  const mode = hasPolygon ? 'CONTOUR' : 'GUILLOTINE';
  const engine =
    strategy.enginePref === 'deepnest'
      ? mode === 'CONTOUR'
        ? 'deepnest'
        : 'javaguillotine'
      : strategy.enginePref === 'java'
      ? mode === 'CONTOUR'
        ? 'javairregular'
        : 'javaguillotine'
      : 'auto';

  const openLengthScenario = scenario !== 'FIXED_BED';
  const useShorten = openLengthScenario && (strategy.shorten || scenario === 'MULTI_WIDTH');
  const useGapFill = scenario === 'SHORTEN_GAP_FILL' || strategy.gapFill;

  const parts = demands
    .filter((d) => d.quantity > 0 && d.width > 0 && d.length > 0)
    .map((d, idx) => {
      const baseShape = d.shape
        ? structuredClone(d.shape)
        : mode === 'CONTOUR'
        ? {
            type: 'POLYGON' as const,
            width: Number(d.width),
            height: Number(d.length),
            vertices: [
              { x: 0, y: 0 },
              { x: Number(d.width), y: 0 },
              { x: Number(d.width), y: Number(d.length) },
              { x: 0, y: Number(d.length) }
            ]
          }
        : rectangle(Number(d.width), Number(d.length));
      return {
        id: d.id || idx + 1,
        name: d.name,
        quantity: Math.max(1, Math.floor(d.quantity)),
        allowRotation:
          mode === 'GUILLOTINE'
            ? Boolean(strategy.forceRotateRect || d.allowRotation)
            : Boolean(d.allowRotation),
        ...(mode === 'CONTOUR' && (strategy.halfTurn || d.allowHalfTurn) ? { allowHalfTurn: true } : {}),
        shape: baseShape
      };
    });

  let rowX = 0;
  let rowY = trimStartMm;
  let rowH = 0;
  for (const p of parts) {
    for (let i = 0; i < p.quantity; i++) {
      if (rowX + p.shape.width > widthMm) {
        rowY += rowH + pieceGapMm;
        rowX = 0;
        rowH = 0;
      }
      rowX += p.shape.width + pieceGapMm;
      rowH = Math.max(rowH, p.shape.height);
    }
  }
  const rawHeight = openLengthScenario
    ? Math.max(lengthMm, Math.ceil(rowY + rowH + 180))
    : lengthMm;
  const safeStartHeight =
    maxLengthCapMm != null && maxLengthCapMm > 0 ? Math.min(rawHeight, maxLengthCapMm) : rawHeight;

  const exclusions = defects.map((d, i) => {
    const margin = d.margin ?? settings.defectMarginMm;
    return {
      id: d.id || i + 1,
      x: Math.max(0, d.x - margin),
      y: Math.max(0, d.y - margin),
      shape: rectangle(d.w + 2 * margin, d.h + 2 * margin),
      clearance: 0
    };
  });

  const timeScale = Math.max(0.2, (settings.timeLimitSeconds || 5) / 5);
  const scaledTimeLimit = Math.min(120, Math.max(1, Math.round(strategy.timeLimit * timeScale)));

  const problem = {
    schemaVersion: '1',
    unit: 'mm',
    engine,
    timeLimitSeconds: scaledTimeLimit,
    material: {
      id: `CANVAS-${widthMm}x${safeStartHeight}`,
      shape: rectangle(widthMm, safeStartHeight),
      continuesAfterRegion: false,
      exclusions
    },
    parts,
    process: {
      mode,
      feedMode: 'SHEET',
      startCorner: settings.startCorner,
      firstStageOrientation: mode === 'CONTOUR' ? 'none' : settings.firstStageOrientation,
      trimStart: mode === 'CONTOUR' ? 0 : trimStartMm,
      minReusableWidth: mode === 'CONTOUR' ? 0 : settings.minRemnantWidthMm,
      minReusableHeight: mode === 'CONTOUR' ? 0 : settings.minRemnantLengthMm,
      kerf: 0,
      objective: 'MAXIMIZE_PIECE_AREA',
      pieceGap: pieceGapMm
    }
  };

  const canUseMarkerStrategy =
    mode === 'CONTOUR' &&
    useShorten &&
    strategy.enginePref !== 'java' &&
    parts.every((p) => p.shape.width <= widthMm);

  const strategyBlock = canUseMarkerStrategy
    ? {
        id: 'marker-shortening',
        version: '2',
        maxTrials: 7,
        ...(useGapFill
          ? {
              gapFillLimits: Object.fromEntries(
                parts.slice(0, 80).map((p) => [p.id, Math.min(80, Math.max(2, p.quantity))])
              )
            }
          : {})
      }
    : undefined;

  return {
    schemaVersion: '2.0',
    clientRequestId: `studio-${strategy.id}-${widthMm}-${Date.now()}`,
    problemType: 'NESTING_2D',
    allowFallback: settings.allowFallback,
    requireComplete: Boolean(canUseMarkerStrategy),
    problem,
    ...(strategyBlock ? { strategy: strategyBlock } : {})
  };
}

export const CuttingWorkbenchPage: React.FC<{
  taskId?: string;
  forceDimension?: '2D' | '1D';
}> = ({ taskId, forceDimension }) => {
  const {
    clusters,
    clusterSelections,
    syncTemplatesFromServer,
    setClusterCount,
    importDxfAsCluster,
    loadClusterInto2D,
    loadClusterInto1D,
    loadDemandFamilyIntoWorkbench,
    syncDemandFamilyProgress,
    activeDimension,
    setActiveDimension,
    scenario2D,
    setScenario2D,
    multiWidthsText2D,
    setMultiWidthsText2D,
    scenario1D,
    setScenario1D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    pieceGapMm,
    trimStartMm,
    selectedRollId,
    selectedRemnantId,
    materialModel2D,
    loadedTaskId,
    loadedTaskName,
    loadedExternalRef,
    activeDemands2D,
    selectedStrategies2D,
    strategyRuns2D,
    schemes2D,
    activeSchemeId2D,
    setCanvasSpec,
    updateDemand2D,
    removeDemand2D,
    addBlankDemand2D,
    toggleStrategy2D,
    setStrategyRuns2D,
    addSchemes2D,
    removeScheme2D,
    clearSchemes2D,
    setActiveScheme2D,
    markSchemeDispatched,
    slitMaterialMode,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitRollId,
    slitMaterialModel,
    slitLoadedTaskId,
    slitLoadedTaskName,
    slitOrders,
    slitSchemes,
    activeSlitSchemeId,
    setSlitSpec,
    updateSlitOrder,
    addSlitOrder,
    removeSlitOrder,
    setSlitSchemes,
    setActiveSlitScheme,
    markSlitSchemeDispatched,
    settings
  } = useStudioStore();

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [poolFamilies, setPoolFamilies] = useState<DemandFamilySummary[]>([]);
  const [taskSchemes, setTaskSchemes] = useState<any[]>([]);
  const [demandSourceTab, setDemandSourceTab] = useState<'POOL' | 'TEMPLATE'>('TEMPLATE');
  const [activeClusterQuickId, setActiveClusterQuickId] = useState('DXF_1226');
  const [overviewModalOpen, setOverviewModalOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<'progress' | 'edit'>('progress');

  const [workerCount, setWorkerCount] = useState<number>(6);
  const [vertical, setVertical] = useState<boolean>(settings.vertical);
  const [showPath, setShowPath] = useState<boolean>(settings.showPath);
  const [showDimensions, setShowDimensions] = useState<boolean>(settings.showDimensions);

  useEffect(() => {
    setVertical(settings.vertical);
    setShowPath(settings.showPath);
    setShowDimensions(settings.showDimensions);
  }, [settings.vertical, settings.showPath, settings.showDimensions]);
  const [tool, setTool] = useState<'pan' | 'measure'>('pan');
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);
  const [inspectedText, setInspectedText] = useState<string>(
    '默认已创建虚拟新母卷画布 · 滚轮缩放 · 拖拽平移 · 右键查看单件坐标'
  );

  const [runningSolve, setRunningSolve] = useState(false);
  const [confirmingScheme, setConfirmingScheme] = useState(false);
  const [lastConfirmSummary, setLastConfirmSummary] = useState<{
    schemeId: string;
    openRemaining: number;
    state: string;
  } | null>(null);

  const leftPaneRef = useRef<HTMLElement | null>(null);
  const rightPaneRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const canvasInstanceRef = useRef<any>(null);
  const activeSessionsRef = useRef<OptimizationSession[]>([]);

  const reloadReferenceData = async (explicitTaskId?: string | null) => {
    const curTaskId =
      explicitTaskId !== undefined
        ? explicitTaskId
        : activeDimension === '2D'
        ? loadedTaskId
        : slitLoadedTaskId;
    const [rList, remList, famList, schList] = await Promise.all([
      requestJSON('/api/rolls').catch(() => []),
      requestJSON('/api/remnants').catch(() => []),
      requestJSON('/api/v2/demand-pool').catch(() => []),
      curTaskId
        ? requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`).catch(() => [])
        : Promise.resolve([])
    ]);
    setRolls(Array.isArray(rList) ? rList : []);
    setRemnants(Array.isArray(remList) ? remList : []);
    const fams: DemandFamilySummary[] = Array.isArray(famList) ? famList : [];
    setPoolFamilies(fams);
    setTaskSchemes(Array.isArray(schList) ? schList : []);
    if (curTaskId) {
      const matched = fams.find((f) => f.id === curTaskId);
      if (matched) {
        syncDemandFamilyProgress(matched);
      }
      setDemandSourceTab('POOL');
    }
    return fams;
  };

  useEffect(() => {
    if (forceDimension) {
      setActiveDimension(forceDimension);
    }
  }, [forceDimension]);

  useEffect(() => {
    syncTemplatesFromServer();
    reloadReferenceData();
    requestJSON('/api/v2/capabilities')
      .then((c) => {
        if (c?.limits?.workers) setWorkerCount(c.limits.workers);
      })
      .catch(() => {});
    return () => {
      activeSessionsRef.current.forEach((s) => s.cancel());
    };
  }, []);

  // Load Demand Family if navigated via #/workbench/:taskId
  useEffect(() => {
    if (!taskId) return;
    requestJSON('/api/v2/demand-pool/' + encodeURIComponent(taskId))
      .then((fam: DemandFamilySummary) => {
        if (fam?.id) {
          loadDemandFamilyIntoWorkbench(fam);
          setDemandSourceTab('POOL');
        }
      })
      .catch((e) => toast('加载需求族失败：' + e.message, true));
  }, [taskId]);

  useEffect(() => {
    const curTaskId = activeDimension === '2D' ? loadedTaskId : slitLoadedTaskId;
    if (!curTaskId) {
      setTaskSchemes([]);
      return;
    }
    requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`)
      .then((list) => setTaskSchemes(Array.isArray(list) ? list : []))
      .catch(() => setTaskSchemes([]));
  }, [activeDimension, loadedTaskId, slitLoadedTaskId]);

  const passedRolls = useMemo(
    () => rolls.filter((r) => r.inspectionStatus === 'PASSED'),
    [rolls]
  );
  const availableRemnants = useMemo(
    () => remnants.filter((rm) => rm.status === 'AVAILABLE'),
    [remnants]
  );

  const currentRoll2D = useMemo(
    () => passedRolls.find((r) => r.rollId === selectedRollId) || passedRolls[0] || null,
    [passedRolls, selectedRollId]
  );
  const currentRemnant2D = useMemo(
    () => availableRemnants.find((rm) => rm.id === selectedRemnantId) || availableRemnants[0] || null,
    [availableRemnants, selectedRemnantId]
  );
  const currentRoll1D = useMemo(
    () => passedRolls.find((r) => r.rollId === slitRollId) || passedRolls[0] || null,
    [passedRolls, slitRollId]
  );

  const activeScheme2D = useMemo(
    () => schemes2D.find((s) => s.id === activeSchemeId2D) || null,
    [schemes2D, activeSchemeId2D]
  );
  const activeScheme1D = useMemo(
    () => slitSchemes.find((s) => s.id === activeSlitSchemeId) || slitSchemes[0] || null,
    [slitSchemes, activeSlitSchemeId]
  );

  // Current 2D Canvas Scene (shows virtual new mother roll or stock roll + real defects in window!)
  const currentScene2D = useMemo(() => {
    const projectScene = showcaseScene as any;
    if (activeScheme2D?.request && activeScheme2D?.result) {
      return projectScene(activeScheme2D.request, activeScheme2D.result, 0, {
        occupiedLengthMm: activeScheme2D.occupiedLengthMm,
        gapFillPlacements: activeScheme2D.result?.marker?.gapFillPlacements
      });
    }
    const windowDefects =
      canvasMode === 'STOCK_ROLL' && currentRoll2D
        ? (currentRoll2D.defects || [])
            .filter(
              (d: any) =>
                d.y < (currentRoll2D.usedLength || 0) + canvasLengthMm &&
                d.y + d.h > (currentRoll2D.usedLength || 0)
            )
            .map((d: any) => ({
              ...d,
              y: Math.max(0, d.y - (currentRoll2D.usedLength || 0))
            }))
        : canvasMode === 'REMNANT' && currentRemnant2D
        ? currentRemnant2D.defects || []
        : [];

    const effW =
      canvasMode === 'STOCK_ROLL' && currentRoll2D
        ? currentRoll2D.width
        : canvasMode === 'REMNANT' && currentRemnant2D
        ? currentRemnant2D.width
        : canvasWidthMm;
    const effL =
      canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;

    const previewReq = buildOptimizationRequest2D(
      STRATEGIES_2D[4],
      'FIXED_BED',
      effW,
      effL,
      pieceGapMm,
      trimStartMm,
      activeDemands2D,
      windowDefects,
      undefined,
      settings
    );
    return projectScene(previewReq, null);
  }, [
    activeScheme2D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    pieceGapMm,
    trimStartMm,
    activeDemands2D,
    currentRoll2D,
    currentRemnant2D,
    settings
  ]);

  // ==================== Stage 2: Parallel Solving (2D & 1D) ====================

  const handleRunSolve2D = async () => {
    if (runningSolve) return;
    let validDemands = activeDemands2D.filter(
      (d) => d.quantity > 0 && d.width > 0 && d.length > 0
    );
    if (!validDemands.length) {
      const retrial = activeDemands2D
        .filter((d) => (d.orderedQty || 0) > 0 && d.width > 0 && d.length > 0)
        .map((d) => ({ ...d, quantity: d.orderedQty || 1 }));
      if (retrial.length > 0) {
        validDemands = retrial;
        toast('该需求族已全部排完，本次按原单总量进行重排对比试算');
      } else {
        toast('请先在左侧选取需求族、载入需求模板或添加有效裁片需求', true);
        return;
      }
    }

    const chosenDefs = STRATEGIES_2D.filter((s) => selectedStrategies2D.includes(s.id));
    if (!chosenDefs.length) {
      toast('请在右侧至少勾选一种求解算法引擎', true);
      return;
    }

    // Candidate widths (single width or multi-width ladder in FREE_CANVAS mode)
    const candidateWidths =
      canvasMode === 'FREE_CANVAS' && scenario2D === 'MULTI_WIDTH'
        ? multiWidthsText2D
            .split(/[,，\s]+/)
            .map((s) => Math.round(Number(s.trim())))
            .filter((n) => n >= 400 && n <= 6000)
            .slice(0, 5)
        : [
            canvasMode === 'STOCK_ROLL' && currentRoll2D
              ? currentRoll2D.width
              : canvasMode === 'REMNANT' && currentRemnant2D
              ? currentRemnant2D.width
              : canvasWidthMm
          ];

    if (!candidateWidths.length) {
      toast('请填写有效候选门幅（400–6000 mm）', true);
      return;
    }

    const effLength =
      canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;
    const effectiveScenario: Scenario2DType =
      canvasMode === 'REMNANT' ? 'FIXED_BED' : scenario2D;

    setRunningSolve(true);
    setLastConfirmSummary(null);
    activeSessionsRef.current.forEach((s) => s.cancel());
    activeSessionsRef.current = [];

    const totalRequested = validDemands.reduce((s, d) => s + d.quantity, 0);
    const jobsToRun =
      candidateWidths.length > 1
        ? candidateWidths.map((w) => ({
            def: chosenDefs[0],
            width: w,
            runKey: `${chosenDefs[0].id}-W${w}`,
            label: `门幅 ${w}mm · ${chosenDefs[0].name}`
          }))
        : chosenDefs.map((def) => ({
            def,
            width: candidateWidths[0],
            runKey: def.id,
            label: def.name
          }));

    setStrategyRuns2D(
      jobsToRun.map((j) => ({
        strategyId: j.runKey,
        strategyName: j.label,
        description: j.def.description,
        state: 'QUEUED',
        phaseText: '排队提交…',
        requestedCount: totalRequested
      }))
    );

    const startOffset =
      canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.usedLength || 0 : 0;
    const windowDefects =
      canvasMode === 'STOCK_ROLL' && currentRoll2D
        ? (currentRoll2D.defects || [])
            .filter((d: any) => d.y < startOffset + effLength && d.y + d.h > startOffset)
            .map((d: any) => ({
              ...d,
              y: Math.max(0, d.y - startOffset)
            }))
        : canvasMode === 'REMNANT' && currentRemnant2D
        ? currentRemnant2D.defects || []
        : [];

    const createdSchemes: SavedScheme2D[] = [];

    await Promise.all(
      jobsToRun.map(async ({ def, width, runKey, label }) => {
        if (validDemands.some((d) => d.width > width && !d.allowRotation && !def.forceRotateRect)) {
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? { ...r, state: 'FAILED', phaseText: `存在裁片宽超门幅 ${width}mm` }
                : r
            )
          );
          return;
        }
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const stockMaxCap =
          canvasMode === 'STOCK_ROLL' && currentRoll2D
            ? Math.max(200, currentRoll2D.currentRemainingLength ?? currentRoll2D.totalLength)
            : undefined;
        const req = buildOptimizationRequest2D(
          def,
          effectiveScenario,
          width,
          effLength,
          pieceGapMm,
          trimStartMm,
          validDemands,
          windowDefects,
          stockMaxCap,
          settings
        );
        const t0 = performance.now();
        try {
          const { job, result } = await (session as any).solve(req, {
            onProgress: (j: any) => {
              setStrategyRuns2D((prev) =>
                prev.map((r) =>
                  r.strategyId === runKey
                    ? {
                        ...r,
                        jobId: j.id,
                        state: j.state === 'QUEUED' ? 'QUEUED' : 'RUNNING',
                        phaseText: j.message || j.phase || '计算中…'
                      }
                    : r
                )
              );
            }
          });
          const elapsedMs = Math.round(performance.now() - t0);
          const layout = result?.layout;
          const placements = layout?.placements || [];
          const gapFills = result?.marker?.gapFillPlacements || [];
          const occupiedLengthMm =
            result?.marker?.occupiedLengthMm ||
            (placements.length
              ? Math.max(...placements.map((p: any) => p.y + p.shape.height))
              : effLength);
          const netAreaMm2 = [...placements, ...gapFills].reduce(
            (s: number, p: any) => s + shapeArea(p.shape),
            0
          );
          const denomAreaMm2 = width * Math.max(1, occupiedLengthMm);
          const utilizationPct = Number(((netAreaMm2 / denomAreaMm2) * 100).toFixed(2));
          const complete = result?.fulfillmentStatus === 'COMPLETE';

          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? {
                    ...r,
                    jobId: job.id,
                    state: job.state as any,
                    phaseText: complete
                      ? `齐套 · ${fmtN(occupiedLengthMm, 1)}mm · ${utilizationPct}%`
                      : `已排 ${placements.length}/${totalRequested} · ${utilizationPct}%`,
                    elapsedMs,
                    occupiedLengthMm,
                    utilizationPct,
                    placedCount: placements.length,
                    requestedCount: totalRequested,
                    complete,
                    request: req,
                    result
                  }
                : r
            )
          );

          if (placements.length > 0) {
            const schemeId = `CAND-${runKey}-${Date.now().toString(36).slice(-4)}`;
            createdSchemes.push({
              id: schemeId,
              title: `${label} (${width}×${Math.round(occupiedLengthMm)}mm)`,
              strategyId: def.id,
              strategyName: label,
              scenarioId: effectiveScenario,
              createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              canvasMode,
              rollId: canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.rollId : undefined,
              remnantId:
                canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.id : undefined,
              windowStartY: startOffset,
              materialModel:
                canvasMode === 'STOCK_ROLL' && currentRoll2D
                  ? currentRoll2D.rollModel
                  : canvasMode === 'REMNANT' && currentRemnant2D
                  ? currentRemnant2D.materialBatch
                  : materialModel2D || `VIRTUAL-${width}`,
              widthMm: width,
              canvasLengthMm: effLength,
              occupiedLengthMm: Math.round(occupiedLengthMm * 10) / 10,
              utilizationPct,
              pieceAreaM2: Number((netAreaMm2 / 1_000_000).toFixed(3)),
              placedCount: placements.length + gapFills.length,
              requestedCount: totalRequested,
              gapFillCount: gapFills.length,
              complete,
              demands: structuredClone(validDemands),
              request: req,
              result
            });
          }
        } catch (err: any) {
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? {
                    ...r,
                    state: err.name === 'AbortError' ? 'CANCELLED' : 'FAILED',
                    phaseText: err.message || '求解未完成'
                  }
                : r
            )
          );
        }
      })
    );

    if (createdSchemes.length > 0) {
      addSchemes2D(createdSchemes);
      toast(`搭切求解完成：共生成 ${createdSchemes.length} 套候选方案供比选`);
    }
    setRunningSolve(false);
  };

  const handleRunSolve1D = async () => {
    if (runningSolve) return;
    let validOrders = slitOrders.filter((o) => o.quantity > 0 && o.widthMm > 0);
    if (!validOrders.length) {
      const retrial = slitOrders
        .filter((o) => (o.orderedQty || 0) > 0 && o.widthMm > 0)
        .map((o) => ({ ...o, quantity: o.orderedQty || 1 }));
      if (retrial.length > 0) {
        validOrders = retrial;
        toast('该分条需求族已全部排完，本次按原单总量进行重排对比试算');
      } else {
        toast('请先在左侧载入分条需求族或添加有效分条规格', true);
        return;
      }
    }
    setRunningSolve(true);
    setLastConfirmSummary(null);
    const effMotherW =
      slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
        ? currentRoll1D.width
        : slitMotherWidthMm;
    const effOverCap = scenario1D === 'MAX_UTIL' ? Math.max(slitOverCap, 30) : slitOverCap;

    try {
      const baselineInput = {
        motherWidth: effMotherW,
        leftTrim: slitLeftTrimMm,
        rightTrim: slitRightTrimMm,
        orderItems: validOrders.map((o) => ({
          width: o.widthMm,
          length: slitFixedLengthMm,
          quantity: o.quantity,
          surfaceTreatment: '默认'
        }))
      };
      const baseGroups = independentBaseline(baselineInput);
      const baseSummary = planSummary(baseGroups, baselineInput);
      const baselineRun: SlittingSchemeRun = {
        id: 'SLIT-BASELINE',
        strategyId: 'BASELINE',
        strategyName: '逐规格独立分切（传统对照基线）',
        state: 'SUCCEEDED',
        motherWidthMm: effMotherW,
        leftTrimMm: slitLeftTrimMm,
        rightTrimMm: slitRightTrimMm,
        totalCars: baseSummary.rolls,
        missingRolls: baseSummary.shortage || 0,
        overproducedRolls: baseSummary.surplus || 0,
        avgUtilizationPct: Number((baseSummary.rate || 0).toFixed(2)),
        elapsedMs: 1,
        patterns: baseGroups.map((g: any, i: number) => {
          const widthCounts = new Map<number, number>();
          for (const w of g.comboExpanded || []) {
            const nw = Number(w);
            widthCounts.set(nw, (widthCounts.get(nw) || 0) + 1);
          }
          const stations = Array.from(widthCounts.entries()).map(
            ([widthMm, countPerRepetition]) => ({ widthMm, countPerRepetition })
          );
          const usedW = stations.reduce((s, it) => s + it.widthMm * it.countPerRepetition, 0);
          return {
            id: `BASE-${i + 1}`,
            lengthMm: g.length || slitFixedLengthMm,
            repetitions: g.usageCount || 1,
            stations,
            usedWidthMm: usedW,
            spareWidthMm: Math.max(0, effMotherW - slitLeftTrimMm - slitRightTrimMm - usedW)
          };
        }),
        fulfillment: validOrders.map((o) => ({
          orderId: o.id,
          name: o.name,
          widthMm: o.widthMm,
          requested: o.quantity,
          produced: o.quantity,
          missing: 0,
          overproduced: 0
        }))
      };

      const pendingFast: SlittingSchemeRun = {
        id: 'SLIT-FAST',
        strategyId: 'FAST',
        strategyName: 'OR-Tools 多订单搭切 · 快速方案 (FAST)',
        state: 'RUNNING',
        motherWidthMm: effMotherW,
        leftTrimMm: slitLeftTrimMm,
        rightTrimMm: slitRightTrimMm,
        totalCars: 0,
        missingRolls: 0,
        overproducedRolls: 0,
        avgUtilizationPct: 0,
        patterns: [],
        fulfillment: []
      };
      const pendingQuality: SlittingSchemeRun = {
        ...pendingFast,
        id: 'SLIT-QUALITY',
        strategyId: 'QUALITY',
        strategyName: 'OR-Tools 多订单搭切 · 精细列生成 (QUALITY)'
      };
      setSlitSchemes([pendingQuality, pendingFast, baselineRun]);

      const maxUsable = Math.max(100, effMotherW - slitLeftTrimMm - slitRightTrimMm);
      const effMaxW = Math.min(maxUsable, Math.max(slitMaxWidthMm, ...validOrders.map((o) => o.widthMm)));
      const effMinW = Math.min(effMaxW, Math.max(100, slitMinWidthMm));

      const runProfile = async (profile: 'FAST' | 'QUALITY'): Promise<SlittingSchemeRun> => {
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const t0 = performance.now();
        const req = {
          schemaVersion: '2.0',
          clientRequestId: `slit-${profile}-${Date.now()}`,
          problemType: 'SLITTING_1D',
          allowFallback: false,
          requireComplete: false,
          problem: {
            schemaVersion: '1',
            unit: 'mm',
            motherWidthMm: Math.floor(effMotherW),
            leftTrimMm: Math.floor(slitLeftTrimMm),
            rightTrimMm: Math.floor(slitRightTrimMm),
            minWidthMm: Math.floor(effMinW),
            maxWidthMm: Math.floor(effMaxW),
            widthStepMm: Math.max(1, Math.floor(slitWidthStepMm)),
            totalOverCap: Math.floor(effOverCap),
            profile,
            timeLimitSeconds: profile === 'QUALITY' ? 12 : 5,
            orders: validOrders.map((o) => ({
              id: o.id,
              widthMm: Math.floor(o.widthMm),
              lengthMm: Math.floor(slitFixedLengthMm),
              quantity: Math.floor(o.quantity),
              surfaceTreatment: '默认'
            }))
          }
        };
        try {
          const { result } = await (session as any).solve(req);
          const s = result.slitting;
          const utilMetric =
            result.metrics?.find((m: any) => m.name === 'motherAreaUtilization')?.value || 0;
          const totalCars = s.patterns.reduce((n: number, p: any) => n + p.repetitions, 0);
          const missingRolls = s.fulfillment.reduce((n: number, f: any) => n + f.missing, 0);
          const overproducedRolls = s.fulfillment.reduce(
            (n: number, f: any) => n + f.overproduced,
            0
          );
          return {
            id: `SLIT-${profile}`,
            strategyId: profile,
            strategyName:
              profile === 'FAST'
                ? 'OR-Tools 多订单搭切 · 快速方案 (FAST)'
                : 'OR-Tools 多订单搭切 · 精细列生成 (QUALITY)',
            state: 'SUCCEEDED',
            motherWidthMm: effMotherW,
            leftTrimMm: slitLeftTrimMm,
            rightTrimMm: slitRightTrimMm,
            totalCars,
            missingRolls,
            overproducedRolls,
            avgUtilizationPct: Number(utilMetric.toFixed(2)),
            elapsedMs: Math.round(performance.now() - t0),
            patterns: s.patterns.map((p: any) => ({
              id: p.id,
              lengthMm: p.lengthMm,
              repetitions: p.repetitions,
              stations: p.stations,
              usedWidthMm: p.patternWidthMm,
              spareWidthMm: Math.max(
                0,
                effMotherW - slitLeftTrimMm - slitRightTrimMm - p.patternWidthMm
              ),
              allocations: p.allocations
            })),
            fulfillment: s.fulfillment.map((f: any) => {
              const ord = validOrders.find((o) => o.id === String(f.orderId));
              return {
                orderId: String(f.orderId),
                name: ord?.name || f.orderId,
                widthMm: ord?.widthMm || 0,
                requested: f.requested,
                produced: f.produced,
                missing: f.missing,
                overproduced: f.overproduced
              };
            }),
            rawResult: result
          };
        } catch (e: any) {
          return {
            ...pendingFast,
            id: `SLIT-${profile}`,
            strategyId: profile,
            strategyName: `OR-Tools (${profile}) - ${e.message}`,
            state: 'FAILED'
          };
        }
      };

      const [fastRes, qualityRes] = await Promise.all([runProfile('FAST'), runProfile('QUALITY')]);
      setSlitSchemes([qualityRes, fastRes, baselineRun]);
      toast(
        `一维搭切求解完成：精细方案 ${qualityRes.totalCars} 车（较传统独立分切节省 ${Math.max(
          0,
          baselineRun.totalCars - qualityRes.totalCars
        )} 车）`
      );
    } catch (e: any) {
      toast('一维分切求解失败：' + e.message, true);
    } finally {
      setRunningSolve(false);
    }
  };

  const handleStopSolve = () => {
    activeSessionsRef.current.forEach((s) => s.cancel());
    setRunningSolve(false);
    toast('已中止当前并行求解');
  };

  // ==================== Stage 3: Confirm Selected Scheme & Deduct Demand ====================

  const handleConfirmSelectedScheme2D = async () => {
    if (!activeScheme2D || confirmingScheme) return;
    if (activeScheme2D.confirmedSchemeId) {
      location.hash = `#/results/${encodeURIComponent(activeScheme2D.confirmedSchemeId)}`;
      return;
    }
    setConfirmingScheme(true);
    try {
      const layout = activeScheme2D.result?.layout;
      const rawMain: any[] = layout?.placements || [];
      const rawGap: any[] = activeScheme2D.result?.marker?.gapFillPlacements || [];
      const hasPoly = activeScheme2D.demands.some((d) => d.shape?.type === 'POLYGON');

      const placementsPayload = [
        ...rawMain.map((p, idx) => ({
          id: idx + 1,
          demandId: p.demandId,
          name: p.name,
          x: p.x,
          y: p.y,
          w: p.shape?.width || 0,
          l: p.shape?.height || 0,
          rotationDegrees: p.rotationDegrees || 0,
          gapFill: false,
          shape: hasPoly ? p.shape : undefined
        })),
        ...rawGap.map((p, idx) => ({
          id: rawMain.length + idx + 1,
          demandId: p.demandId,
          name: p.name,
          x: p.x,
          y: p.y,
          w: p.shape?.width || 0,
          l: p.shape?.height || 0,
          rotationDegrees: p.rotationDegrees || 0,
          gapFill: true,
          shape: hasPoly ? p.shape : undefined
        }))
      ];

      const res = await requestJSON('/api/v2/schemes/confirm', {
        idempotencyKey: `CONFIRM-${activeScheme2D.id}`,
        title: activeScheme2D.title,
        dimension: hasPoly ? 'CONTOUR_2D' : 'RECT_2D',
        scenarioId: activeScheme2D.scenarioId || scenario2D,
        strategyId: activeScheme2D.strategyId || 'AUTO',
        strategyName: activeScheme2D.strategyName,
        taskId: loadedTaskId || undefined,
        taskName: loadedTaskName || `${activeScheme2D.materialModel} · 排料需求族`,
        externalOrderNo: loadedExternalRef || undefined,
        materialMode:
          activeScheme2D.canvasMode === 'FREE_CANVAS'
            ? 'VIRTUAL_ROLL'
            : activeScheme2D.canvasMode,
        rollId: activeScheme2D.rollId,
        remnantId: activeScheme2D.remnantId,
        materialModel: activeScheme2D.materialModel,
        widthMm: activeScheme2D.widthMm,
        canvasLengthMm: activeScheme2D.canvasLengthMm,
        windowStartY: activeScheme2D.windowStartY,
        occupiedLengthMm: activeScheme2D.occupiedLengthMm,
        trimStartMm,
        pieceGapMm,
        utilizationPct: activeScheme2D.utilizationPct,
        pieceAreaM2: activeScheme2D.pieceAreaM2,
        demands: activeDemands2D.map((d) => ({
          id: d.id,
          name: d.name,
          width: d.width,
          length: d.length,
          quantity: Math.max(1, d.orderedQty || d.quantity),
          allowRotation: Boolean(d.allowRotation),
          allowHalfTurn: Boolean(d.allowHalfTurn),
          sizeLabel: d.sizeLabel,
          shape: d.shape
        })),
        layout2D: {
          placements: placementsPayload,
          leftovers: (layout?.leftovers || []).map((rm: any, i: number) => ({
            id: String(rm.id || i + 1),
            x: rm.x,
            y: rm.y,
            w: rm.shape?.width || rm.w || 0,
            l: rm.shape?.height || rm.l || 0,
            hasDefect: Boolean(rm.hasDefect)
          })),
          cuts: (layout?.cuts || []).map((c: any, i: number) => ({
            sequence: c.sequence || i + 1,
            kind: c.kind || 'CONTOUR',
            startX: c.startX,
            startY: c.startY,
            endX: c.endX,
            endY: c.endY
          }))
        }
      });

      const savedScheme = res.scheme;
      const updatedFamily: DemandFamilySummary | undefined = res.demandFamily;
      markSchemeDispatched(activeScheme2D.id, savedScheme.taskId, savedScheme.id);

      await reloadReferenceData(savedScheme.taskId);
      if (updatedFamily) {
        syncDemandFamilyProgress(updatedFamily);
        setLastConfirmSummary({
          schemeId: savedScheme.id,
          openRemaining: updatedFamily.openTotal,
          state: savedScheme.state
        });
      }

      toast(
        savedScheme.state === 'AWAITING_ROLL'
          ? `已确认方案「${savedScheme.id}」并扣减待排需求（虚拟新母卷待备料绑卷）`
          : `已确认方案「${savedScheme.id}」，待排需求已扣减并锁定实卷区段！`
      );
    } catch (err: any) {
      toast('选定方案确认失败：' + err.message, true);
    } finally {
      setConfirmingScheme(false);
    }
  };

  const handleConfirmSelectedScheme1D = async () => {
    if (!activeScheme1D || activeScheme1D.state !== 'SUCCEEDED' || confirmingScheme) return;
    if (activeScheme1D.confirmedSchemeId) {
      location.hash = `#/results/${encodeURIComponent(activeScheme1D.confirmedSchemeId)}`;
      return;
    }
    setConfirmingScheme(true);
    try {
      const res = await requestJSON('/api/v2/schemes/confirm', {
        idempotencyKey: `CONFIRM-1D-${activeScheme1D.id}-${Date.now()}`,
        title: `${activeScheme1D.strategyName} (${activeScheme1D.motherWidthMm}mm · ${activeScheme1D.totalCars}车)`,
        dimension: 'SLITTING_1D',
        scenarioId: scenario1D,
        strategyId: activeScheme1D.strategyId,
        strategyName: activeScheme1D.strategyName,
        taskId: slitLoadedTaskId || undefined,
        taskName: slitLoadedTaskName || `${slitMaterialModel} · 一维分切需求族`,
        materialMode: slitMaterialMode,
        rollId: slitMaterialMode === 'STOCK_ROLL' && currentRoll1D ? currentRoll1D.rollId : undefined,
        materialModel:
          slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
            ? currentRoll1D.rollModel
            : slitMaterialModel || `SLIT-${activeScheme1D.motherWidthMm}`,
        widthMm: activeScheme1D.motherWidthMm,
        canvasLengthMm: activeScheme1D.totalCars * slitFixedLengthMm,
        occupiedLengthMm: activeScheme1D.totalCars * slitFixedLengthMm,
        trimStartMm: 0,
        pieceGapMm: 0,
        utilizationPct: activeScheme1D.avgUtilizationPct,
        pieceAreaM2: Number(
          (
            (activeScheme1D.motherWidthMm *
              activeScheme1D.totalCars *
              slitFixedLengthMm *
              (activeScheme1D.avgUtilizationPct / 100)) /
            1_000_000
          ).toFixed(2)
        ),
        avoidDefects: slitAvoidDefects,
        demands: slitOrders.map((o, idx) => ({
          id: Number(o.id) || idx + 1,
          name: o.name,
          width: o.widthMm,
          length: slitFixedLengthMm,
          quantity: Math.max(1, o.orderedQty || o.quantity),
          allowRotation: false
        })),
        slitting1D: {
          leftTrimMm: activeScheme1D.leftTrimMm,
          rightTrimMm: activeScheme1D.rightTrimMm,
          minWidthMm: slitMinWidthMm,
          maxWidthMm: slitMaxWidthMm,
          widthStepMm: slitWidthStepMm,
          totalOverCap: slitOverCap,
          fixedLengthMm: slitFixedLengthMm,
          totalCars: activeScheme1D.totalCars,
          missingRolls: activeScheme1D.missingRolls,
          overproducedRolls: activeScheme1D.overproducedRolls,
          patterns: activeScheme1D.patterns.map((p) => ({
            id: p.id,
            lengthMm: p.lengthMm,
            repetitions: p.repetitions,
            usedWidthMm: p.usedWidthMm,
            spareWidthMm: p.spareWidthMm,
            stations: p.stations
          })),
          fulfillment: activeScheme1D.fulfillment
        }
      });

      const savedScheme = res.scheme;
      const updatedFamily: DemandFamilySummary | undefined = res.demandFamily;
      markSlitSchemeDispatched(activeScheme1D.id, savedScheme.taskId, savedScheme.id);
      await reloadReferenceData(savedScheme.taskId);
      if (updatedFamily) {
        syncDemandFamilyProgress(updatedFamily);
        setLastConfirmSummary({
          schemeId: savedScheme.id,
          openRemaining: updatedFamily.openTotal,
          state: savedScheme.state
        });
      }
      toast(`已选定分切方案「${savedScheme.id}」并扣减待排需求！`);
    } catch (err: any) {
      toast('选定分切方案失败：' + err.message, true);
    } finally {
      setConfirmingScheme(false);
    }
  };

  const handleQuickExportCam = (kind: 'dxf' | 'nc') => {
    if (!activeScheme2D?.result?.layout) return;
    const layout = activeScheme2D.result.layout;
    const placements = [
      ...(layout.placements || []),
      ...(activeScheme2D.result?.marker?.gapFillPlacements || [])
    ];
    const data = {
      rollId: activeScheme2D.rollId || 'VIRTUAL-NEW-ROLL',
      rollW: activeScheme2D.widthMm,
      bedL: activeScheme2D.occupiedLengthMm,
      windowStartY: activeScheme2D.windowStartY || 0,
      cutOrigin: settings.startCorner,
      pieces: placements.map((p: any) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        w: p.shape.width,
        l: p.shape.height,
        shape: p.shape
      })),
      remnants: layout.leftovers || [],
      defects: [],
      cuts: (layout.cuts || []).map((c: any) => ({
        step: c.sequence,
        type: c.kind === 'HORIZONTAL' ? '横切' : '纵切',
        startX: c.startX,
        startY: c.startY,
        endX: c.endX,
        endY: c.endY
      }))
    };
    const content = kind === 'nc' ? gcodeText(data) : dxfText(data);
    const blob = new Blob([content], {
      type: kind === 'nc' ? 'text/plain;charset=utf-8' : 'application/dxf'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${settings.exportPrefix || 'CutPlan'}-${activeScheme2D.widthMm}x${Math.round(activeScheme2D.occupiedLengthMm)}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleQuickExportExcel1D = async () => {
    if (!activeScheme1D?.patterns.length) return;
    try {
      const XLSX = await loadSheetLib();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['组合编号', '卷长 mm', '分切组合', '已用宽 mm', '余宽 mm', '计划车数'],
          ...activeScheme1D.patterns.map((p, i) => [
            i + 1,
            p.lengthMm,
            p.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
            p.usedWidthMm,
            p.spareWidthMm,
            p.repetitions
          ])
        ]),
        '分切组合方案'
      );
      XLSX.writeFile(
        book,
        `一维分切方案-${activeScheme1D.strategyId}-${activeScheme1D.motherWidthMm}mm.xlsx`
      );
    } catch (e: any) {
      toast('导出 Excel 失败：' + e.message, true);
    }
  };

  const handleQuickDxfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (!text.includes('Piece Name:') || text.includes('\uFFFD')) {
        try {
          text = new TextDecoder('gb18030').decode(buf);
        } catch {}
      }
      const created = importDxfAsCluster(text, file.name);
      setActiveClusterQuickId(created.id);
      loadClusterInto2D(created.id, false);
      toast(`已导入 CAD 纸样模板「${created.name}」并展开至当前画布`);
    } catch (err: any) {
      toast('DXF 导入失败：' + err.message, true);
    } finally {
      e.target.value = '';
    }
  };

  const is2D = activeDimension === '2D';
  const filteredClusters = clusters.filter((c) => c.dimension === activeDimension);
  const quickCluster =
    filteredClusters.find((c) => c.id === activeClusterQuickId) || filteredClusters[0];
  const quickCounts =
    (quickCluster && clusterSelections[quickCluster.id]) ||
    quickCluster?.defaultSizeCounts ||
    {};

  const filteredPoolFamilies = poolFamilies.filter((f) =>
    is2D ? f.dimension !== 'SLITTING_1D' : f.dimension === 'SLITTING_1D'
  );

  const totalPieces2D = activeDemands2D.reduce((s, d) => s + (Number(d.quantity) || 0), 0);
  const totalRolls1D = slitOrders.reduce((s, o) => s + (Number(o.quantity) || 0), 0);

  // Per-item completion progress & live candidate preview ("有几个显示几个 + 小进度条 + 本次具体需求概览")
  const demandRowsView = useMemo(() => {
    if (is2D) {
      const candCounts = new Map<number, number>();
      if (activeScheme2D && !activeScheme2D.confirmedSchemeId) {
        for (const p of activeScheme2D.result?.layout?.placements || []) {
          if (p.demandId != null) {
            candCounts.set(Number(p.demandId), (candCounts.get(Number(p.demandId)) || 0) + 1);
          }
        }
      }
      return activeDemands2D.map((d, idx) => {
        const done = Math.max(0, Number(d.completedQty) || 0);
        const planned = Math.max(0, Number(d.plannedQty) || 0);
        const uncut = Math.max(0, Number(d.quantity) || 0);
        const ordered = Math.max(Number(d.orderedQty) || 0, done + planned + uncut, 1);
        const cand = Math.min(uncut, candCounts.get(d.id) || 0);
        const afterCandUncut = Math.max(0, uncut - cand);
        const isPoly = d.shape?.type === 'POLYGON';
        const areaM2 = ((isPoly ? shapeArea(d.shape) : d.width * d.length) * ordered) / 1_000_000;
        return {
          key: String(d.id),
          rawId: d.id,
          index: idx + 1,
          name: d.name,
          specText: `${fmtN(d.width, 0)} × ${fmtN(d.length, 0)} mm`,
          kindText: isPoly
            ? `异形轮廓${d.allowHalfTurn ? ' · 180°' : ' · 0°'}`
            : `矩形件${d.allowRotation ? ' · 可90°旋' : ' · 固定向'}`,
          ordered,
          done,
          planned,
          uncut,
          cand,
          afterCandUncut,
          areaM2
        };
      });
    }

    const cand1D = new Map<string, number>();
    if (
      activeScheme1D &&
      activeScheme1D.state === 'SUCCEEDED' &&
      !activeScheme1D.confirmedSchemeId
    ) {
      for (const f of activeScheme1D.fulfillment || []) {
        cand1D.set(String(f.orderId), Math.max(0, Number(f.produced) || 0));
      }
    }
    return slitOrders.map((o, idx) => {
      const done = Math.max(0, Number(o.completedQty) || 0);
      const planned = Math.max(0, Number(o.plannedQty) || 0);
      const uncut = Math.max(0, Number(o.quantity) || 0);
      const ordered = Math.max(Number(o.orderedQty) || 0, done + planned + uncut, 1);
      const cand = Math.min(uncut, cand1D.get(String(o.id)) || 0);
      const afterCandUncut = Math.max(0, uncut - cand);
      const areaM2 = (o.widthMm * slitFixedLengthMm * ordered) / 1_000_000;
      return {
        key: String(o.id),
        rawId: o.id,
        index: idx + 1,
        name: o.name,
        specText: `宽 ${fmtN(o.widthMm, 0)} × 长 ${fmtN(slitFixedLengthMm, 0)} mm`,
        kindText: '一维定长分条',
        ordered,
        done,
        planned,
        uncut,
        cand,
        afterCandUncut,
        areaM2
      };
    });
  }, [is2D, activeDemands2D, activeScheme2D, slitOrders, activeScheme1D, slitFixedLengthMm]);

  const overviewStats = useMemo(() => {
    const ordered = demandRowsView.reduce((s, r) => s + r.ordered, 0);
    const done = demandRowsView.reduce((s, r) => s + r.done, 0);
    const planned = demandRowsView.reduce((s, r) => s + r.planned, 0);
    const uncut = demandRowsView.reduce((s, r) => s + r.uncut, 0);
    const cand = demandRowsView.reduce((s, r) => s + r.cand, 0);
    const afterCandUncut = demandRowsView.reduce((s, r) => s + r.afterCandUncut, 0);
    const totalAreaM2 = demandRowsView.reduce((s, r) => s + r.areaM2, 0);
    const uncutSpecCount = demandRowsView.filter((r) => r.uncut > 0).length;
    const settled = done + planned;
    const pct = ordered > 0 ? Math.min(100, Math.round((settled / ordered) * 100)) : 0;
    const pctWithCand =
      ordered > 0 ? Math.min(100, Math.round(((settled + cand) / ordered) * 100)) : 0;
    return {
      itemCount: demandRowsView.length,
      ordered,
      done,
      planned,
      settled,
      uncut,
      cand,
      afterCandUncut,
      uncutSpecCount,
      totalAreaM2,
      pct,
      pctWithCand,
      unit: is2D ? '片' : '卷'
    };
  }, [demandRowsView, is2D]);
  const hasCandidateResult = is2D
    ? Boolean(activeScheme2D)
    : Boolean(activeScheme1D && activeScheme1D.state === 'SUCCEEDED');
  const currentStage: 1 | 2 | 3 = runningSolve ? 2 : hasCandidateResult ? 3 : 1;

  const bestUtil2D = useMemo(
    () => (schemes2D.length ? Math.max(...schemes2D.map((x) => x.utilizationPct)) : 0),
    [schemes2D]
  );
  const baseline1D = useMemo(
    () => slitSchemes.find((s) => s.strategyId === 'BASELINE') || null,
    [slitSchemes]
  );
  const savedCars1D =
    activeScheme1D &&
    baseline1D &&
    activeScheme1D.strategyId !== 'BASELINE' &&
    activeScheme1D.state === 'SUCCEEDED'
      ? Math.max(0, baseline1D.totalCars - activeScheme1D.totalCars)
      : 0;

  // Longitudinal defect schedules for 1D stock roll
  const defectSchedules1D = useMemo(() => {
    if (
      !slitAvoidDefects ||
      slitMaterialMode !== 'STOCK_ROLL' ||
      !currentRoll1D ||
      !activeScheme1D?.patterns?.length
    ) {
      return [];
    }
    const open = slitOrders.map((o) => ({
      id: o.id,
      name: o.name,
      width: o.widthMm,
      length: slitFixedLengthMm,
      demand: o.quantity
    }));
    const list: { carNo: number; startY: number; endY: number; comp: string; avoided: boolean }[] = [];
    let cursor = currentRoll1D.usedLength || 0;
    let carNo = 1;
    for (const pat of activeScheme1D.patterns) {
      for (let r = 0; r < pat.repetitions && carNo <= 24; r++) {
        const assigned = assignCar({ ...pat, lengthMm: slitFixedLengthMm }, open, slitLeftTrimMm);
        const y0 = carStart(currentRoll1D, cursor, slitFixedLengthMm, assigned.strips, []);
        if (y0 == null) break;
        list.push({
          carNo: carNo++,
          startY: y0,
          endY: y0 + slitFixedLengthMm,
          comp: pat.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
          avoided: y0 > cursor + 1
        });
        cursor = y0 + slitFixedLengthMm;
      }
    }
    return list;
  }, [slitAvoidDefects, slitMaterialMode, currentRoll1D, activeScheme1D, slitOrders, slitFixedLengthMm, slitLeftTrimMm]);

  return (
    <div className="react-page studio-2d-page">
      {/* Unified 3-Stage Top Bar: Dimension + Stage Locator + Mother Roll Mode + Primary Solve CTA */}
      <div className="studio-top-bar">
        <h1 className="studio-title">搭切工作台</h1>

        <div className="seg" role="group" aria-label="裁切维度">
          <button
            type="button"
            className={is2D ? 'on' : ''}
            aria-pressed={is2D}
            onClick={() => setActiveDimension('2D')}
          >
            二维排料
          </button>
          <button
            type="button"
            className={!is2D ? 'on' : ''}
            aria-pressed={!is2D}
            onClick={() => setActiveDimension('1D')}
          >
            一维分切
          </button>
        </div>

        {/* Pure-navigation 3-stage stepper (Zero side effects per Industrial Workbench UI rule #6) */}
        <div className="stage-stepper" role="group" aria-label="搭切三阶段定位">
          <button
            type="button"
            className={currentStage === 1 ? 'active' : ''}
            onClick={() => leftPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          >
            <b>1. 搭切前</b> 选需求·定母卷
          </button>
          <span className="stage-arrow" aria-hidden="true">›</span>
          <button
            type="button"
            className={currentStage === 2 ? 'active' : ''}
            onClick={() => rightPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          >
            <b>2. 搭切中</b> 选场景·跑算法
          </button>
          <span className="stage-arrow" aria-hidden="true">›</span>
          <button
            type="button"
            className={currentStage === 3 ? 'active' : ''}
            onClick={() => stripRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          >
            <b>3. 搭切后</b> 比选·扣减需求
          </button>
        </div>

        {/* Mother Roll Selection Mode: Default Virtual New Roll vs Existing Stock Roll / Remnant */}
        {is2D ? (
          <>
            <div className="seg" role="group" aria-label="母卷投料来源">
              <button
                type="button"
                className={canvasMode === 'FREE_CANVAS' ? 'on' : ''}
                aria-pressed={canvasMode === 'FREE_CANVAS'}
                onClick={() => setCanvasSpec({ canvasMode: 'FREE_CANVAS' })}
                title="画布默认创建一个标准门幅新母卷直接排程"
              >
                默认新母卷
              </button>
              <button
                type="button"
                className={canvasMode === 'STOCK_ROLL' ? 'on' : ''}
                aria-pressed={canvasMode === 'STOCK_ROLL'}
                onClick={() => setCanvasSpec({ canvasMode: 'STOCK_ROLL' })}
              >
                现有母卷 ({passedRolls.length})
              </button>
              <button
                type="button"
                className={canvasMode === 'REMNANT' ? 'on' : ''}
                aria-pressed={canvasMode === 'REMNANT'}
                onClick={() => setCanvasSpec({ canvasMode: 'REMNANT' })}
              >
                在库料头 ({availableRemnants.length})
              </button>
            </div>

            {canvasMode === 'FREE_CANVAS' ? (
              <div className="studio-canvas-inputs">
                {scenario2D === 'MULTI_WIDTH' ? (
                  <label>
                    <span>多门幅列表</span>
                    <input
                      className="field num"
                      style={{ width: 155 }}
                      value={multiWidthsText2D}
                      onChange={(e) => setMultiWidthsText2D(e.target.value)}
                      placeholder="1500, 1650, 1800"
                    />
                    <em>mm</em>
                  </label>
                ) : (
                  <>
                    <label>
                      <span>新母卷门幅 W</span>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: 72 }}
                        value={canvasWidthMm}
                        onChange={(e) =>
                          setCanvasSpec({
                            canvasWidthMm: Math.max(300, Number(e.target.value) || 1500)
                          })
                        }
                      />
                      <em>mm</em>
                    </label>
                    <div className="width-quick-pills" role="group" aria-label="常用门幅">
                      {[1220, 1500, 1650, 1800, 2000].map((w) => (
                        <button
                          key={w}
                          type="button"
                          className={canvasWidthMm === w ? 'on' : ''}
                          aria-pressed={canvasWidthMm === w}
                          onClick={() => setCanvasSpec({ canvasWidthMm: w })}
                        >
                          {w}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <label>
                  <span>版长上限 L</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 76 }}
                    value={canvasLengthMm}
                    onChange={(e) =>
                      setCanvasSpec({
                        canvasLengthMm: Math.max(500, Number(e.target.value) || 2000)
                      })
                    }
                  />
                  <em>mm</em>
                </label>
              </div>
            ) : canvasMode === 'STOCK_ROLL' ? (
              <div className="studio-canvas-inputs">
                <label>
                  <span>在库母卷</span>
                  <select
                    className="field"
                    value={currentRoll2D?.rollId || ''}
                    onChange={(e) => {
                      const r = passedRolls.find((x) => x.rollId === e.target.value);
                      setCanvasSpec({
                        selectedRollId: e.target.value,
                        ...(r ? { canvasWidthMm: r.width, materialModel2D: r.rollModel } : {})
                      });
                    }}
                  >
                    {passedRolls.map((r) => (
                      <option key={r.rollId} value={r.rollId}>
                        {r.rollId} · {r.rollModel} (W{r.width} · 余{fmtM(r.currentRemainingLength)}m · 疵{(r.defects || []).length})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>拉布长 L</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 76 }}
                    value={canvasLengthMm}
                    onChange={(e) =>
                      setCanvasSpec({
                        canvasLengthMm: Math.max(500, Number(e.target.value) || 2000)
                      })
                    }
                  />
                  <em>mm</em>
                </label>
              </div>
            ) : (
              <div className="studio-canvas-inputs">
                <label>
                  <span>选用料头</span>
                  <select
                    className="field"
                    value={currentRemnant2D?.id || ''}
                    onChange={(e) => setCanvasSpec({ selectedRemnantId: e.target.value })}
                  >
                    {availableRemnants.map((rm) => (
                      <option key={rm.id} value={rm.id}>
                        {rm.id} · {rm.materialBatch} ({rm.width}×{rm.length}mm)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <details className="craft-disclosure">
              <summary>
                基础工艺 <span className="num">距 {pieceGapMm} · 切头 {trimStartMm}</span>
              </summary>
              <div className="craft-disclosure-panel">
                <label>
                  <span>裁片安全间距 (mm)</span>
                  <input
                    type="number"
                    className="field num"
                    min={0}
                    max={50}
                    value={pieceGapMm}
                    onChange={(e) =>
                      setCanvasSpec({ pieceGapMm: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <label>
                  <span>首端修边切头 (mm)</span>
                  <input
                    type="number"
                    className="field num"
                    min={0}
                    max={200}
                    value={trimStartMm}
                    onChange={(e) =>
                      setCanvasSpec({ trimStartMm: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn sm"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 2 }}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    window.dispatchEvent(
                      new CustomEvent('cutplan:open-settings', { detail: { tab: 'craft' } })
                    );
                  }}
                >
                  更多全局工艺与引擎设置…
                </button>
              </div>
            </details>
          </>
        ) : (
          /* 1D Slitting Mother Roll Mode */
          <>
            <div className="seg" role="group" aria-label="一维母卷来源">
              <button
                type="button"
                className={slitMaterialMode === 'VIRTUAL_ROLL' ? 'on' : ''}
                aria-pressed={slitMaterialMode === 'VIRTUAL_ROLL'}
                onClick={() => setSlitSpec({ slitMaterialMode: 'VIRTUAL_ROLL' })}
              >
                默认新母卷
              </button>
              <button
                type="button"
                className={slitMaterialMode === 'STOCK_ROLL' ? 'on' : ''}
                aria-pressed={slitMaterialMode === 'STOCK_ROLL'}
                onClick={() =>
                  setSlitSpec({
                    slitMaterialMode: 'STOCK_ROLL',
                    slitAvoidDefects: true,
                    ...(currentRoll1D
                      ? { slitRollId: currentRoll1D.rollId, slitMotherWidthMm: currentRoll1D.width }
                      : {})
                  })
                }
              >
                现有母卷 ({passedRolls.length})
              </button>
            </div>

            {slitMaterialMode === 'VIRTUAL_ROLL' ? (
              <div className="studio-canvas-inputs">
                <label>
                  <span>新母卷幅宽</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 76 }}
                    value={slitMotherWidthMm}
                    onChange={(e) => {
                      const w = Math.max(500, Number(e.target.value) || 2000);
                      const usable = Math.max(200, w - slitLeftTrimMm - slitRightTrimMm);
                      setSlitSpec({
                        slitMotherWidthMm: w,
                        slitMaxWidthMm: usable,
                        slitMinWidthMm: Math.floor((usable * 0.9) / 10) * 10
                      });
                    }}
                  />
                  <em>mm</em>
                </label>
                <label>
                  <span>定长卷长</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 76 }}
                    value={slitFixedLengthMm}
                    onChange={(e) => setSlitSpec({ slitFixedLengthMm: Number(e.target.value) })}
                  />
                  <em>mm</em>
                </label>
              </div>
            ) : (
              <div className="studio-canvas-inputs">
                <label>
                  <span>实卷避疵</span>
                  <select
                    className="field"
                    value={currentRoll1D?.rollId || ''}
                    onChange={(e) => {
                      const r = passedRolls.find((x) => x.rollId === e.target.value);
                      setSlitSpec({
                        slitRollId: e.target.value,
                        ...(r
                          ? { slitMotherWidthMm: r.width, slitMaterialModel: r.rollModel }
                          : {})
                      });
                    }}
                  >
                    {passedRolls.map((r) => (
                      <option key={r.rollId} value={r.rollId}>
                        {r.rollId} (W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m · 疵{(r.defects || []).length})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>定长</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 74 }}
                    value={slitFixedLengthMm}
                    onChange={(e) => setSlitSpec({ slitFixedLengthMm: Number(e.target.value) })}
                  />
                  <em>mm</em>
                </label>
              </div>
            )}

            <details className="craft-disclosure">
              <summary>
                切边余量 <span className="num">边 {slitLeftTrimMm}+{slitRightTrimMm} · 超≤{slitOverCap}</span>
              </summary>
              <div className="craft-disclosure-panel">
                <label>
                  <span>左修边 (mm)</span>
                  <input
                    type="number"
                    className="field num"
                    value={slitLeftTrimMm}
                    onChange={(e) => setSlitSpec({ slitLeftTrimMm: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>右修边 (mm)</span>
                  <input
                    type="number"
                    className="field num"
                    value={slitRightTrimMm}
                    onChange={(e) => setSlitSpec({ slitRightTrimMm: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>超产上限 (卷)</span>
                  <input
                    type="number"
                    className="field num"
                    value={slitOverCap}
                    onChange={(e) => setSlitSpec({ slitOverCap: Number(e.target.value) })}
                  />
                </label>
              </div>
            </details>
          </>
        )}

        <span className="sp" />

        <button
          type="button"
          className="btn sm"
          onClick={() => {
            setOverviewTab('progress');
            setOverviewModalOpen(true);
          }}
        >
          本次具体需求概览 ({overviewStats.settled}/{overviewStats.ordered}
          {overviewStats.uncut > 0 ? ` · 待切 ${overviewStats.uncut}` : ' · 已排齐'})
        </button>
      </div>

      {/* Main 3-Column Studio Workspace */}
      <div className="studio-split">
        {/* ==================== LEFT COLUMN: STAGE 1 (搭切前 · 选取需求族与模板拼单) ==================== */}
        <section ref={leftPaneRef} className="pane studio-left">
          <div className="pane-h">
            <span>1. 搭切前 · 排程需求</span>
            <span className="sp" />
            {is2D && (
              <label className="link-btn" title="解析 CAD DXF 纸样">
                导入 DXF
                <input type="file" accept=".dxf" hidden onChange={handleQuickDxfUpload} />
              </label>
            )}
            <a href="#/demands" className="link-btn">
              需求池
            </a>
          </div>

          <div className="pane-b">
            {/* Source Switcher: Demand Pool Family vs Demand Template */}
            <div className="cluster-quick-box">
              <div className="seg" style={{ width: '100%', marginBottom: 8 }}>
                <button
                  type="button"
                  style={{ flex: 1 }}
                  className={demandSourceTab === 'POOL' ? 'on' : ''}
                  onClick={() => setDemandSourceTab('POOL')}
                >
                  选取需求族 ({filteredPoolFamilies.length})
                </button>
                <button
                  type="button"
                  style={{ flex: 1 }}
                  className={demandSourceTab === 'TEMPLATE' ? 'on' : ''}
                  onClick={() => setDemandSourceTab('TEMPLATE')}
                >
                  需求模板拼凑 ({filteredClusters.length})
                </button>
              </div>

              {demandSourceTab === 'POOL' ? (
                filteredPoolFamilies.length > 0 ? (
                  <div>
                    <select
                      className="field"
                      style={{ width: '100%', marginBottom: 6 }}
                      value={(is2D ? loadedTaskId : slitLoadedTaskId) || ''}
                      onChange={(e) => {
                        const fam = filteredPoolFamilies.find((f) => f.id === e.target.value);
                        if (fam) {
                          loadDemandFamilyIntoWorkbench(fam);
                          setLastConfirmSummary(null);
                          toast(`已载入需求族「${fam.name}」（待排余量 ${fam.openTotal}）`);
                        }
                      }}
                    >
                      <option value="">选择待排需求族…</option>
                      {filteredPoolFamilies.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name} · 待排 {f.openTotal}/{f.orderedTotal} ({f.materialModel})
                        </option>
                      ))}
                    </select>
                    {(is2D ? loadedTaskName : slitLoadedTaskName) && (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        当前已关联需求族：<b>{is2D ? loadedTaskName : slitLoadedTaskName}</b>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    当前维度暂无已建档需求族，可前往{' '}
                    <a href="#/demands" style={{ color: 'var(--accent)' }}>
                      需求管理
                    </a>{' '}
                    导入或直接切至右侧「需求模板拼凑」。
                  </div>
                )
              ) : (
                quickCluster && (
                  <>
                    <div className="cluster-quick-row">
                      <select
                        className="field"
                        style={{ flex: 1 }}
                        value={quickCluster.id}
                        onChange={(e) => setActiveClusterQuickId(e.target.value)}
                      >
                        {filteredClusters.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="cluster-quick-sizes">
                      {quickCluster.availableSizes.map((sz) => (
                        <label key={sz} className={(quickCounts[sz] || 0) > 0 ? 'on' : ''}>
                          <span>{sz}</span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={quickCounts[sz] ?? 0}
                            onChange={(e) =>
                              setClusterCount(quickCluster.id, sz, Number(e.target.value))
                            }
                          />
                        </label>
                      ))}
                    </div>
                    <div className="cluster-quick-btns">
                      <button
                        type="button"
                        className="btn sm pri"
                        style={{ flex: 1 }}
                        onClick={() => {
                          setLastConfirmSummary(null);
                          if (is2D) loadClusterInto2D(quickCluster.id, false);
                          else loadClusterInto1D(quickCluster.id, false);
                          toast(`已载入模板「${quickCluster.name}」`);
                        }}
                      >
                        覆盖载入
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          if (is2D) loadClusterInto2D(quickCluster.id, true);
                          else loadClusterInto1D(quickCluster.id, true);
                          toast(`已将「${quickCluster.name}」追加合排`);
                        }}
                      >
                        ＋ 追加合排
                      </button>
                    </div>
                  </>
                )
              )}
            </div>

            {/* 1A. Compact Demand Overview Card -> Opens Concrete Demand Overview Sheet */}
            <div className="wb-overview-card num">
              <div className="wb-overview-head">
                <div>
                  <strong>本次需求切制进度</strong>
                  <small className="muted" style={{ marginLeft: 6 }}>
                    共 {overviewStats.itemCount} 项
                  </small>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setOverviewTab('progress');
                    setOverviewModalOpen(true);
                  }}
                >
                  具体需求概览
                </button>
              </div>

              <div className="wb-overview-nums">
                <span>
                  总需求 <b>{overviewStats.ordered}</b>
                </span>
                <span style={{ color: '#059669' }}>
                  已实切 <b>{overviewStats.done}</b>
                </span>
                <span style={{ color: '#0284c7' }}>
                  已排锁 <b>{overviewStats.planned}</b>
                </span>
                <span
                  style={{
                    color: overviewStats.uncut > 0 ? '#b45309' : 'var(--ok)',
                    fontWeight: 700
                  }}
                >
                  {overviewStats.uncut > 0
                    ? `未切余 ${overviewStats.uncut}${overviewStats.unit}`
                    : '全部已排'}
                </span>
              </div>

              {overviewStats.cand > 0 && (
                <div className="wb-overview-cand">
                  当前画布候选拟切 <b>+{overviewStats.cand}</b> {overviewStats.unit} · 选定后还剩{' '}
                  <b>{overviewStats.afterCandUncut}</b> {overviewStats.unit}未切
                </div>
              )}

              <div className="wb-mini-prog lg" aria-label={`总体完成率 ${overviewStats.pct}%`}>
                <i
                  className="seg-done"
                  style={{
                    width: `${
                      overviewStats.ordered > 0
                        ? Math.min(100, (overviewStats.done / overviewStats.ordered) * 100)
                        : 0
                    }%`
                  }}
                />
                <i
                  className="seg-plan"
                  style={{
                    width: `${
                      overviewStats.ordered > 0
                        ? Math.min(
                            100 - (overviewStats.done / overviewStats.ordered) * 100,
                            (overviewStats.planned / overviewStats.ordered) * 100
                          )
                        : 0
                    }%`
                  }}
                />
                {overviewStats.cand > 0 && (
                  <i
                    className="seg-cand"
                    style={{
                      width: `${
                        overviewStats.ordered > 0
                          ? Math.min(
                              100 - (overviewStats.settled / overviewStats.ordered) * 100,
                              (overviewStats.cand / overviewStats.ordered) * 100
                            )
                          : 0
                      }%`
                    }}
                  />
                )}
              </div>
            </div>

            {/* 1B. Simple Per-Item Completion Progress List ("有几个显示几个，有个小进度条，切完一次知道还有多少没切") */}
            <div
              className="sec"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span>
                需求完成程度 (<b className="num">{demandRowsView.length}</b> 项)
              </span>
              <div style={{ display: 'inline-flex', gap: 4 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setOverviewTab('edit');
                    setOverviewModalOpen(true);
                  }}
                >
                  编辑规格
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    if (is2D) addBlankDemand2D();
                    else addSlitOrder();
                    setOverviewTab('edit');
                    setOverviewModalOpen(true);
                  }}
                >
                  ＋ 新增
                </button>
              </div>
            </div>

            <div className="wb-demand-list" role="list" aria-label="逐项需求完成进度列表">
              {demandRowsView.length === 0 ? (
                <div className="empty" style={{ padding: 18 }}>
                  暂无需求项，请在上方选取需求族或从需求模板导入
                </div>
              ) : (
                demandRowsView.map((row) => {
                  const settledRow = row.done + row.planned;
                  const donePct = Math.min(100, (row.done / row.ordered) * 100);
                  const planPct = Math.min(100 - donePct, (row.planned / row.ordered) * 100);
                  const candPct = Math.min(
                    100 - donePct - planPct,
                    (row.cand / row.ordered) * 100
                  );
                  const isFinished = row.uncut === 0;
                  return (
                    <div
                      key={row.key}
                      role="listitem"
                      className={`wb-demand-prog-row ${isFinished ? 'is-done' : row.cand > 0 ? 'is-cand' : 'is-open'}`}
                    >
                      <div className="wb-demand-row-top">
                        <span className="wb-demand-name" title={row.name}>
                          <em className="num">#{row.index}</em> {row.name}
                        </span>
                        {isFinished ? (
                          <span className="wb-prog-pill done num">
                            已切排 {settledRow}/{row.ordered}
                          </span>
                        ) : row.cand > 0 ? (
                          <span className="wb-prog-pill cand num">
                            本轮+{row.cand} · 余{row.afterCandUncut}
                          </span>
                        ) : (
                          <span className="wb-prog-pill open num">
                            未切 {row.uncut}/{row.ordered}
                          </span>
                        )}
                      </div>

                      <div className="wb-mini-prog" aria-hidden="true">
                        <i className="seg-done" style={{ width: `${donePct}%` }} />
                        <i className="seg-plan" style={{ width: `${planPct}%` }} />
                        {candPct > 0 && <i className="seg-cand" style={{ width: `${candPct}%` }} />}
                      </div>

                      <div className="wb-demand-row-sub num">
                        <span>{row.specText}</span>
                        <span>
                          已排切 {settledRow}/{row.ordered}
                          {row.uncut > 0 ? ` · 待切 ${row.uncut}` : ''}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        {/* ==================== CENTER COLUMN: CAD CANVAS / 1D STRIP VIEW + STAGE 3 COMPARISON ==================== */}
        {is2D ? (
          <section className="pane studio-center" style={{ background: 'var(--canvas)' }}>
            <div className="ctool" role="toolbar" aria-label="画布视图与测量工具">
              <div className="vseg" role="group" aria-label="交互模式">
                <button
                  type="button"
                  aria-pressed={tool === 'pan'}
                  onClick={() => setTool('pan')}
                >
                  平移
                </button>
                <button
                  type="button"
                  aria-pressed={tool === 'measure'}
                  onClick={() => setTool('measure')}
                >
                  测距
                </button>
              </div>
              <span className="div" role="separator" aria-orientation="vertical" />
              <div className="ctool-group" role="group" aria-label="缩放与方向">
                <button type="button" onClick={() => canvasInstanceRef.current?.fit()}>
                  居中适配
                </button>
                <button type="button" onClick={() => canvasInstanceRef.current?.zoom(1 / 1.25)}>
                  −
                </button>
                <button type="button" onClick={() => canvasInstanceRef.current?.zoom(1.25)}>
                  ＋
                </button>
                <button
                  type="button"
                  aria-pressed={!vertical}
                  onClick={() => setVertical((v) => !v)}
                >
                  {vertical ? '竖排视图' : '横排视图'}
                </button>
              </div>
              <span className="div" role="separator" aria-orientation="vertical" />
              <div className="ctool-group" role="group" aria-label="工程图层">
                <button
                  type="button"
                  aria-pressed={showDimensions}
                  onClick={() => setShowDimensions((s) => !s)}
                >
                  尺寸标注
                </button>
                <button
                  type="button"
                  aria-pressed={showPath}
                  onClick={() => setShowPath((s) => !s)}
                >
                  切割刀路
                </button>
              </div>
              <span className="sp" />
              <span className="num ctool-readout">
                {activeScheme2D
                  ? `${activeScheme2D.widthMm} × ${fmtN(activeScheme2D.occupiedLengthMm, 1)} mm · 利用率 ${activeScheme2D.utilizationPct}%`
                  : canvasMode === 'STOCK_ROLL' && currentRoll2D
                  ? `实卷 ${currentRoll2D.rollId} (起点 Y=${fmtN(currentRoll2D.usedLength || 0, 0)}mm · W${currentRoll2D.width})`
                  : canvasMode === 'REMNANT' && currentRemnant2D
                  ? `料头 ${currentRemnant2D.id} (${currentRemnant2D.width}×${currentRemnant2D.length}mm)`
                  : `虚拟新母卷 ${canvasWidthMm} × ${canvasLengthMm} mm`}
                {cursor ? ` · X ${fmtN(cursor.v, 0)} / Y ${fmtN(cursor.u, 0)}` : ''}
              </span>
            </div>

            <div className="canvas-wrap" style={{ flex: 1 }}>
              <CadCanvasView
                scene={currentScene2D}
                vertical={vertical}
                showPath={showPath}
                showDimensions={showDimensions}
                tool={tool}
                onCursorMove={setCursor}
                onContextInspect={(hit) => {
                  const seg = currentScene2D?.segments?.[0];
                  const pc = seg?.pieces?.find((p: any) => p.id === hit?.entityId);
                  setInspectedText(
                    pc
                      ? `裁片「${pc.label}」· X=${fmtN(pc.v, 1)} mm, Y=${fmtN(pc.u, 1)} mm · 外接尺寸 ${fmtN(pc.dv, 1)}×${fmtN(pc.du, 1)} mm`
                      : `母卷坐标 X=${fmtN(hit.v, 1)} mm, Y=${fmtN(hit.u, 1)} mm`
                  );
                }}
                canvasRefOut={canvasInstanceRef}
              />
            </div>

            <div className="studio-canvas-hint">{inspectedText}</div>

            {/* Bottom Stage 3 Comparison Strip */}
            <div ref={stripRef} className="scheme-strip">
              <div className="scheme-strip-head">
                <strong>3. 搭切后 · 候选方案同屏对比 ({schemes2D.length})</strong>
                <small className="muted">点击任意卡片即刻切换上方画布预览，选定最优后在右侧确认扣减需求</small>
                <span className="sp" />
                {schemes2D.length > 0 && (
                  <button type="button" className="btn sm" onClick={clearSchemes2D}>
                    清空候选
                  </button>
                )}
              </div>
              <div className="scheme-slots">
                {schemes2D.length === 0 ? (
                  <div className="scheme-empty">
                    画布已就绪（当前：{canvasMode === 'FREE_CANVAS' ? `默认新母卷 ${canvasWidthMm}mm` : canvasMode === 'STOCK_ROLL' ? `在库母卷 ${currentRoll2D?.rollId || ''}` : `在库料头 ${currentRemnant2D?.id || ''}`}）— 点击右下角「启动并行搭切」同屏对比多引擎结果
                  </div>
                ) : (
                  schemes2D.map((s, idx) => {
                    const isBest = s.utilizationPct === bestUtil2D;
                    const isSelected = activeScheme2D?.id === s.id;
                    return (
                      <div
                        key={s.id}
                        className={`scheme-slot ${isSelected ? 'on' : ''}`}
                        onClick={() => setActiveScheme2D(s.id)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="scheme-slot-top">
                          <strong>
                            #{schemes2D.length - idx} {s.strategyName}
                          </strong>
                          {isBest && <span className="tag ok">最优利用率</span>}
                          {s.confirmedSchemeId && <span className="tag run">已选定落库</span>}
                          <button
                            type="button"
                            className="scheme-del"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeScheme2D(s.id);
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <div className="scheme-slot-metrics num">
                          <span>
                            利用率 <b>{s.utilizationPct}%</b>
                          </span>
                          <span>
                            门幅×实长 <b>{s.widthMm}×{s.occupiedLengthMm}</b>
                          </span>
                          <span>
                            排入 <b>{s.placedCount}/{s.requestedCount}</b>
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        ) : (
          /* 1D Slitting Center View */
          <section ref={stripRef as any} className="pane" style={{ background: 'var(--bg)' }}>
            <div className="body">
              {slitSchemes.length === 0 ? (
                <div className="box" style={{ padding: 36, textAlign: 'center' }}>
                  <strong style={{ fontSize: 16 }}>一维定长分切 · 多订单条宽搭切工作台</strong>
                  <p className="muted" style={{ maxWidth: 500, margin: '10px auto 18px' }}>
                    当前母卷：{slitMaterialMode === 'VIRTUAL_ROLL' ? `默认新母卷 ${slitMotherWidthMm} mm` : `实卷 ${currentRoll1D?.rollId || ''} (${currentRoll1D?.width || slitMotherWidthMm} mm)`}，定长{' '}
                    <b className="num">{slitFixedLengthMm} mm</b>，待排 <b className="num">{slitOrders.length}</b> 项共{' '}
                    <b className="num">{totalRolls1D}</b> 卷。点击下方启动 OR-Tools 与人工基线并发比选。
                  </p>
                  <button type="button" className="btn pri" onClick={handleRunSolve1D}>
                    立即计算分切搭切方案
                  </button>
                </div>
              ) : (
                <>
                  {savedCars1D > 0 && (
                    <div className="roi-banner num">
                      <span className="tag ok">搭切省车收益</span>
                      <span>
                        当前选定组合较传统单规格独立分切减少 <b>{savedCars1D} 车</b> 上机换刀排刀
                      </span>
                    </div>
                  )}

                  <div className="cards" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                    {slitSchemes.map((s) => (
                      <div
                        key={s.id}
                        className={`card slit-scheme-card ${activeScheme1D?.id === s.id ? 'on' : ''}`}
                        onClick={() => setActiveSlitScheme(s.id)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <small style={{ flex: 1, fontWeight: 600, color: 'var(--text)' }}>
                            {s.strategyName}
                          </small>
                          <span
                            className={`tag ${
                              s.state === 'SUCCEEDED' ? 'ok' : s.state === 'RUNNING' ? 'run' : 'err'
                            }`}
                          >
                            {s.state === 'SUCCEEDED' ? `${s.elapsedMs}ms` : s.state}
                          </span>
                        </div>
                        <b className="num">{s.state === 'RUNNING' ? '…' : `${s.totalCars} 车`}</b>
                        <div className="d num">
                          利用率 {s.avgUtilizationPct}% · 缺口 {s.missingRolls} · 超产 {s.overproducedRolls}
                        </div>
                      </div>
                    ))}
                  </div>

                  {activeScheme1D && activeScheme1D.state === 'SUCCEEDED' && (
                    <div className="box" style={{ margin: '12px 0 0' }}>
                      <div className="pane-h">
                        <span>
                          刀组排布示意图（共 {activeScheme1D.patterns.length} 组 · 合计 {activeScheme1D.totalCars} 车）
                        </span>
                        <span className="sp" />
                        <button type="button" className="btn sm" onClick={handleQuickExportExcel1D}>
                          导出分切 Excel
                        </button>
                      </div>
                      <div className="slit-patterns-list">
                        {activeScheme1D.patterns.map((p, idx) => (
                          <div key={p.id} className="slit-pattern-row">
                            <div className="slit-pattern-meta">
                              <span className="tag kind">组 {idx + 1}</span>
                              <b className="num">{p.repetitions} 车</b>
                              <span className="num">
                                组合：{p.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + ')}
                              </span>
                              <span className="sp" />
                              <span className="num muted">
                                已切 {p.usedWidthMm} mm · 余宽 {p.spareWidthMm} mm
                              </span>
                            </div>
                            <SlittingStripBar
                              motherWidthMm={activeScheme1D.motherWidthMm}
                              leftTrimMm={activeScheme1D.leftTrimMm}
                              rightTrimMm={activeScheme1D.rightTrimMm}
                              stations={p.stations}
                            />
                          </div>
                        ))}
                      </div>

                      {defectSchedules1D.length > 0 && (
                        <div style={{ padding: '0 12px 12px' }}>
                          <div className="sec">实卷纵向疵点避让车次排程 ({currentRoll1D?.rollId})</div>
                          <table className="t" style={{ marginTop: 6 }}>
                            <thead>
                              <tr>
                                <th>车次</th>
                                <th className="r">母卷区间 mm</th>
                                <th>排刀组合</th>
                                <th>避疵状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {defectSchedules1D.map((row) => (
                                <tr key={row.carNo}>
                                  <td className="num">#{row.carNo}</td>
                                  <td className="r num">
                                    {fmtN(row.startY)} ~ {fmtN(row.endY)}
                                  </td>
                                  <td className="num">{row.comp}</td>
                                  <td>
                                    {row.avoided ? (
                                      <span className="tag warn">跳段避开疵点</span>
                                    ) : (
                                      <span className="tag ok">连续净区</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {/* ==================== RIGHT COLUMN: STAGE 2 (场景与算法) + STAGE 3 (选定方案与需求扣减) ==================== */}
        <section ref={rightPaneRef} className="pane studio-right">
          <div className="pane-h">
            <span>2/3. 求解场景 · 方案选定与扣减</span>
          </div>
          <div className="pane-b">
            {/* Post-Confirm Continuation Banner */}
            {lastConfirmSummary && (
              <div
                className="roi-banner"
                style={{
                  margin: '10px 10px 0',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6
                }}
              >
                <div>
                  <span className="tag ok" style={{ marginRight: 6 }}>
                    方案已落库
                  </span>
                  <b className="num">{lastConfirmSummary.schemeId}</b> 已扣减待排需求！
                </div>
                <div style={{ fontSize: 12 }}>
                  {lastConfirmSummary.openRemaining > 0
                    ? `当前需求族还剩 ${lastConfirmSummary.openRemaining} 件/卷待排（左侧已自动刷新为剩余量），可直接继续排下一卷！`
                    : '当前需求族待排量已全部排完！可前往结果管理导出 DXF/G-Code/工单或下发 MES。'}
                </div>
                <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                  <a
                    className="btn sm pri"
                    style={{ flex: 1, textAlign: 'center' }}
                    href={`#/results/${encodeURIComponent(lastConfirmSummary.schemeId)}`}
                  >
                    去结果管理查看/导出
                  </a>
                  {lastConfirmSummary.openRemaining > 0 && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setLastConfirmSummary(null);
                        if (is2D) clearSchemes2D();
                        else setSlitSchemes([]);
                      }}
                    >
                      继续排剩余量
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Stage 3 Active Candidate Decision Card */}
            {is2D && activeScheme2D ? (
              <div className="value-hero-panel">
                <div className="value-hero-head">
                  <div>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      3. 搭切后 · 当前审阅方案
                    </span>
                    <div className="value-hero-title">{activeScheme2D.strategyName}</div>
                  </div>
                  <span className={`tag ${activeScheme2D.complete ? 'ok' : 'warn'}`}>
                    {activeScheme2D.complete ? '齐套达标' : '部分排入'}
                  </span>
                </div>

                <div className="value-kpi-grid num">
                  <div className="value-kpi-cell highlight">
                    <small>综合材料利用率</small>
                    <b>
                      {activeScheme2D.utilizationPct}
                      <em>%</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>实占母卷长度</small>
                    <b>
                      {fmtN(activeScheme2D.occupiedLengthMm, 1)}
                      <em>mm</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>排入件数</small>
                    <b>
                      {activeScheme2D.placedCount}
                      <em>/ {activeScheme2D.requestedCount}</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>母卷模式</small>
                    <b style={{ fontSize: 13 }}>
                      {activeScheme2D.canvasMode === 'FREE_CANVAS'
                        ? `新母卷 W${activeScheme2D.widthMm}`
                        : activeScheme2D.rollId || activeScheme2D.remnantId}
                    </b>
                  </div>
                </div>

                <div className="value-actions">
                  <button
                    type="button"
                    className="btn pri value-primary-cta"
                    disabled={confirmingScheme}
                    onClick={handleConfirmSelectedScheme2D}
                  >
                    {confirmingScheme
                      ? '正在保存方案并扣减待排量…'
                      : activeScheme2D.confirmedSchemeId
                      ? `已选定 (${activeScheme2D.confirmedSchemeId}) · 查看结果`
                      : '选定此方案（扣减需求并保存结果）'}
                  </button>
                  <div className="value-export-row">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => handleQuickExportCam('dxf')}
                    >
                      导出 CAD DXF
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => handleQuickExportCam('nc')}
                    >
                      导出 CNC G-Code
                    </button>
                  </div>
                </div>
              </div>
            ) : !is2D && activeScheme1D && activeScheme1D.state === 'SUCCEEDED' ? (
              <div className="value-hero-panel">
                <div className="value-hero-head">
                  <div>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      3. 搭切后 · 当前分切方案
                    </span>
                    <div className="value-hero-title">{activeScheme1D.strategyName}</div>
                  </div>
                  <span className="tag ok">已验证</span>
                </div>

                <div className="value-kpi-grid num">
                  <div className="value-kpi-cell highlight">
                    <small>母卷面积利用率</small>
                    <b>
                      {activeScheme1D.avgUtilizationPct}
                      <em>%</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>合计排产车数</small>
                    <b>
                      {activeScheme1D.totalCars}
                      <em>车</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>缺口 / 超产</small>
                    <b>
                      {activeScheme1D.missingRolls} / {activeScheme1D.overproducedRolls}
                      <em>卷</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>母卷模式</small>
                    <b style={{ fontSize: 13 }}>
                      {slitMaterialMode === 'VIRTUAL_ROLL'
                        ? `新母卷 W${activeScheme1D.motherWidthMm}`
                        : currentRoll1D?.rollId || '实卷'}
                    </b>
                  </div>
                </div>

                <div className="value-actions">
                  <button
                    type="button"
                    className="btn pri value-primary-cta"
                    disabled={confirmingScheme}
                    onClick={handleConfirmSelectedScheme1D}
                  >
                    {confirmingScheme
                      ? '正在保存方案并扣减需求…'
                      : activeScheme1D.confirmedSchemeId
                      ? `已选定 (${activeScheme1D.confirmedSchemeId}) · 查看结果`
                      : '选定此方案（扣减需求并保存结果）'}
                  </button>
                </div>
              </div>
            ) : null}

            {/* Stage 2: Solving Scenario Selector */}
            <details className="studio-accordion" open>
              <summary>
                <span>2. 搭切中 · 选取求解场景</span>
                <span className="tag kind" style={{ marginLeft: 'auto' }}>
                  {is2D
                    ? SCENARIOS_2D.find((s) => s.id === scenario2D)?.label
                    : scenario1D === 'MIN_CARS'
                    ? '最少换刀车数'
                    : '最高幅宽利用率'}
                </span>
              </summary>
              <div className="choice-card-list">
                {is2D ? (
                  SCENARIOS_2D.map((sc) => {
                    const disabled = sc.id === 'MULTI_WIDTH' && canvasMode !== 'FREE_CANVAS';
                    return (
                      <label
                        key={sc.id}
                        className="choice-card"
                        style={disabled ? { opacity: 0.55 } : undefined}
                      >
                        <input
                          type="radio"
                          name="scenario2d"
                          disabled={disabled}
                          checked={scenario2D === sc.id}
                          onChange={() => setScenario2D(sc.id)}
                        />
                        <div className="choice-card-body">
                          <div className="choice-card-head">
                            <strong>{sc.label}</strong>
                          </div>
                          <div className="choice-card-sub">{sc.desc}</div>
                        </div>
                      </label>
                    );
                  })
                ) : (
                  <>
                    <label className="choice-card">
                      <input
                        type="radio"
                        name="scenario1d"
                        checked={scenario1D === 'MIN_CARS'}
                        onChange={() => setScenario1D('MIN_CARS')}
                      />
                      <div className="choice-card-body">
                        <div className="choice-card-head">
                          <strong>最少出车/换刀搭切</strong>
                        </div>
                        <div className="choice-card-sub">严格控制超产上限，减少车间上机换刀次数</div>
                      </div>
                    </label>
                    <label className="choice-card">
                      <input
                        type="radio"
                        name="scenario1d"
                        checked={scenario1D === 'MAX_UTIL'}
                        onChange={() => setScenario1D('MAX_UTIL')}
                      />
                      <div className="choice-card-body">
                        <div className="choice-card-head">
                          <strong>最高母卷利用率（容许备库超产）</strong>
                        </div>
                        <div className="choice-card-sub">适度放宽常备规格超产额度以消灭窄边废料</div>
                      </div>
                    </label>
                  </>
                )}
              </div>
            </details>

            {/* Stage 2: Parallel Algorithm Engines */}
            {is2D && (
              <details className="studio-accordion" open={!activeScheme2D || runningSolve}>
                <summary>
                  <span>并行求解算法引擎</span>
                  <span className="tag num" style={{ marginLeft: 'auto' }}>
                    已选 {selectedStrategies2D.length} / {STRATEGIES_2D.length}
                  </span>
                </summary>
                <div className="choice-card-list">
                  {STRATEGIES_2D.map((stDef) => {
                    const checked = selectedStrategies2D.includes(stDef.id);
                    const runInfo = strategyRuns2D.find((r) => r.strategyId.startsWith(stDef.id));
                    return (
                      <label
                        key={stDef.id}
                        className={`choice-card ${runInfo?.state === 'RUNNING' ? 'is-running' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleStrategy2D(stDef.id)}
                        />
                        <div className="choice-card-body">
                          <div className="choice-card-head">
                            <strong>{stDef.name}</strong>
                            <span className="tag">{stDef.badge}</span>
                          </div>
                          <div className="choice-card-sub">{stDef.shortTag}</div>
                          {runInfo && (
                            <div className="choice-card-status num">
                              <span
                                className={`tag ${
                                  runInfo.state === 'SUCCEEDED' || runInfo.state === 'TIMED_OUT'
                                    ? 'ok'
                                    : runInfo.state === 'RUNNING' || runInfo.state === 'QUEUED'
                                    ? 'run'
                                    : 'err'
                                }`}
                              >
                                {runInfo.state === 'SUCCEEDED'
                                  ? '完成'
                                  : runInfo.state === 'RUNNING'
                                  ? '计算中'
                                  : runInfo.state === 'QUEUED'
                                  ? '排队'
                                  : runInfo.state}
                              </span>
                              <span className="choice-card-phase">{runInfo.phaseText}</span>
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </details>
            )}
          </div>

          {/* Sticky Bottom-Right Primary Solve Action Bar */}
          <div className="studio-right-foot">
            <div className="studio-right-foot-meta num">
              {is2D ? (
                <span>
                  待排余量{' '}
                  <b>
                    {overviewStats.uncut > 0 ? overviewStats.uncut : overviewStats.ordered}{' '}
                    {overviewStats.unit}
                  </b>
                  {overviewStats.uncut === 0 && overviewStats.ordered > 0 ? ' (全单重排试算)' : ''} ·{' '}
                  {canvasMode === 'FREE_CANVAS'
                    ? `新母卷 W${canvasWidthMm}mm`
                    : canvasMode === 'STOCK_ROLL'
                    ? `实卷 ${currentRoll2D?.rollId || ''}`
                    : `料头 ${currentRemnant2D?.id || ''}`}
                </span>
              ) : (
                <span>
                  待排余量{' '}
                  <b>
                    {overviewStats.uncut > 0 ? overviewStats.uncut : overviewStats.ordered}{' '}
                    {overviewStats.unit}
                  </b>{' '}
                  · 母卷 W
                  {slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
                    ? currentRoll1D.width
                    : slitMotherWidthMm}
                  mm
                </span>
              )}
            </div>
            <div className="studio-right-foot-btns">
              {runningSolve && (
                <button type="button" className="btn" onClick={handleStopSolve}>
                  ■ 停止计算
                </button>
              )}
              <button
                type="button"
                className="btn pri studio-solve-btn"
                style={{ flex: 1 }}
                disabled={runningSolve}
                onClick={is2D ? handleRunSolve2D : handleRunSolve1D}
              >
                {runningSolve
                  ? '多引擎竞速求解中…'
                  : is2D
                  ? `启动并行搭切 (${selectedStrategies2D.length} 算法)`
                  : '启动分切搭切 (3 策略)'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Concrete Demand Overview & Spec Editor Modal ("本次具体需求概览") */}
      <ModalDialog
        open={overviewModalOpen}
        title={`本次具体需求概览 · ${
          (is2D ? loadedTaskName : slitLoadedTaskName) || '当前画布排程批次'
        }`}
        onClose={() => setOverviewModalOpen(false)}
        maxWidth={960}
      >
        <div className="wb-overview-modal">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginBottom: 12
            }}
          >
            <div className="seg" role="group" aria-label="概览与编辑切换">
              <button
                type="button"
                className={overviewTab === 'progress' ? 'on' : ''}
                onClick={() => setOverviewTab('progress')}
              >
                切制情况与批次总览
              </button>
              <button
                type="button"
                className={overviewTab === 'edit' ? 'on' : ''}
                onClick={() => setOverviewTab('edit')}
              >
                编辑需求规格明细 ({demandRowsView.length})
              </button>
            </div>
            <div className="muted num" style={{ fontSize: 12 }}>
              物料品号：<b>{is2D ? materialModel2D : slitMaterialModel}</b> · 净需求总面积：{' '}
              <b>{fmtN(overviewStats.totalAreaM2, 2)} m²</b>
            </div>
          </div>

          {overviewTab === 'progress' ? (
            <>
              {/* 5-Column Cutting Status KPI Strip */}
              <div className="wb-overview-kpis num">
                <div className="wb-ov-kpi">
                  <small>需求总量 ({overviewStats.itemCount} 项)</small>
                  <b>
                    {overviewStats.ordered} <em>{overviewStats.unit}</em>
                  </b>
                </div>
                <div className="wb-ov-kpi ok">
                  <small>已实切合格</small>
                  <b>
                    {overviewStats.done} <em>{overviewStats.unit}</em>
                  </b>
                </div>
                <div className="wb-ov-kpi plan">
                  <small>已锁方案待切</small>
                  <b>
                    {overviewStats.planned} <em>{overviewStats.unit}</em>
                  </b>
                </div>
                <div className="wb-ov-kpi cand">
                  <small>当前候选拟切</small>
                  <b>
                    +{overviewStats.cand} <em>{overviewStats.unit}</em>
                  </b>
                </div>
                <div className={`wb-ov-kpi ${overviewStats.uncut > 0 ? 'warn' : 'ok'}`}>
                  <small>剩余未切缺口</small>
                  <b>
                    {overviewStats.uncut}{' '}
                    <em>
                      {overviewStats.unit}
                      {overviewStats.cand > 0 ? ` (选定后余 ${overviewStats.afterCandUncut})` : ''}
                    </em>
                  </b>
                </div>
              </div>

              {/* Confirmed Cut Batches History (if any schemes already saved against this family) */}
              {taskSchemes.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="sec" style={{ margin: '0 0 6px' }}>
                    已选定排程切次记录（共 {taskSchemes.length} 次方案）
                  </div>
                  <table className="t">
                    <thead>
                      <tr>
                        <th>排程方案号</th>
                        <th>采用算法与规格</th>
                        <th>绑定母卷 / 模式</th>
                        <th className="r">排入数量</th>
                        <th className="r">利用率</th>
                        <th>执行状态</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {taskSchemes.map((entry: any) => {
                        const s = entry.scheme;
                        return (
                          <tr key={s.id}>
                            <td className="num" style={{ fontWeight: 600 }}>
                              {s.id}
                            </td>
                            <td>{s.title}</td>
                            <td className="num">
                              {s.rollId || s.remnantId || `虚拟新母卷 W${s.widthMm}`}
                            </td>
                            <td className="r num">{s.placedCount}</td>
                            <td className="r num">{s.utilizationPct}%</td>
                            <td>
                              <span
                                className={`tag ${
                                  s.state === 'COMPLETED'
                                    ? 'ok'
                                    : s.state === 'CANCELLED'
                                    ? ''
                                    : 'run'
                                }`}
                              >
                                {s.state === 'COMPLETED'
                                  ? '已完工记账'
                                  : s.state === 'READY_TO_CUT'
                                  ? '已锁实卷待切'
                                  : s.state === 'AWAITING_ROLL'
                                  ? '待绑实卷'
                                  : s.state === 'DISPATCHED_MES'
                                  ? '已下发 MES'
                                  : '已作废'}
                              </span>
                            </td>
                            <td>
                              <a
                                className="btn sm"
                                href={`#/results/${encodeURIComponent(s.id)}`}
                                onClick={() => setOverviewModalOpen(false)}
                              >
                                查看结果
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Detailed Per-Item Cutting Status Breakdown Table */}
              <div className="sec" style={{ margin: '0 0 6px' }}>
                逐项具体需求切制明细（共 {demandRowsView.length} 种规格）
              </div>
              <div style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>需求部件 / 订单行名称</th>
                      <th>规格尺寸</th>
                      <th>工艺/丝缕</th>
                      <th className="r">总需求</th>
                      <th className="r">已实切</th>
                      <th className="r">已排锁</th>
                      <th className="r">本轮拟切</th>
                      <th className="r">剩余未切</th>
                      <th style={{ minWidth: 150 }}>完成进度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demandRowsView.map((r) => {
                      const donePct = Math.min(100, (r.done / r.ordered) * 100);
                      const planPct = Math.min(100 - donePct, (r.planned / r.ordered) * 100);
                      const candPct = Math.min(
                        100 - donePct - planPct,
                        (r.cand / r.ordered) * 100
                      );
                      const settledPct = Math.min(
                        100,
                        Math.round(((r.done + r.planned) / r.ordered) * 100)
                      );
                      return (
                        <tr key={r.key}>
                          <td className="num muted">{r.index}</td>
                          <td style={{ fontWeight: 600 }}>{r.name}</td>
                          <td className="num">{r.specText}</td>
                          <td>
                            <span className="muted" style={{ fontSize: 11.5 }}>
                              {r.kindText}
                            </span>
                          </td>
                          <td className="r num">{r.ordered}</td>
                          <td className="r num" style={{ color: '#059669', fontWeight: 600 }}>
                            {r.done}
                          </td>
                          <td className="r num" style={{ color: '#0284c7', fontWeight: 600 }}>
                            {r.planned}
                          </td>
                          <td className="r num" style={{ color: '#0369a1' }}>
                            {r.cand > 0 ? `+${r.cand}` : '—'}
                          </td>
                          <td
                            className="r num"
                            style={{
                              color: r.uncut > 0 ? '#b45309' : 'var(--ok)',
                              fontWeight: 700
                            }}
                          >
                            {r.uncut > 0 ? r.uncut : '0'}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div className="wb-mini-prog" style={{ flex: 1 }}>
                                <i className="seg-done" style={{ width: `${donePct}%` }} />
                                <i className="seg-plan" style={{ width: `${planPct}%` }} />
                                {candPct > 0 && (
                                  <i className="seg-cand" style={{ width: `${candPct}%` }} />
                                )}
                              </div>
                              <span className="num muted" style={{ fontSize: 11, width: 34 }}>
                                {settledPct}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            /* Tab 2: Spacious Demand Spec Editor */
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8
                }}
              >
                <span className="muted" style={{ fontSize: 12 }}>
                  调整待切余量、规格尺寸或新增自定义部件（异形轮廓尺寸由 CAD 顶点锁定）
                </span>
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={() => (is2D ? addBlankDemand2D() : addSlitOrder())}
                >
                  {is2D ? '＋ 新增二维裁片规格' : '＋ 新增一维分条规格'}
                </button>
              </div>
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                {is2D ? (
                  <table className="t">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>部件名称</th>
                        <th className="r">宽 mm</th>
                        <th className="r">长 mm</th>
                        <th className="r">待切数量</th>
                        <th>允许 90° 旋转</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {activeDemands2D.map((d, idx) => {
                        const isPoly = d.shape?.type === 'POLYGON';
                        return (
                          <tr key={d.id}>
                            <td className="num muted">{idx + 1}</td>
                            <td>
                              <input
                                className="field"
                                style={{ width: '100%' }}
                                value={d.name}
                                onChange={(e) => updateDemand2D(d.id, { name: e.target.value })}
                              />
                            </td>
                            <td className="r num">
                              {isPoly ? (
                                fmtN(d.width, 1)
                              ) : (
                                <input
                                  type="number"
                                  className="field num"
                                  style={{ width: 90, textAlign: 'right' }}
                                  value={d.width}
                                  onChange={(e) =>
                                    updateDemand2D(d.id, { width: Number(e.target.value) })
                                  }
                                />
                              )}
                            </td>
                            <td className="r num">
                              {isPoly ? (
                                fmtN(d.length, 1)
                              ) : (
                                <input
                                  type="number"
                                  className="field num"
                                  style={{ width: 90, textAlign: 'right' }}
                                  value={d.length}
                                  onChange={(e) =>
                                    updateDemand2D(d.id, { length: Number(e.target.value) })
                                  }
                                />
                              )}
                            </td>
                            <td className="r">
                              <input
                                type="number"
                                min={0}
                                max={5000}
                                className="field num"
                                style={{ width: 84, textAlign: 'right' }}
                                value={d.quantity}
                                onChange={(e) => {
                                  const nextQ = Math.max(0, Number(e.target.value));
                                  const nextOrd = Math.max(
                                    d.orderedQty || 0,
                                    (d.completedQty || 0) + (d.plannedQty || 0) + nextQ
                                  );
                                  updateDemand2D(d.id, { quantity: nextQ, orderedQty: nextOrd });
                                }}
                              />
                            </td>
                            <td>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <input
                                  type="checkbox"
                                  disabled={isPoly}
                                  checked={Boolean(d.allowRotation)}
                                  onChange={(e) =>
                                    updateDemand2D(d.id, { allowRotation: e.target.checked })
                                  }
                                />
                                <span className="muted" style={{ fontSize: 12 }}>
                                  {isPoly ? '由算法策略控制倒顺' : '允许 90°'}
                                </span>
                              </label>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => removeDemand2D(d.id)}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <table className="t">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>订单条宽名称</th>
                        <th className="r">条宽 mm</th>
                        <th className="r">待切卷数</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {slitOrders.map((o, idx) => (
                        <tr key={o.id}>
                          <td className="num muted">{idx + 1}</td>
                          <td>
                            <input
                              className="field"
                              style={{ width: '100%' }}
                              value={o.name}
                              onChange={(e) => updateSlitOrder(o.id, { name: e.target.value })}
                            />
                          </td>
                          <td className="r">
                            <input
                              type="number"
                              className="field num"
                              style={{ width: 100, textAlign: 'right' }}
                              value={o.widthMm}
                              onChange={(e) =>
                                updateSlitOrder(o.id, { widthMm: Number(e.target.value) })
                              }
                            />
                          </td>
                          <td className="r">
                            <input
                              type="number"
                              min={0}
                              className="field num"
                              style={{ width: 90, textAlign: 'right' }}
                              value={o.quantity}
                              onChange={(e) => {
                                const nextQ = Math.max(0, Number(e.target.value));
                                const nextOrd = Math.max(
                                  o.orderedQty || 0,
                                  (o.completedQty || 0) + (o.plannedQty || 0) + nextQ
                                );
                                updateSlitOrder(o.id, { quantity: nextQ, orderedQty: nextOrd });
                              }}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => removeSlitOrder(o.id)}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </ModalDialog>
    </div>
  );
};
