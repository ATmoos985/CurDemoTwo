import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandItem,
  SavedScheme2D,
  SlittingSchemeRun,
  DemandFamilySummary,
  Scenario2DType,
  ShapeGeometry
} from '../store/useStudioStore';
import {
  StudioSettings,
  DEFAULT_STUDIO_SETTINGS,
  SlittingProfile,
  SlittingWidthMode,
  SlittingWidthPreset,
  loadSlittingPresets,
  saveCustomSlittingPresets,
  extractSlittingSolverOptions
} from '../store/studioSettings';
import {
  WorkbenchBoardCanvas,
  WorkbenchBoardHandle,
  BoardDemandSpec,
  BoardPlacedPiece,
  BoardDefect,
  BoardCutLine
} from '../components/WorkbenchBoardCanvas';
import { ModalDialog } from '../components/ModalDialog';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import {
  buildSafeNestingRequest2D,
  unpadGuillotineResult,
  quantize01
} from '@static/js/business/optimization/nesting-request-adapter.js';
import { rectangle, shapeArea } from '@static/js/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '@static/js/plugins/export/cam-format.js';
import { independentBaseline, planSummary } from '@static/js/linear/linear-model.js';
import { carStart, assignCar } from '@static/app/js/model/slitting.js';
import { requestJSON, toast, fmtN, fmtM, loadSheetLib } from '@static/app/js/util.js';
import '../styles/theme-workbench-v2.css';

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
    id: 'PS_FIXED',
    name: 'PackingSolver 严格经向缩长',
    shortTag: '0° 保丝缕 · 二分缩长压紧',
    badge: 'C++ 原生',
    description: '保持全部裁片严格 0° 丝缕方向，多轮二分缩短并压紧唛架长度',
    halfTurn: false,
    forceRotateRect: false,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'PS_ROT',
    name: 'PackingSolver 180°/90° 倒顺缩长',
    shortTag: '异形 180° / 矩形 90° · 最短版长',
    badge: 'C++ 原生',
    description: '异形片允许 180° 倒顺对排、矩形允许 90° 旋转，追求最短版长',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'DN_GA',
    name: 'Deepnest NFP+GA 进化嵌套',
    shortTag: 'Minkowski 临界多边形 + 遗传共边寻优',
    badge: 'NFP+GA',
    description: '使用临界多边形卷积与遗传算法进化搜索凹凸互补与共边奖励',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 8
  },
  {
    id: 'DN_FIXED',
    name: 'Deepnest 严格经向直排',
    shortTag: '0° 严保纱向 · 临界多边形紧贴',
    badge: 'NFP 经向',
    description: '保持 0° 丝缕方向，采用 Deepnest NFP 精确凹凸嵌套直排对照',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 5
  },
  {
    id: 'JAVA_FAST',
    name: 'Java 天际线/直刀快速基线',
    shortTag: '极速秒出基线对照与降级兜底',
    badge: 'Java 内置',
    description: '内置天际线/直刀快速启发式引擎，作多算法对照与极速基线',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'java',
    timeLimit: 5
  }
];

const LEGACY_STRATEGY_ALIAS: Record<string, string> = {
  SHORTEN_FIXED: 'PS_FIXED',
  SHORTEN_HALF_TURN: 'PS_ROT',
  DEEPNEST_NFP_GA: 'DN_GA',
  DEEPNEST_FIXED_GRAIN: 'DN_FIXED',
  JAVA_HEURISTIC: 'JAVA_FAST'
};

const DEFAULT_ENABLED_STRATEGIES = ['PS_FIXED', 'PS_ROT', 'DN_GA', 'JAVA_FAST'];

const SCENARIOS_2D: { id: Scenario2DType; label: string; desc: string }[] = [
  { id: 'SHORTEN_KIT', label: '齐套最短版长', desc: '装入全部待排需求并压紧用料长度' },
  { id: 'SHORTEN_GAP_FILL', label: '齐套 + 空隙补备片', desc: '齐套后在空隙填补小件提升利用率' },
  { id: 'FIXED_BED', label: '定长台板装入', desc: '按版长上限单次装入最大裁片面积' },
  { id: 'MULTI_WIDTH', label: '多门幅阶梯比选', desc: '批量对比多个门幅的单耗与版长' }
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

const DemandShapeThumb: React.FC<{
  width: number;
  length: number;
  shape?: ShapeGeometry;
  done?: boolean;
}> = ({ width, length, shape, done }) => {
  const stroke = done ? '#10b981' : '#5b61f6';
  const fill = done ? 'rgba(16, 185, 129, 0.12)' : 'rgba(91, 97, 246, 0.1)';
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    const sw = Math.max(1, shape.width || width);
    const sh = Math.max(1, shape.height || length);
    const scale = Math.min(16 / sw, 16 / sh);
    const ox = (22 - sw * scale) / 2;
    const oy = (22 - sh * scale) / 2;
    const pts = shape.vertices
      .map((p) => `${(ox + p.x * scale).toFixed(1)},${(oy + p.y * scale).toFixed(1)}`)
      .join(' ');
    return (
      <svg className="wb-row-thumb" viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
        <polygon points={pts} fill={fill} stroke={stroke} strokeWidth="1.25" strokeLinejoin="round" />
      </svg>
    );
  }
  const w = Math.max(1, width);
  const h = Math.max(1, length);
  const scale = Math.min(15 / w, 15 / h);
  const rw = Math.max(4, w * scale);
  const rh = Math.max(4, h * scale);
  const rx = (22 - rw) / 2;
  const ry = (22 - rh) / 2;
  return (
    <svg className="wb-row-thumb" viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
      <rect x={rx} y={ry} width={rw} height={rh} rx={1.5} fill={fill} stroke={stroke} strokeWidth="1.25" />
    </svg>
  );
};

function rotateShapeGeometry(
  shape: ShapeGeometry | undefined,
  w: number,
  h: number,
  stepDeg: 90 | 180
): ShapeGeometry {
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    const sw = shape.width || w;
    const sh = shape.height || h;
    const raw = shape.vertices.map((pt) =>
      stepDeg === 90
        ? { x: sh - pt.y, y: pt.x }
        : { x: sw - pt.x, y: sh - pt.y }
    );
    const minX = Math.min(...raw.map((p) => p.x));
    const minY = Math.min(...raw.map((p) => p.y));
    const normalized = raw.map((p) => ({
      x: Math.max(0, quantize01(p.x - minX)),
      y: Math.max(0, quantize01(p.y - minY))
    }));
    const newW = quantize01(Math.max(...normalized.map((p) => p.x)));
    const newH = quantize01(Math.max(...normalized.map((p) => p.y)));
    return {
      type: 'POLYGON',
      width: newW,
      height: newH,
      vertices: normalized
    };
  }
  return stepDeg === 90
    ? { type: 'RECTANGLE', width: quantize01(h), height: quantize01(w) }
    : { type: 'RECTANGLE', width: quantize01(w), height: quantize01(h) };
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
    setStrategyRuns2D,
    addSchemes2D,
    removeScheme2D,
    clearSchemes2D,
    setActiveScheme2D,
    markSchemeDispatched,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
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
    settings,
    updateStudioSettings
  } = useStudioStore();

  const [slitPresets, setSlitPresets] = useState<SlittingWidthPreset[]>(() => loadSlittingPresets());
  const [selectedSlitPresetId, setSelectedSlitPresetId] = useState<string>('');
  const [savingPresetOpen, setSavingPresetOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const handleApplySlitPreset = (presetId: string) => {
    setSelectedSlitPresetId(presetId);
    const p = slitPresets.find((item) => item.id === presetId);
    if (!p) return;
    setSlitSpec({
      slitMotherWidthMm: p.motherWidthMm,
      slitLeftTrimMm: p.leftTrimMm,
      slitRightTrimMm: p.rightTrimMm,
      slitMinWidthMm: p.widthMode === 'FIXED' ? p.maxWidthMm : p.minWidthMm,
      slitMaxWidthMm: p.maxWidthMm,
      slitWidthStepMm: p.widthStepMm,
      slitOverCap: p.totalOverCap,
      slitWidthMode: p.widthMode
    });
    toast(`已套用一维预设「${p.name}」`);
  };

  const handleSaveCurrentSlitPreset = () => {
    const clean = newPresetName.trim();
    if (!clean) {
      toast('请输入预设名称', true);
      return;
    }
    const created: SlittingWidthPreset = {
      id: `preset-custom-${Date.now()}`,
      name: clean,
      motherWidthMm: Math.floor(slitMotherWidthMm),
      leftTrimMm: Math.floor(slitLeftTrimMm),
      rightTrimMm: Math.floor(slitRightTrimMm),
      minWidthMm: slitWidthMode === 'FIXED' ? Math.floor(slitMaxWidthMm) : Math.floor(slitMinWidthMm),
      maxWidthMm: Math.floor(slitMaxWidthMm),
      widthStepMm: Math.max(1, Math.floor(slitWidthStepMm)),
      totalOverCap: Math.max(0, Math.floor(slitOverCap)),
      widthMode: slitWidthMode,
      builtin: false
    };
    const next = saveCustomSlittingPresets([...slitPresets, created]);
    setSlitPresets(next);
    setSelectedSlitPresetId(created.id);
    setNewPresetName('');
    setSavingPresetOpen(false);
    toast(`已保存一维预设「${clean}」`);
  };

  const handleDeleteSelectedSlitPreset = () => {
    const target = slitPresets.find((p) => p.id === selectedSlitPresetId);
    if (!target || target.builtin) return;
    const next = saveCustomSlittingPresets(slitPresets.filter((p) => p.id !== target.id));
    setSlitPresets(next);
    setSelectedSlitPresetId('');
    toast(`已删除预设「${target.name}」`);
  };

  const extSettings = settings as StudioSettings & {
    showWorkflowGuide?: boolean;
    enabledStrategies2D?: string[];
  };
  const showWorkflowGuide = Boolean(extSettings.showWorkflowGuide);

  const activeAlgos = useMemo(() => {
    const rawList =
      Array.isArray(extSettings.enabledStrategies2D) && extSettings.enabledStrategies2D.length > 0
        ? extSettings.enabledStrategies2D
        : Array.isArray(selectedStrategies2D) && selectedStrategies2D.length > 0
        ? selectedStrategies2D
        : DEFAULT_ENABLED_STRATEGIES;
    const normalized = new Set(rawList.map((id) => LEGACY_STRATEGY_ALIAS[id] || id));
    const matched = STRATEGIES_2D.filter((s) => normalized.has(s.id));
    return matched.length > 0 ? matched : [STRATEGIES_2D[4]];
  }, [extSettings.enabledStrategies2D, selectedStrategies2D]);

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [poolFamilies, setPoolFamilies] = useState<DemandFamilySummary[]>([]);
  const [taskSchemes, setTaskSchemes] = useState<any[]>([]);
  const [demandSourceTab, setDemandSourceTab] = useState<'POOL' | 'TEMPLATE'>('TEMPLATE');
  const [activeClusterQuickId, setActiveClusterQuickId] = useState('DXF_1226');
  const [overviewModalOpen, setOverviewModalOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<'progress' | 'edit'>('progress');

  const [showPath, setShowPath] = useState<boolean>(settings.showPath);
  const [showDimensions, setShowDimensions] = useState<boolean>(settings.showDimensions);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoveredDemandKey, setHoveredDemandKey] = useState<string | null>(null);
  const [pinnedDemandKey, setPinnedDemandKey] = useState<string | null>(null);
  const [selectedPieceIndex, setSelectedPieceIndex] = useState<number | null>(null);

  useEffect(() => {
    setShowPath(settings.showPath);
    setShowDimensions(settings.showDimensions);
  }, [settings.showPath, settings.showDimensions]);

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
  const boardRef = useRef<WorkbenchBoardHandle | null>(null);
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

  // Reset piece selection if switching schemes
  useEffect(() => {
    setSelectedPieceIndex(null);
  }, [activeSchemeId2D]);

  // Effective 2D roll geometry & defects for interactive board
  const effectiveRollWidthMm = useMemo(() => {
    if (activeScheme2D?.widthMm) return activeScheme2D.widthMm;
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return currentRoll2D.width;
    if (canvasMode === 'REMNANT' && currentRemnant2D) return currentRemnant2D.width;
    return canvasWidthMm;
  }, [activeScheme2D, canvasMode, currentRoll2D, currentRemnant2D, canvasWidthMm]);

  const effectiveRollLengthMm = useMemo(() => {
    const baseLen =
      canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;
    if (!activeScheme2D) return baseLen;
    return Math.max(
      baseLen,
      Math.ceil(activeScheme2D.occupiedLengthMm || 0),
      Math.ceil(activeScheme2D.canvasLengthMm || 0)
    );
  }, [activeScheme2D, canvasMode, currentRemnant2D, canvasLengthMm]);

  const effectiveRollTitle = useMemo(() => {
    if (activeScheme2D) {
      if (activeScheme2D.canvasMode === 'STOCK_ROLL' && activeScheme2D.rollId) {
        return `实卷 ${activeScheme2D.rollId}`;
      }
      if (activeScheme2D.canvasMode === 'REMNANT' && activeScheme2D.remnantId) {
        return `料头 ${activeScheme2D.remnantId}`;
      }
      return '虚拟新母卷';
    }
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return `实卷 ${currentRoll2D.rollId}`;
    if (canvasMode === 'REMNANT' && currentRemnant2D) return `料头 ${currentRemnant2D.id}`;
    return '虚拟新母卷';
  }, [activeScheme2D, canvasMode, currentRoll2D, currentRemnant2D]);

  const windowDefects2D: BoardDefect[] = useMemo(() => {
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) {
      const startY = currentRoll2D.usedLength || 0;
      return (currentRoll2D.defects || [])
        .filter((d: any) => d.y < startY + effectiveRollLengthMm && d.y + d.h > startY)
        .map((d: any, idx: number) => ({
          id: d.id ?? idx + 1,
          x: Number(d.x) || 0,
          y: Math.max(0, (Number(d.y) || 0) - startY),
          w: Number(d.w) || 0,
          h: Number(d.h) || 0,
          margin: d.margin ?? settings.defectMarginMm
        }));
    }
    if (canvasMode === 'REMNANT' && currentRemnant2D) {
      return (currentRemnant2D.defects || []).map((d: any, idx: number) => ({
        id: d.id ?? idx + 1,
        x: Number(d.x) || 0,
        y: Number(d.y) || 0,
        w: Number(d.w) || 0,
        h: Number(d.h) || 0,
        margin: d.margin ?? settings.defectMarginMm
      }));
    }
    return [];
  }, [canvasMode, currentRoll2D, currentRemnant2D, effectiveRollLengthMm, settings.defectMarginMm]);

  // Project placed pieces & cuts from activeScheme2D for WorkbenchBoardCanvas
  const boardPlacedPieces: BoardPlacedPiece[] = useMemo(() => {
    if (!activeScheme2D?.result?.layout) return [];
    const mainList: any[] = activeScheme2D.result.layout.placements || [];
    const gapList: any[] = activeScheme2D.result?.marker?.gapFillPlacements || [];
    const combined: BoardPlacedPiece[] = [];
    mainList.forEach((p, idx) => {
      combined.push({
        id: p.id ?? `m-${idx + 1}`,
        index: idx,
        demandId: p.demandId,
        demandKey: p.demandId != null ? String(p.demandId) : `p-${idx}`,
        name: p.name || `#${p.demandId ?? idx + 1}`,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        width: Number(p.shape?.width ?? p.w) || 0,
        height: Number(p.shape?.height ?? p.l) || 0,
        rotationDegrees: p.rotationDegrees || 0,
        gapFill: false,
        shape: p.shape
      });
    });
    gapList.forEach((p, idx) => {
      const globalIdx = mainList.length + idx;
      combined.push({
        id: p.id ?? `g-${idx + 1}`,
        index: globalIdx,
        demandId: p.demandId,
        demandKey: p.demandId != null ? String(p.demandId) : `g-${idx}`,
        name: p.name || `#${p.demandId ?? idx + 1}`,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        width: Number(p.shape?.width ?? p.w) || 0,
        height: Number(p.shape?.height ?? p.l) || 0,
        rotationDegrees: p.rotationDegrees || 0,
        gapFill: true,
        shape: p.shape
      });
    });
    return combined;
  }, [activeScheme2D]);

  const boardCuts: BoardCutLine[] = useMemo(() => {
    const raw = activeScheme2D?.result?.layout?.cuts || [];
    return raw.map((c: any, idx: number) => ({
      sequence: c.sequence ?? idx + 1,
      kind: c.kind,
      startX: Number(c.startX) || 0,
      startY: Number(c.startY) || 0,
      endX: Number(c.endX) || 0,
      endY: Number(c.endY) || 0
    }));
  }, [activeScheme2D]);

  // Compute remaining staging pieces on the left of the board
  const boardStagingDemands: BoardDemandSpec[] = useMemo(() => {
    const placedByDemand = new Map<number, number>();
    if (activeScheme2D && !activeScheme2D.confirmedSchemeId) {
      for (const p of activeScheme2D.result?.layout?.placements || []) {
        if (p.demandId != null) {
          const did = Number(p.demandId);
          placedByDemand.set(did, (placedByDemand.get(did) || 0) + 1);
        }
      }
    }
    return activeDemands2D.map((d) => {
      const openQty = Math.max(0, Number(d.quantity) || 0);
      const placed = placedByDemand.get(d.id) || 0;
      return {
        key: String(d.id),
        demandId: d.id,
        name: d.name,
        width: d.width,
        length: d.length,
        remainingQty: Math.max(0, openQty - placed),
        totalQty: openQty,
        allowRotation: d.allowRotation,
        allowHalfTurn: d.allowHalfTurn,
        shape: d.shape
      };
    });
  }, [activeDemands2D, activeScheme2D]);

  // ==================== Interactive Board Mutations (Manual / Scheme Fine-Tuning) ====================

  const commitBoardPlacements = (
    mutate: (mainPlacements: any[], gapPlacements: any[]) => {
      mainPlacements: any[];
      gapPlacements: any[];
      notice?: string;
    } | null
  ) => {
    const existingEditable =
      activeScheme2D && !activeScheme2D.confirmedSchemeId ? activeScheme2D : null;
    const baseMain = existingEditable
      ? structuredClone(existingEditable.result?.layout?.placements || [])
      : [];
    const baseGap = existingEditable
      ? structuredClone(existingEditable.result?.marker?.gapFillPlacements || [])
      : [];

    const mutated = mutate(baseMain, baseGap);
    if (!mutated) return;

    const { mainPlacements, gapPlacements, notice } = mutated;
    const allPieces = [...mainPlacements, ...gapPlacements];

    // If manual board becomes completely empty, remove the empty manual scheme cleanly
    if (allPieces.length === 0 && existingEditable?.strategyId === 'MANUAL_BOARD') {
      removeScheme2D(existingEditable.id);
      setSelectedPieceIndex(null);
      if (notice) toast(notice);
      return;
    }

    const effW = existingEditable ? existingEditable.widthMm : effectiveRollWidthMm;
    const effL = existingEditable ? existingEditable.canvasLengthMm : effectiveRollLengthMm;
    const startOffset =
      existingEditable?.windowStartY ??
      (canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.usedLength || 0 : 0);

    const occupiedLengthMm = allPieces.length
      ? Math.round(
          Math.max(...allPieces.map((p: any) => (Number(p.y) || 0) + (p.shape?.height || 0))) * 10
        ) / 10
      : 0;
    const netAreaMm2 = allPieces.reduce((s: number, p: any) => s + shapeArea(p.shape), 0);
    const utilizationPct =
      occupiedLengthMm > 0
        ? Number(((netAreaMm2 / (effW * occupiedLengthMm)) * 100).toFixed(2))
        : 0;
    const pieceAreaM2 = Number((netAreaMm2 / 1_000_000).toFixed(3));

    const activeOpenDemands = activeDemands2D.filter(
      (d) => d.quantity > 0 && d.width > 0 && d.length > 0
    );
    const totalRequested = activeOpenDemands.reduce((s, d) => s + d.quantity, 0);
    const placedCounts = new Map<number, number>();
    for (const p of mainPlacements) {
      if (p.demandId != null) {
        const id = Number(p.demandId);
        placedCounts.set(id, (placedCounts.get(id) || 0) + 1);
      }
    }
    const complete =
      activeOpenDemands.length > 0 &&
      activeOpenDemands.every((d) => (placedCounts.get(d.id) || 0) >= d.quantity);

    const manualBuilt = existingEditable?.request
      ? null
      : buildSafeNestingRequest2D({
          strategy: STRATEGIES_2D[4],
          scenario: 'FIXED_BED',
          widthMm: effW,
          lengthMm: Math.max(effL, occupiedLengthMm || effL),
          pieceGapMm,
          trimStartMm,
          demands: activeOpenDemands.length > 0 ? activeOpenDemands : activeDemands2D,
          defects: windowDefects2D,
          settings
        });
    const baseReq = existingEditable?.request || manualBuilt?.request || {
      schemaVersion: '2.0',
      problemType: 'NESTING_2D',
      problem: {
        schemaVersion: '1',
        unit: 'mm',
        material: {
          id: `CANVAS-${effW}x${Math.max(effL, occupiedLengthMm || effL)}`,
          shape: rectangle(effW, Math.max(effL, occupiedLengthMm || effL)),
          exclusions: []
        },
        parts: [],
        process: { mode: 'GUILLOTINE', startCorner: 'left-top', trimStart: 0 }
      }
    };

    const nextResult = {
      ...(existingEditable?.result || {
        schemaVersion: '1',
        unit: 'mm',
        coordinateSystem: 'source-local-top-left',
        status: 'FEASIBLE',
        engine: 'manual-board',
        materialId: baseReq.problem.material.id,
        processingRegion: rectangle(effW, Math.max(effL, occupiedLengthMm || effL))
      }),
      fulfillmentStatus: complete ? 'COMPLETE' : 'PARTIAL',
      meetsRequirement: complete,
      layout: {
        ...(existingEditable?.result?.layout || {
          processingRegion: rectangle(effW, Math.max(effL, occupiedLengthMm || effL)),
          leftovers: [],
          contours: []
        }),
        placements: mainPlacements,
        cuts: []
      },
      marker: {
        ...(existingEditable?.result?.marker || {}),
        occupiedLengthMm,
        gapFillPlacements: gapPlacements
      }
    };

    const isManualNew = !existingEditable;
    const schemeId = existingEditable
      ? existingEditable.id
      : `MANUAL-BOARD-${Date.now().toString(36).slice(-5)}`;
    const nextStrategyName = existingEditable
      ? existingEditable.strategyId === 'MANUAL_BOARD'
        ? '手工排布'
        : existingEditable.strategyName.endsWith(' · 手调')
        ? existingEditable.strategyName
        : `${existingEditable.strategyName} · 手调`
      : '手工排布';

    const nextScheme: SavedScheme2D = {
      id: schemeId,
      title: `${nextStrategyName} (${effW}×${Math.round(occupiedLengthMm)}mm)`,
      strategyId: existingEditable ? existingEditable.strategyId : 'MANUAL_BOARD',
      strategyName: nextStrategyName,
      scenarioId: existingEditable?.scenarioId || scenario2D,
      createdAt:
        existingEditable?.createdAt || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      canvasMode: existingEditable?.canvasMode || canvasMode,
      rollId:
        existingEditable?.rollId ??
        (canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.rollId : undefined),
      remnantId:
        existingEditable?.remnantId ??
        (canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.id : undefined),
      windowStartY: startOffset,
      materialModel:
        existingEditable?.materialModel ||
        (canvasMode === 'STOCK_ROLL' && currentRoll2D
          ? currentRoll2D.rollModel
          : canvasMode === 'REMNANT' && currentRemnant2D
          ? currentRemnant2D.materialBatch
          : materialModel2D || `VIRTUAL-${effW}`),
      widthMm: effW,
      canvasLengthMm: Math.max(effL, occupiedLengthMm),
      occupiedLengthMm,
      utilizationPct,
      pieceAreaM2,
      placedCount: allPieces.length,
      requestedCount: Math.max(totalRequested, allPieces.length),
      gapFillCount: gapPlacements.length,
      complete,
      demands: structuredClone(activeOpenDemands.length > 0 ? activeOpenDemands : activeDemands2D),
      request: baseReq,
      result: nextResult
    };

    useStudioStore.setState((st) => {
      if (isManualNew) {
        return {
          schemes2D: [nextScheme, ...st.schemes2D],
          activeSchemeId2D: nextScheme.id
        };
      }
      return {
        schemes2D: st.schemes2D.map((s) => (s.id === nextScheme.id ? nextScheme : s)),
        activeSchemeId2D: nextScheme.id
      };
    });
    setLastConfirmSummary(null);
    if (notice) toast(notice);
  };

  const handleDropStagingPiece = (demandKey: string, localX: number, localY: number) => {
    const demand = activeDemands2D.find((d) => String(d.id) === demandKey);
    if (!demand) return;
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      const nextId =
        mainPlacements.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0) + 1;
      const shape = demand.shape
        ? structuredClone(demand.shape)
        : rectangle(Number(demand.width), Number(demand.length));
      mainPlacements.push({
        id: nextId,
        demandId: demand.id,
        name: demand.name,
        x: localX,
        y: localY,
        rotationDegrees: 0,
        shape
      });
      setSelectedPieceIndex(mainPlacements.length - 1);
      return { mainPlacements, gapPlacements };
    });
  };

  const handleMovePlacedPiece = (pieceIndex: number, localX: number, localY: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      if (pieceIndex < mainPlacements.length) {
        mainPlacements[pieceIndex] = {
          ...mainPlacements[pieceIndex],
          x: localX,
          y: localY
        };
      } else {
        const gIdx = pieceIndex - mainPlacements.length;
        if (gIdx >= 0 && gIdx < gapPlacements.length) {
          gapPlacements[gIdx] = {
            ...gapPlacements[gIdx],
            x: localX,
            y: localY
          };
        } else {
          return null;
        }
      }
      return { mainPlacements, gapPlacements };
    });
  };

  const handleRotatePlacedPiece = (pieceIndex: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      const isMain = pieceIndex < mainPlacements.length;
      const target = isMain ? mainPlacements[pieceIndex] : gapPlacements[pieceIndex - mainPlacements.length];
      if (!target) return null;

      const curShape: ShapeGeometry | undefined = target.shape;
      const curW = Number(curShape?.width ?? target.w) || 0;
      const curH = Number(curShape?.height ?? target.l) || 0;
      const demand = activeDemands2D.find((d) => d.id === target.demandId);
      const isPoly = curShape?.type === 'POLYGON';
      const stepDeg: 90 | 180 = isPoly && !demand?.allowRotation ? 180 : 90;

      const rotatedShape = rotateShapeGeometry(curShape, curW, curH, stepDeg);
      if (rotatedShape.width > effectiveRollWidthMm + 0.5) {
        toast(`旋转后宽度 ${Math.round(rotatedShape.width)}mm 超过母卷门幅 ${effectiveRollWidthMm}mm`, true);
        return null;
      }
      if (rotatedShape.height > effectiveRollLengthMm - trimStartMm + 0.5) {
        toast(`旋转后长度 ${Math.round(rotatedShape.height)}mm 超过当前母卷可用版长`, true);
        return null;
      }

      const cx = (Number(target.x) || 0) + curW / 2;
      const cy = (Number(target.y) || 0) + curH / 2;
      const nextX = Math.max(
        0,
        Math.min(effectiveRollWidthMm - rotatedShape.width, Math.round((cx - rotatedShape.width / 2) * 10) / 10)
      );
      const nextY = Math.max(
        trimStartMm,
        Math.min(effectiveRollLengthMm - rotatedShape.height, Math.round((cy - rotatedShape.height / 2) * 10) / 10)
      );

      const updated = {
        ...target,
        x: nextX,
        y: nextY,
        rotationDegrees: ((Number(target.rotationDegrees) || 0) + stepDeg) % 360,
        shape: rotatedShape
      };
      if (isMain) mainPlacements[pieceIndex] = updated;
      else gapPlacements[pieceIndex - mainPlacements.length] = updated;

      return { mainPlacements, gapPlacements };
    });
  };

  const handleRemovePlacedPiece = (pieceIndex: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      if (pieceIndex < mainPlacements.length) {
        mainPlacements.splice(pieceIndex, 1);
      } else {
        const gIdx = pieceIndex - mainPlacements.length;
        if (gIdx >= 0 && gIdx < gapPlacements.length) {
          gapPlacements.splice(gIdx, 1);
        } else {
          return null;
        }
      }
      setSelectedPieceIndex(null);
      return { mainPlacements, gapPlacements };
    });
  };

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
        toast('该需求族已排齐，按原单总量进行重排试算');
      } else {
        toast('请先在左侧选择需求族、载入模板或添加裁片需求', true);
        return;
      }
    }

    const chosenDefs = activeAlgos;
    if (!chosenDefs.length) {
      toast('请在系统设置中至少启用一种二维排版算法', true);
      return;
    }

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
    const failureMessages: string[] = [];

    await Promise.all(
      jobsToRun.map(async ({ def, width, runKey, label }) => {
        const tooWide = validDemands.some((d) => {
          const isPoly = d.shape?.type === 'POLYGON';
          const canRot90 = isPoly
            ? Boolean(d.allowRotation)
            : Boolean(d.allowRotation || def.forceRotateRect);
          return canRot90 ? Math.min(d.width, d.length) > width : d.width > width;
        });
        if (tooWide) {
          const msg = `存在裁片宽超门幅 ${width}mm`;
          failureMessages.push(`${label}：${msg}`);
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey ? { ...r, state: 'FAILED', phaseText: msg } : r
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
        const built = buildSafeNestingRequest2D({
          strategy: def,
          scenario: effectiveScenario,
          widthMm: width,
          lengthMm: effLength,
          pieceGapMm,
          trimStartMm,
          demands: validDemands,
          defects: windowDefects,
          maxLengthCapMm: stockMaxCap,
          settings
        });
        if (built.error || !built.request) {
          const msg = built.error || '请求参数无法构造有效求解问题';
          failureMessages.push(`${label}：${msg}`);
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey ? { ...r, state: 'FAILED', phaseText: msg } : r
            )
          );
          return;
        }
        const req = built.request;
        const t0 = performance.now();
        try {
          const { job, result: rawResult } = await (session as any).solve(req, {
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
          const result = unpadGuillotineResult(rawResult, built);
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
          const fallbackHint = layout?.fallbackReason ? ' · 已降级' : '';

          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? {
                    ...r,
                    jobId: job.id,
                    state: job.state as any,
                    phaseText: complete
                      ? `齐套 · ${fmtN(occupiedLengthMm, 1)}mm · ${utilizationPct}%${fallbackHint}`
                      : placements.length > 0
                      ? `已排 ${placements.length}/${totalRequested} · ${utilizationPct}%${fallbackHint}`
                      : layout?.message || '未排入任何裁片（请检查门幅与版长）',
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
          } else {
            failureMessages.push(
              `${label}：${layout?.message || '未能排入裁片，请增大版长或调整旋转规则'}`
            );
          }
        } catch (err: any) {
          const rawMsg = err?.message || '求解未完成';
          const friendlyMsg =
            /failed to fetch|networkerror|connection|无法连接|fetch/i.test(rawMsg)
              ? '无法连接后端求解服务（请确认 8080 端口服务已启动）'
              : rawMsg;
          if (err?.name !== 'AbortError') {
            failureMessages.push(`${label}：${friendlyMsg}`);
          }
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? {
                    ...r,
                    state: err.name === 'AbortError' ? 'CANCELLED' : 'FAILED',
                    phaseText: friendlyMsg
                  }
                : r
            )
          );
        }
      })
    );

    if (createdSchemes.length > 0) {
      addSchemes2D(createdSchemes);
      toast(`排版完成：生成 ${createdSchemes.length} 套候选方案`);
    } else if (failureMessages.length > 0) {
      toast(`排版未生成方案：${failureMessages[0]}`, true);
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
        toast('该分条需求族已排齐，按原单总量进行重排试算');
      } else {
        toast('请先在左侧载入分条需求族或添加分条规格', true);
        return;
      }
    }
    const effMotherW = Math.floor(
      slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
        ? currentRoll1D.width
        : slitMotherWidthMm
    );
    const effLeftTrim = Math.max(0, Math.floor(Number(slitLeftTrimMm) || 0));
    const effRightTrim = Math.max(0, Math.floor(Number(slitRightTrimMm) || 0));
    const maxUsable = effMotherW - effLeftTrim - effRightTrim;
    if (!Number.isFinite(effMotherW) || effMotherW <= 0 || maxUsable <= 0) {
      toast('请检查母卷幅宽与左右切边：扣边后可用幅宽必须大于 0 mm', true);
      return;
    }

    const rawMaxW = Math.floor(Number(slitMaxWidthMm) || maxUsable);
    const effMaxW = Math.min(maxUsable, rawMaxW);
    const effMinW =
      slitWidthMode === 'FIXED'
        ? effMaxW
        : Math.floor(Number(slitMinWidthMm) || effMaxW);
    const effStep = Math.max(1, Math.floor(Number(slitWidthStepMm) || 10));
    const effOverCap =
      scenario1D === 'MAX_UTIL'
        ? Math.max(Math.max(0, Math.floor(Number(slitOverCap) || 0)), 30)
        : Math.max(0, Math.floor(Number(slitOverCap) || 0));

    if (effMinW <= 0 || effMaxW < effMinW || effMaxW > maxUsable) {
      toast(
        `组合宽度区间 [${effMinW}, ${effMaxW}] mm 无效，须位于可切幅宽 (≤ ${maxUsable} mm) 内且下限 ≤ 上限`,
        true
      );
      return;
    }
    if (Math.floor((effMaxW - effMinW) / effStep) > 1000) {
      toast('组合幅宽候选步数超过 1001 档，请调大步长或收窄区间', true);
      return;
    }
    const maxOrderW = Math.max(...validOrders.map((o) => Math.floor(o.widthMm)));
    if (maxOrderW > effMaxW) {
      toast(
        `最大订单幅宽 ${maxOrderW} mm 超出当前组合上限 ${effMaxW} mm，请调大母卷幅宽或组合上限`,
        true
      );
      return;
    }

    setRunningSolve(true);
    setLastConfirmSummary(null);
    const advOpts = extractSlittingSolverOptions(settings);
    const runProfiles: SlittingProfile[] = settings.slitRunBothProfiles
      ? ['FAST', 'QUALITY']
      : [slitProfile];

    try {
      const baselineInput = {
        motherWidth: effMotherW,
        leftTrim: effLeftTrim,
        rightTrim: effRightTrim,
        orderItems: validOrders.map((o) => ({
          width: Math.floor(o.widthMm),
          length: Math.floor(o.lengthMm > 0 ? o.lengthMm : slitFixedLengthMm),
          quantity: Math.floor(o.quantity),
          surfaceTreatment: o.surfaceTreatment?.trim() || '不电晕/不涂布'
        }))
      };
      const baseGroups = independentBaseline(baselineInput);
      const baseSummary = planSummary(baseGroups, baselineInput);
      const baselineRun: SlittingSchemeRun = {
        id: 'SLIT-BASELINE',
        strategyId: 'BASELINE',
        strategyName: '逐规格独立分切（基线）',
        state: 'SUCCEEDED',
        motherWidthMm: effMotherW,
        leftTrimMm: effLeftTrim,
        rightTrimMm: effRightTrim,
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
            spareWidthMm: Math.max(0, effMotherW - effLeftTrim - effRightTrim - usedW)
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

      const makePending = (profile: SlittingProfile): SlittingSchemeRun => ({
        id: `SLIT-${profile}`,
        strategyId: profile,
        strategyName:
          profile === 'FAST'
            ? 'OR-Tools 快捷解 (FAST)'
            : 'OR-Tools 精确解 (QUALITY)',
        state: 'RUNNING',
        motherWidthMm: effMotherW,
        leftTrimMm: effLeftTrim,
        rightTrimMm: effRightTrim,
        totalCars: 0,
        missingRolls: 0,
        overproducedRolls: 0,
        avgUtilizationPct: 0,
        patterns: [],
        fulfillment: []
      });
      setSlitSchemes([...runProfiles.map(makePending), baselineRun]);

      const runProfile = async (profile: SlittingProfile): Promise<SlittingSchemeRun> => {
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const t0 = performance.now();
        const effTimeLimit = Math.min(
          180,
          Math.max(
            1,
            Math.round(
              profile === 'QUALITY'
                ? Math.max(settings.slitTimeLimitSeconds, validOrders.length >= 40 ? 180 : 60)
                : settings.slitTimeLimitSeconds
            )
          )
        );
        const req = {
          schemaVersion: '2.0',
          clientRequestId: `slit-${profile}-${Date.now()}`,
          problemType: 'SLITTING_1D',
          allowFallback: false,
          requireComplete: false,
          problem: {
            schemaVersion: '1',
            unit: 'mm',
            motherWidthMm: effMotherW,
            leftTrimMm: effLeftTrim,
            rightTrimMm: effRightTrim,
            minWidthMm: effMinW,
            maxWidthMm: effMaxW,
            widthStepMm: effStep,
            totalOverCap: effOverCap,
            profile,
            timeLimitSeconds: effTimeLimit,
            topK: advOpts.topK,
            maxIterations: advOpts.maxIterations,
            maxPatterns: advOpts.maxPatterns,
            maxDistinctWidths:
              profile === 'QUALITY'
                ? Math.max(advOpts.maxDistinctWidths, 5)
                : advOpts.maxDistinctWidths,
            stageTimeLimitMs: advOpts.stageTimeLimitMs,
            useOptimizedAssignment: advOpts.useOptimizedAssignment,
            underPenalty: advOpts.underPenalty,
            seqGroupAlpha: advOpts.seqGroupAlpha,
            seqGroupBeta: advOpts.seqGroupBeta,
            lnsEnabled: advOpts.lnsEnabled,
            orders: validOrders.map((o) => ({
              id: o.id,
              widthMm: Math.floor(o.widthMm),
              lengthMm: Math.floor(o.lengthMm > 0 ? o.lengthMm : slitFixedLengthMm),
              quantity: Math.floor(o.quantity),
              surfaceTreatment: o.surfaceTreatment?.trim() || '不电晕/不涂布'
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
                ? 'OR-Tools 快捷解 (FAST)'
                : 'OR-Tools 精确解 (QUALITY)',
            state: 'SUCCEEDED',
            motherWidthMm: effMotherW,
            leftTrimMm: effLeftTrim,
            rightTrimMm: effRightTrim,
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
              spareWidthMm: Math.max(0, effMotherW - effLeftTrim - effRightTrim - p.patternWidthMm),
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
            ...makePending(profile),
            strategyName: `OR-Tools (${profile}) - ${e.message || '求解失败'}`,
            state: 'FAILED'
          };
        }
      };

      const results = await Promise.all(runProfiles.map((prof) => runProfile(prof)));
      const orderedResults = [...results].sort((a, b) => {
        if (a.state === 'SUCCEEDED' && b.state !== 'SUCCEEDED') return -1;
        if (b.state === 'SUCCEEDED' && a.state !== 'SUCCEEDED') return 1;
        return a.totalCars - b.totalCars;
      });
      setSlitSchemes([...orderedResults, baselineRun]);
      const bestSolved = orderedResults.find((r) => r.state === 'SUCCEEDED');
      if (bestSolved) {
        toast(
          `分切排版完成：${bestSolved.strategyName} ${bestSolved.totalCars} 车（较独立分切省 ${Math.max(
            0,
            baselineRun.totalCars - bestSolved.totalCars
          )} 车，利用率 ${bestSolved.avgUtilizationPct}%）`
        );
      } else {
        toast(orderedResults[0]?.strategyName || '一维分切求解未返回有效方案', true);
      }
    } catch (e: any) {
      toast('一维分切求解失败：' + e.message, true);
    } finally {
      setRunningSolve(false);
    }
  };

  const handleStopSolve = () => {
    activeSessionsRef.current.forEach((s) => s.cancel());
    setRunningSolve(false);
    toast('已中止当前排版计算');
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
          ? `已确认方案「${savedScheme.id}」并扣减待排需求`
          : `已确认方案「${savedScheme.id}」并锁定实卷区段`
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
      toast(`已选定分切方案「${savedScheme.id}」并扣减待排需求`);
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
      toast(`已导入纸样「${created.name}」`);
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

  const totalRolls1D = slitOrders.reduce((s, o) => s + (Number(o.quantity) || 0), 0);

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
          width: d.width,
          length: d.length,
          shape: d.shape,
          compactDim: `${fmtN(d.width, 0)}×${fmtN(d.length, 0)}`,
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
        width: o.widthMm,
        length: slitFixedLengthMm,
        shape: undefined as ShapeGeometry | undefined,
        compactDim: `${fmtN(o.widthMm, 0)}×${fmtN(slitFixedLengthMm, 0)}`,
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
    const settled = done + planned;
    const pct = ordered > 0 ? Math.min(100, Math.round((settled / ordered) * 100)) : 0;
    return {
      itemCount: demandRowsView.length,
      ordered,
      done,
      planned,
      settled,
      uncut,
      cand,
      afterCandUncut,
      totalAreaM2,
      pct,
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
    let curY = currentRoll1D.usedLength || 0;
    let carNo = 1;
    for (const pat of activeScheme1D.patterns) {
      for (let r = 0; r < pat.repetitions && carNo <= 24; r++) {
        const assigned = assignCar({ ...pat, lengthMm: slitFixedLengthMm }, open, slitLeftTrimMm);
        const y0 = carStart(currentRoll1D, curY, slitFixedLengthMm, assigned.strips, []);
        if (y0 == null) break;
        list.push({
          carNo: carNo++,
          startY: y0,
          endY: y0 + slitFixedLengthMm,
          comp: pat.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
          avoided: y0 > curY + 1
        });
        curY = y0 + slitFixedLengthMm;
      }
    }
    return list;
  }, [slitAvoidDefects, slitMaterialMode, currentRoll1D, activeScheme1D, slitOrders, slitFixedLengthMm, slitLeftTrimMm]);

  const activeHighlightKey = hoveredDemandKey || pinnedDemandKey;

  const openEngineSettings = () => {
    window.dispatchEvent(new CustomEvent('cutplan:open-settings', { detail: { tab: 'engines' } }));
  };

  return (
    <div className="react-page studio-2d-page wb-v2">
      {/* Compact Top Bar */}
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

        {/* Workflow guide stepper — hidden by default; enabled via Settings -> 显示排程流程引导 */}
        {showWorkflowGuide && (
          <div className="stage-stepper" role="group" aria-label="排程流程引导">
            <button
              type="button"
              className={currentStage === 1 ? 'active' : ''}
              onClick={() => leftPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
            >
              <b>1. 搭切前</b>
            </button>
            <span className="stage-arrow" aria-hidden="true">›</span>
            <button
              type="button"
              className={currentStage === 2 ? 'active' : ''}
              onClick={() => rightPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
            >
              <b>2. 搭切中</b>
            </button>
            <span className="stage-arrow" aria-hidden="true">›</span>
            <button
              type="button"
              className={currentStage === 3 ? 'active' : ''}
              onClick={() => stripRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
            >
              <b>3. 搭切后</b>
            </button>
          </div>
        )}

        {/* Mother Roll Selection Mode */}
        {is2D ? (
          <>
            <div className="seg" role="group" aria-label="母卷投料来源">
              <button
                type="button"
                className={canvasMode === 'FREE_CANVAS' ? 'on' : ''}
                aria-pressed={canvasMode === 'FREE_CANVAS'}
                onClick={() => setCanvasSpec({ canvasMode: 'FREE_CANVAS' })}
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
                    <span>门幅列表</span>
                    <input
                      className="field num"
                      style={{ width: 148 }}
                      value={multiWidthsText2D}
                      onChange={(e) => setMultiWidthsText2D(e.target.value)}
                      placeholder="1500, 1650, 1800"
                    />
                    <em>mm</em>
                  </label>
                ) : (
                  <>
                    <label>
                      <span>门幅 W</span>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: 68 }}
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
                  <span>版长 L</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 70 }}
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
                  <span>母卷</span>
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
                        {r.rollId} · {r.rollModel} (W{r.width} · 余{fmtM(r.currentRemainingLength)}m)
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>拉布长 L</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 70 }}
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
                  <span>料头</span>
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
                工艺 <span className="num">距{pieceGapMm} · 头{trimStartMm}</span>
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
                  更多全局工艺设置…
                </button>
              </div>
            </details>
          </>
        ) : (
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
                  <span>母卷幅宽</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 72 }}
                    value={slitMotherWidthMm}
                    onChange={(e) => {
                      const w = Math.max(500, Number(e.target.value) || 2000);
                      const usable = Math.max(100, w - slitLeftTrimMm - slitRightTrimMm);
                      const nextMax = Math.min(slitMaxWidthMm, usable);
                      setSlitSpec({
                        slitMotherWidthMm: w,
                        slitMaxWidthMm: nextMax,
                        slitMinWidthMm:
                          slitWidthMode === 'FIXED' ? nextMax : Math.min(slitMinWidthMm, nextMax)
                      });
                    }}
                  />
                  <em>mm</em>
                </label>
                <label>
                  <span>定长</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 72 }}
                    value={slitFixedLengthMm}
                    onChange={(e) => setSlitSpec({ slitFixedLengthMm: Number(e.target.value) })}
                  />
                  <em>mm</em>
                </label>
              </div>
            ) : (
              <div className="studio-canvas-inputs">
                <label>
                  <span>实卷</span>
                  <select
                    className="field"
                    value={currentRoll1D?.rollId || ''}
                    onChange={(e) => {
                      const r = passedRolls.find((x) => x.rollId === e.target.value);
                      const usable = r ? Math.max(100, r.width - slitLeftTrimMm - slitRightTrimMm) : slitMaxWidthMm;
                      setSlitSpec({
                        slitRollId: e.target.value,
                        ...(r
                          ? {
                              slitMotherWidthMm: r.width,
                              slitMaterialModel: r.rollModel,
                              slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                              slitMinWidthMm:
                                slitWidthMode === 'FIXED'
                                  ? Math.min(slitMaxWidthMm, usable)
                                  : Math.min(slitMinWidthMm, Math.min(slitMaxWidthMm, usable))
                            }
                          : {})
                      });
                    }}
                  >
                    {passedRolls.map((r) => (
                      <option key={r.rollId} value={r.rollId}>
                        {r.rollId} (W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m)
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>定长</span>
                  <input
                    type="number"
                    className="field num"
                    style={{ width: 70 }}
                    value={slitFixedLengthMm}
                    onChange={(e) => setSlitSpec({ slitFixedLengthMm: Number(e.target.value) })}
                  />
                  <em>mm</em>
                </label>
              </div>
            )}

            <details className="craft-disclosure">
              <summary>
                一维参数{' '}
                <span className="num">
                  切边 {slitLeftTrimMm}+{slitRightTrimMm} · 宽
                  {slitWidthMode === 'FIXED'
                    ? `${slitMaxWidthMm}`
                    : `${slitMinWidthMm}-${slitMaxWidthMm}/步${slitWidthStepMm}`}{' '}
                  · 超≤{slitOverCap}
                </span>
              </summary>
              <div className="craft-disclosure-panel" style={{ minWidth: 270 }}>
                <label>
                  <span>宽度模式</span>
                  <select
                    className="field"
                    value={slitWidthMode}
                    onChange={(e) => {
                      const nextMode = e.target.value as SlittingWidthMode;
                      setSlitSpec({
                        slitWidthMode: nextMode,
                        ...(nextMode === 'FIXED' ? { slitMinWidthMm: slitMaxWidthMm } : {})
                      });
                    }}
                  >
                    <option value="FLEXIBLE">可变宽幅区间</option>
                    <option value="FIXED">固定组合宽</option>
                  </select>
                </label>
                <label>
                  <span>左固定切边 (mm)</span>
                  <input
                    type="number"
                    min={0}
                    className="field num"
                    value={slitLeftTrimMm}
                    onChange={(e) => {
                      const lt = Math.max(0, Number(e.target.value) || 0);
                      const usable = Math.max(100, slitMotherWidthMm - lt - slitRightTrimMm);
                      setSlitSpec({
                        slitLeftTrimMm: lt,
                        slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                        slitMinWidthMm: Math.min(slitMinWidthMm, usable)
                      });
                    }}
                  />
                </label>
                <label>
                  <span>右固定切边 (mm)</span>
                  <input
                    type="number"
                    min={0}
                    className="field num"
                    value={slitRightTrimMm}
                    onChange={(e) => {
                      const rt = Math.max(0, Number(e.target.value) || 0);
                      const usable = Math.max(100, slitMotherWidthMm - slitLeftTrimMm - rt);
                      setSlitSpec({
                        slitRightTrimMm: rt,
                        slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                        slitMinWidthMm: Math.min(slitMinWidthMm, usable)
                      });
                    }}
                  />
                </label>
                {slitWidthMode === 'FLEXIBLE' && (
                  <label>
                    <span>最小组合宽 (mm)</span>
                    <input
                      type="number"
                      min={100}
                      className="field num"
                      value={slitMinWidthMm}
                      onChange={(e) =>
                        setSlitSpec({ slitMinWidthMm: Math.max(100, Number(e.target.value) || 100) })
                      }
                    />
                  </label>
                )}
                <label>
                  <span>{slitWidthMode === 'FIXED' ? '固定组合宽 (mm)' : '最大组合宽 (mm)'}</span>
                  <input
                    type="number"
                    min={100}
                    className="field num"
                    value={slitMaxWidthMm}
                    onChange={(e) => {
                      const v = Math.max(100, Number(e.target.value) || 100);
                      setSlitSpec({
                        slitMaxWidthMm: v,
                        ...(slitWidthMode === 'FIXED' ? { slitMinWidthMm: v } : {})
                      });
                    }}
                  />
                </label>
                {slitWidthMode === 'FLEXIBLE' && (
                  <label>
                    <span>幅宽步长 (mm)</span>
                    <input
                      type="number"
                      min={1}
                      className="field num"
                      value={slitWidthStepMm}
                      onChange={(e) =>
                        setSlitSpec({ slitWidthStepMm: Math.max(1, Number(e.target.value) || 10) })
                      }
                    />
                  </label>
                )}
                <label>
                  <span>超产上限 (卷)</span>
                  <input
                    type="number"
                    min={0}
                    className="field num"
                    value={slitOverCap}
                    onChange={(e) =>
                      setSlitSpec({ slitOverCap: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn sm"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    openEngineSettings();
                  }}
                >
                  打开 NewSolver 高级参数设置…
                </button>
              </div>
            </details>
          </>
        )}
      </div>

      {/* Main 3-Column Floating Workspace */}
      <div className="studio-split">
        {/* ==================== LEFT COLUMN: 需求 ==================== */}
        <section ref={leftPaneRef} className="pane studio-left">
          <div className="pane-h">
            <span>需求</span>
            <span className="sp" />
            <a href="#/demands" className="link-btn">
              ＋ 新建
            </a>
            <a href="#/demand-library" className="link-btn">
              需求库
            </a>
          </div>

          <div className="pane-b">
            {/* Source Switcher */}
            <div className="wb-source-box">
              <div className="seg">
                <button
                  type="button"
                  className={demandSourceTab === 'POOL' ? 'on' : ''}
                  onClick={() => setDemandSourceTab('POOL')}
                >
                  需求族 ({filteredPoolFamilies.length})
                </button>
                <button
                  type="button"
                  className={demandSourceTab === 'TEMPLATE' ? 'on' : ''}
                  onClick={() => setDemandSourceTab('TEMPLATE')}
                >
                  模板 ({filteredClusters.length})
                </button>
              </div>

              {demandSourceTab === 'POOL' ? (
                filteredPoolFamilies.length > 0 ? (
                  <>
                    <select
                      className="field"
                      style={{ width: '100%' }}
                      value={(is2D ? loadedTaskId : slitLoadedTaskId) || ''}
                      onChange={(e) => {
                        const fam = filteredPoolFamilies.find((f) => f.id === e.target.value);
                        if (fam) {
                          loadDemandFamilyIntoWorkbench(fam);
                          setLastConfirmSummary(null);
                          toast(`已载入「${fam.name}」（待排 ${fam.openTotal}）`);
                        }
                      }}
                    >
                      <option value="">选择需求族…</option>
                      {filteredPoolFamilies.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name} · 余 {f.openTotal}/{f.orderedTotal}
                        </option>
                      ))}
                    </select>
                    {(is2D ? loadedTaskName : slitLoadedTaskName) && (
                      <div className="wb-source-meta">
                        已关联：<b>{is2D ? loadedTaskName : slitLoadedTaskName}</b>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="wb-source-meta">
                    暂无需求族，可去 <a href="#/demands">需求池</a> 创建或切换模板
                  </div>
                )
              ) : (
                quickCluster && (
                  <>
                    <select
                      className="field"
                      style={{ width: '100%' }}
                      value={quickCluster.id}
                      onChange={(e) => setActiveClusterQuickId(e.target.value)}
                    >
                      {filteredClusters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
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
                        className="btn sm soft-accent"
                        style={{ flex: 1, justifyContent: 'center' }}
                        onClick={() => {
                          setLastConfirmSummary(null);
                          if (is2D) loadClusterInto2D(quickCluster.id, false);
                          else loadClusterInto1D(quickCluster.id, false);
                          toast(`已载入「${quickCluster.name}」`);
                        }}
                      >
                        载入
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          if (is2D) loadClusterInto2D(quickCluster.id, true);
                          else loadClusterInto1D(quickCluster.id, true);
                          toast(`已追加「${quickCluster.name}」`);
                        }}
                      >
                        ＋ 追加
                      </button>
                    </div>
                  </>
                )
              )}
            </div>

            {/* Compact Progress Summary Strip */}
            <div className="wb-summary-strip">
              <div className="wb-summary-top">
                <div className="wb-summary-nums num">
                  <span>
                    已排 <b>{overviewStats.settled + overviewStats.cand}</b>/{overviewStats.ordered}
                  </span>
                  {overviewStats.uncut === 0 ? (
                    <span className="is-ok">已排齐</span>
                  ) : (
                    <span>余 {overviewStats.afterCandUncut}{overviewStats.unit}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="wb-overview-trigger"
                  onClick={() => {
                    setOverviewTab('progress');
                    setOverviewModalOpen(true);
                  }}
                >
                  具体需求概览
                </button>
              </div>
              <div className="wb-mini-prog" aria-label={`总体进度 ${overviewStats.pct}%`}>
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

            {/* List Section Header */}
            <div className="wb-list-toolbar">
              <span className="num">规格 · {demandRowsView.length}</span>
              <div className="wb-list-toolbar-actions">
                <button
                  type="button"
                  className="wb-tiny-ghost"
                  onClick={() => {
                    setOverviewTab('edit');
                    setOverviewModalOpen(true);
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="wb-tiny-ghost"
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

            {/* Magpie Single-Card Flat Demand List */}
            <div className="wb-demand-list" role="list" aria-label="逐项需求完成进度列表">
              {demandRowsView.length === 0 ? (
                <div className="empty" style={{ padding: 20 }}>
                  暂无需求规格
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
                  const isHighlighted = activeHighlightKey === row.key;
                  const displayFilled = settledRow + row.cand;

                  return (
                    <div
                      key={row.key}
                      role="listitem"
                      className={`wb-demand-prog-row ${
                        isFinished ? 'is-done' : row.cand > 0 ? 'is-cand' : 'is-open'
                      }${isHighlighted ? ' is-highlighted' : ''}`}
                      onMouseEnter={() => setHoveredDemandKey(row.key)}
                      onMouseLeave={() => setHoveredDemandKey(null)}
                      onClick={() =>
                        setPinnedDemandKey((cur) => (cur === row.key ? null : row.key))
                      }
                    >
                      <div className="wb-row-main">
                        <DemandShapeThumb
                          width={row.width}
                          length={row.length}
                          shape={row.shape}
                          done={isFinished}
                        />
                        <div className="wb-row-info">
                          <span className="wb-row-name" title={row.name}>
                            {row.name}
                          </span>
                          <span className="wb-row-dim num">{row.compactDim}</span>
                        </div>
                        <span
                          className={`wb-row-count num ${
                            isFinished ? 'is-done' : row.cand > 0 ? 'is-cand' : ''
                          }`}
                        >
                          {isFinished && (
                            <svg
                              className="wb-row-check"
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M3.5 8.5L6.5 11.5L12.5 4.8"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                          {displayFilled}/{row.ordered}
                        </span>
                      </div>
                      <div className="wb-mini-prog" aria-hidden="true">
                        <i className="seg-done" style={{ width: `${donePct}%` }} />
                        <i className="seg-plan" style={{ width: `${planPct}%` }} />
                        {candPct > 0 && <i className="seg-cand" style={{ width: `${candPct}%` }} />}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        {/* ==================== CENTER COLUMN: LIGHT FIXED-GRID INTERACTIVE BOARD ==================== */}
        {is2D ? (
          <section className="pane studio-center">
            <div className="ctool" role="toolbar" aria-label="画布视图工具">
              <div className="ctool-group" role="group" aria-label="缩放与对齐">
                <button type="button" onClick={() => boardRef.current?.fit()}>
                  居中适配
                </button>
                <button type="button" onClick={() => boardRef.current?.zoom(1 / 1.25)} aria-label="缩小">
                  −
                </button>
                <button type="button" onClick={() => boardRef.current?.zoom(1.25)} aria-label="放大">
                  ＋
                </button>
                <button type="button" onClick={() => boardRef.current?.resetRollOffset()}>
                  重置卷位
                </button>
              </div>

              <span className="div" role="separator" aria-orientation="vertical" />

              <div className="ctool-group" role="group" aria-label="图层开关">
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

              {selectedPieceIndex != null && (
                <>
                  <span className="div" role="separator" aria-orientation="vertical" />
                  <div className="ctool-group" role="group" aria-label="选中裁片操作">
                    <button
                      type="button"
                      className="ctool-piece-act"
                      onClick={() => handleRotatePlacedPiece(selectedPieceIndex)}
                    >
                      旋转 (R)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemovePlacedPiece(selectedPieceIndex)}
                    >
                      退回待排
                    </button>
                  </div>
                </>
              )}

              <span className="sp" />

              <span className="num ctool-readout">
                {activeScheme2D
                  ? `${activeScheme2D.widthMm}×${fmtN(activeScheme2D.occupiedLengthMm, 1)} mm · ${activeScheme2D.utilizationPct}%`
                  : `${effectiveRollWidthMm}×${effectiveRollLengthMm} mm`}
                {cursor ? ` · X ${fmtN(cursor.x, 0)} / Y ${fmtN(cursor.y, 0)}` : ''}
              </span>
            </div>

            <div className="canvas-wrap" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              <WorkbenchBoardCanvas
                rollTitle={effectiveRollTitle}
                rollWidthMm={effectiveRollWidthMm}
                rollLengthMm={effectiveRollLengthMm}
                occupiedLengthMm={activeScheme2D?.occupiedLengthMm || 0}
                trimStartMm={trimStartMm}
                pieceGapMm={pieceGapMm}
                defects={windowDefects2D}
                demands={boardStagingDemands}
                placedPieces={boardPlacedPieces}
                cuts={boardCuts}
                showDimensions={showDimensions}
                showPath={showPath}
                highlightedDemandKey={activeHighlightKey}
                selectedPieceIndex={selectedPieceIndex}
                onDropStagingPiece={handleDropStagingPiece}
                onMovePlacedPiece={handleMovePlacedPiece}
                onRotatePlacedPiece={handleRotatePlacedPiece}
                onRemovePlacedPiece={handleRemovePlacedPiece}
                onHoverDemandKey={setHoveredDemandKey}
                onSelectPiece={setSelectedPieceIndex}
                onCursorMove={setCursor}
                onCollisionNotice={(msg) => toast(msg, true)}
                boardRef={boardRef}
              />
            </div>

            {/* Minimal Floating Candidate Switcher Pills (only when candidates exist) */}
            {schemes2D.length > 0 && (
              <div ref={stripRef} className="scheme-strip" role="region" aria-label="候选方案切换">
                <div className="scheme-slots">
                  {schemes2D.map((s) => {
                    const isBest = schemes2D.length > 1 && s.utilizationPct === bestUtil2D;
                    const isSelected = activeScheme2D?.id === s.id;
                    return (
                      <div
                        key={s.id}
                        className={`scheme-slot ${isSelected ? 'on' : ''}`}
                        onClick={() => setActiveScheme2D(s.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setActiveScheme2D(s.id);
                          }
                        }}
                      >
                        <span className="scheme-slot-name" title={s.strategyName}>
                          {s.strategyName}
                        </span>
                        <span className="scheme-slot-stat num">
                          <b>{s.utilizationPct}%</b> · {fmtN(s.occupiedLengthMm, 0)}mm
                        </span>
                        {isBest && <span className="tag ok">最优</span>}
                        {s.confirmedSchemeId && <span className="tag run">已选定</span>}
                        <button
                          type="button"
                          className="scheme-del"
                          aria-label={`删除候选方案 ${s.strategyName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeScheme2D(s.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="wb-tiny-ghost" onClick={clearSchemes2D}>
                  清空
                </button>
              </div>
            )}
          </section>
        ) : (
          /* 1D Slitting Center View */
          <section ref={stripRef as any} className="pane" style={{ background: 'var(--bg)' }}>
            <div className="body" style={{ overflowY: 'auto' }}>
              {slitSchemes.length === 0 ? (
                <div className="box" style={{ padding: 36, textAlign: 'center' }}>
                  <strong style={{ fontSize: 15 }}>一维定长分切</strong>
                  <p className="muted num" style={{ maxWidth: 460, margin: '8px auto 16px', fontSize: 12.5 }}>
                    {slitMaterialMode === 'VIRTUAL_ROLL'
                      ? `新母卷 ${slitMotherWidthMm} mm`
                      : `实卷 ${currentRoll1D?.rollId || ''} (${currentRoll1D?.width || slitMotherWidthMm} mm)`}{' '}
                    · 定长 {slitFixedLengthMm} mm · 待排 {slitOrders.length} 项共 {totalRolls1D} 卷
                  </p>
                  <button type="button" className="btn pri" onClick={handleRunSolve1D}>
                    开始排版
                  </button>
                </div>
              ) : (
                <>
                  {savedCars1D > 0 && (
                    <div className="roi-banner num">
                      <span className="tag ok">省车收益</span>
                      <span>较逐规格独立分切减少 <b>{savedCars1D} 车</b> 上机排刀</span>
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
                          刀组排布（{activeScheme1D.patterns.length} 组 · {activeScheme1D.totalCars} 车）
                        </span>
                        <span className="sp" />
                        <button type="button" className="btn sm" onClick={handleQuickExportExcel1D}>
                          导出 Excel
                        </button>
                      </div>
                      <div className="slit-patterns-list">
                        {activeScheme1D.patterns.map((p, idx) => (
                          <div key={p.id} className="slit-pattern-row">
                            <div className="slit-pattern-meta">
                              <span className="tag kind">组 {idx + 1}</span>
                              <b className="num">{p.repetitions} 车</b>
                              <span className="num">
                                {p.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + ')}
                              </span>
                              <span className="sp" />
                              <span className="num muted">
                                已切 {p.usedWidthMm} mm · 余 {p.spareWidthMm} mm
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
                          <div className="sec">实卷避疵车次 ({currentRoll1D?.rollId})</div>
                          <table className="t" style={{ marginTop: 6 }}>
                            <thead>
                              <tr>
                                <th>车次</th>
                                <th className="r">母卷区间 mm</th>
                                <th>排刀组合</th>
                                <th>状态</th>
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
                                      <span className="tag warn">跳段避疵</span>
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

        {/* ==================== RIGHT COLUMN: 方案 ==================== */}
        <section ref={rightPaneRef} className="pane studio-right">
          <div className="pane-h">
            <span>方案</span>
            <span className="sp" />
            {is2D && schemes2D.length > 0 && (
              <span className="tag kind num">{schemes2D.length} 套</span>
            )}
          </div>

          <div className="pane-b">
            {/* Post-Confirm Continuation Banner */}
            {lastConfirmSummary && (
              <div className="wb-confirm-banner">
                <div>
                  <span className="tag ok" style={{ marginRight: 6 }}>
                    已落库
                  </span>
                  <b className="num">{lastConfirmSummary.schemeId}</b>
                </div>
                <div>
                  {lastConfirmSummary.openRemaining > 0
                    ? `剩余 ${lastConfirmSummary.openRemaining} 件待排，可继续排下一卷`
                    : '当前需求族待排量已全部排齐'}
                </div>
                <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                  <a
                    className="btn sm pri"
                    style={{ flex: 1, justifyContent: 'center' }}
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
                      继续排
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Active Candidate Decision Card */}
            {is2D && activeScheme2D ? (
              <div className="value-hero-panel">
                <div className="value-hero-head">
                  <div className="value-hero-title">{activeScheme2D.strategyName}</div>
                  <span className={`tag ${activeScheme2D.complete ? 'ok' : 'kind'}`}>
                    {activeScheme2D.complete ? '齐套' : '部分排入'}
                  </span>
                </div>

                <div className="value-kpi-grid num">
                  <div className="value-kpi-cell highlight">
                    <small>利用率</small>
                    <b>
                      {activeScheme2D.utilizationPct}
                      <em>%</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>实占长度</small>
                    <b>
                      {fmtN(activeScheme2D.occupiedLengthMm, 1)}
                      <em>mm</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>已排件数</small>
                    <b>
                      {activeScheme2D.placedCount}
                      <em>/ {activeScheme2D.requestedCount}</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>母卷</small>
                    <b style={{ fontSize: 12.5 }}>
                      {activeScheme2D.canvasMode === 'FREE_CANVAS'
                        ? `W${activeScheme2D.widthMm}`
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
                      ? '正在保存并扣减…'
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
                      导出 DXF
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => handleQuickExportCam('nc')}
                    >
                      导出 G-Code
                    </button>
                  </div>
                </div>
              </div>
            ) : !is2D && activeScheme1D && activeScheme1D.state === 'SUCCEEDED' ? (
              <div className="value-hero-panel">
                <div className="value-hero-head">
                  <div className="value-hero-title">{activeScheme1D.strategyName}</div>
                  <span className="tag ok">已验证</span>
                </div>

                <div className="value-kpi-grid num">
                  <div className="value-kpi-cell highlight">
                    <small>利用率</small>
                    <b>
                      {activeScheme1D.avgUtilizationPct}
                      <em>%</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>排产车数</small>
                    <b>
                      {activeScheme1D.totalCars}
                      <em>车</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>缺口 / 超产</small>
                    <b>
                      {activeScheme1D.missingRolls}/{activeScheme1D.overproducedRolls}
                      <em>卷</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>母卷</small>
                    <b style={{ fontSize: 12.5 }}>
                      {slitMaterialMode === 'VIRTUAL_ROLL'
                        ? `W${activeScheme1D.motherWidthMm}`
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
                      ? '正在保存并扣减…'
                      : activeScheme1D.confirmedSchemeId
                      ? `已选定 (${activeScheme1D.confirmedSchemeId}) · 查看结果`
                      : '选定此方案（扣减需求并保存结果）'}
                  </button>
                </div>
              </div>
            ) : null}

            {/* Live Solve Progress Strip (also persists failure/empty feedback after solving stops) */}
            {is2D &&
              strategyRuns2D.length > 0 &&
              (runningSolve ||
                (!activeScheme2D &&
                  strategyRuns2D.some(
                    (r) => r.state === 'FAILED' || r.state === 'TIMED_OUT' || r.placedCount === 0
                  ))) && (
                <div className="wb-solve-progress">
                  {strategyRuns2D.map((r) => (
                    <div key={r.strategyId} className="wb-solve-progress-row">
                      <span className="wb-solve-progress-name">{r.strategyName}</span>
                      <span
                        className="wb-solve-progress-phase num"
                        style={
                          r.state === 'FAILED' || r.state === 'TIMED_OUT'
                            ? { color: '#dc2626' }
                            : undefined
                        }
                      >
                        {r.phaseText}
                      </span>
                    </div>
                  ))}
                </div>
              )}

            {/* 1D Full Solartron-Cut Parameter Config Section (always visible in 1D mode) */}
            {!is2D && (
              <div className="wb-right-section slit-cfg-card" id="wb-slitting-params">
                <div className="wb-right-section-head">
                  <span>一维搭切参数配置</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={openEngineSettings}
                    title="在系统设置中调整 NewSolver 全部参数"
                  >
                    高级设置 ↗
                  </button>
                </div>

                {/* Preset Loader & Saver */}
                <div className="slit-preset-row">
                  <select
                    className="field"
                    aria-label="一维幅宽预设"
                    value={selectedSlitPresetId}
                    onChange={(e) => handleApplySlitPreset(e.target.value)}
                  >
                    <option value="">套用幅宽预设…</option>
                    {slitPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setSavingPresetOpen((v) => !v)}
                  >
                    保存
                  </button>
                  {selectedSlitPresetId &&
                    !slitPresets.find((p) => p.id === selectedSlitPresetId)?.builtin && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={handleDeleteSelectedSlitPreset}
                        title="删除当前自定义预设"
                      >
                        删
                      </button>
                    )}
                </div>
                {savingPresetOpen && (
                  <div className="slit-preset-row">
                    <input
                      type="text"
                      className="field"
                      placeholder="输入预设名称（如：四线4600光学膜）"
                      value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSaveCurrentSlitPreset();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn sm pri"
                      onClick={handleSaveCurrentSlitPreset}
                    >
                      确认
                    </button>
                  </div>
                )}

                {/* Solver Profile Switcher (FAST / QUALITY) */}
                <div className="slit-profile-bar">
                  <div className="seg" role="group" aria-label="一维求解档位" style={{ flex: 1 }}>
                    <button
                      type="button"
                      className={slitProfile === 'FAST' ? 'on' : ''}
                      aria-pressed={slitProfile === 'FAST'}
                      onClick={() => setSlitSpec({ slitProfile: 'FAST' })}
                    >
                      快捷解 FAST
                    </button>
                    <button
                      type="button"
                      className={slitProfile === 'QUALITY' ? 'on' : ''}
                      aria-pressed={slitProfile === 'QUALITY'}
                      onClick={() => setSlitSpec({ slitProfile: 'QUALITY' })}
                    >
                      精确解 QUALITY
                    </button>
                  </div>
                  <label className="slit-both-toggle" title="同时运行 FAST 与 QUALITY 对比结果">
                    <input
                      type="checkbox"
                      checked={settings.slitRunBothProfiles}
                      onChange={(e) =>
                        updateStudioSettings({
                          ...settings,
                          slitRunBothProfiles: e.target.checked
                        })
                      }
                    />
                    <span>双档对比</span>
                  </label>
                </div>

                {/* Width Mode + Core Solartron-Cut Primary Inputs */}
                <div className="seg" role="group" aria-label="幅宽约束模式" style={{ width: '100%' }}>
                  <button
                    type="button"
                    className={slitWidthMode === 'FLEXIBLE' ? 'on' : ''}
                    onClick={() => setSlitSpec({ slitWidthMode: 'FLEXIBLE' })}
                  >
                    可变幅宽区间
                  </button>
                  <button
                    type="button"
                    className={slitWidthMode === 'FIXED' ? 'on' : ''}
                    onClick={() =>
                      setSlitSpec({ slitWidthMode: 'FIXED', slitMinWidthMm: slitMaxWidthMm })
                    }
                  >
                    固定组合宽
                  </button>
                </div>

                <div className="slit-cfg-grid">
                  <label className="slit-cfg-field">
                    <span>母卷总宽 (mm)</span>
                    <input
                      type="number"
                      min={500}
                      className="field num"
                      value={slitMotherWidthMm}
                      onChange={(e) => {
                        const w = Math.max(500, Number(e.target.value) || 500);
                        const usable = Math.max(100, w - slitLeftTrimMm - slitRightTrimMm);
                        setSlitSpec({
                          slitMotherWidthMm: w,
                          slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                          slitMinWidthMm:
                            slitWidthMode === 'FIXED'
                              ? Math.min(slitMaxWidthMm, usable)
                              : Math.min(slitMinWidthMm, usable)
                        });
                      }}
                    />
                  </label>
                  <label className="slit-cfg-field">
                    <span>超产上限 (卷)</span>
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      className="field num"
                      value={slitOverCap}
                      onChange={(e) =>
                        setSlitSpec({ slitOverCap: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                  </label>
                  <label className="slit-cfg-field">
                    <span>左切边 (mm)</span>
                    <input
                      type="number"
                      min={0}
                      className="field num"
                      value={slitLeftTrimMm}
                      onChange={(e) => {
                        const lt = Math.max(0, Number(e.target.value) || 0);
                        const usable = Math.max(100, slitMotherWidthMm - lt - slitRightTrimMm);
                        setSlitSpec({
                          slitLeftTrimMm: lt,
                          slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                          slitMinWidthMm: Math.min(slitMinWidthMm, usable)
                        });
                      }}
                    />
                  </label>
                  <label className="slit-cfg-field">
                    <span>右切边 (mm)</span>
                    <input
                      type="number"
                      min={0}
                      className="field num"
                      value={slitRightTrimMm}
                      onChange={(e) => {
                        const rt = Math.max(0, Number(e.target.value) || 0);
                        const usable = Math.max(100, slitMotherWidthMm - slitLeftTrimMm - rt);
                        setSlitSpec({
                          slitRightTrimMm: rt,
                          slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                          slitMinWidthMm: Math.min(slitMinWidthMm, usable)
                        });
                      }}
                    />
                  </label>
                  {slitWidthMode === 'FLEXIBLE' ? (
                    <>
                      <label className="slit-cfg-field">
                        <span>最小组合宽 (mm)</span>
                        <input
                          type="number"
                          min={100}
                          className="field num"
                          value={slitMinWidthMm}
                          onChange={(e) =>
                            setSlitSpec({
                              slitMinWidthMm: Math.max(100, Number(e.target.value) || 100)
                            })
                          }
                        />
                      </label>
                      <label className="slit-cfg-field">
                        <span>最大组合宽 (mm)</span>
                        <input
                          type="number"
                          min={100}
                          className="field num"
                          value={slitMaxWidthMm}
                          onChange={(e) =>
                            setSlitSpec({
                              slitMaxWidthMm: Math.max(100, Number(e.target.value) || 100)
                            })
                          }
                        />
                      </label>
                      <label className="slit-cfg-field">
                        <span>幅宽步长 (mm)</span>
                        <input
                          type="number"
                          min={1}
                          className="field num"
                          value={slitWidthStepMm}
                          onChange={(e) =>
                            setSlitSpec({
                              slitWidthStepMm: Math.max(1, Number(e.target.value) || 10)
                            })
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <label className="slit-cfg-field span-2">
                      <span>固定组合宽 (mm)</span>
                      <input
                        type="number"
                        min={100}
                        className="field num"
                        value={slitMaxWidthMm}
                        onChange={(e) => {
                          const v = Math.max(100, Number(e.target.value) || 100);
                          setSlitSpec({ slitMaxWidthMm: v, slitMinWidthMm: v });
                        }}
                      />
                    </label>
                  )}
                  <label className="slit-cfg-field">
                    <span>求解时限 (秒)</span>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      className="field num"
                      value={settings.slitTimeLimitSeconds}
                      onChange={(e) =>
                        updateStudioSettings({
                          ...settings,
                          slitTimeLimitSeconds: Math.min(
                            180,
                            Math.max(1, Number(e.target.value) || 30)
                          )
                        })
                      }
                    />
                  </label>
                </div>

                <div className="slit-cfg-summary num">
                  可切净宽 <b>{Math.max(0, slitMotherWidthMm - slitLeftTrimMm - slitRightTrimMm)}</b>{' '}
                  mm · 候选宽{' '}
                  <b>
                    {slitWidthMode === 'FIXED'
                      ? 1
                      : slitMaxWidthMm >= slitMinWidthMm
                      ? Math.floor((slitMaxWidthMm - slitMinWidthMm) / Math.max(1, slitWidthStepMm)) + 1
                      : 0}
                  </b>{' '}
                  档
                </div>

                {/* Collapsible Solartron-Cut NewSolver Advanced Parameters */}
                <details className="slit-adv-fold">
                  <summary className="num">
                    NewSolver 参数：TopK {settings.slitTopK} · 迭代 {settings.slitMaxIterations} ·
                    花型 {settings.slitMaxPatterns} · 宽幅≤
                    {slitProfile === 'QUALITY'
                      ? Math.max(settings.slitMaxDistinctWidths, 5)
                      : settings.slitMaxDistinctWidths}
                  </summary>
                  <div className="slit-cfg-grid" style={{ marginTop: 6 }}>
                    <label className="slit-cfg-field">
                      <span>TOP K 超产</span>
                      <input
                        type="number"
                        min={0}
                        max={50}
                        className="field num"
                        value={settings.slitTopK}
                        onChange={(e) =>
                          updateStudioSettings({
                            ...settings,
                            slitTopK: Math.min(50, Math.max(0, Number(e.target.value) || 0))
                          })
                        }
                      />
                    </label>
                    <label className="slit-cfg-field">
                      <span>列生成迭代</span>
                      <input
                        type="number"
                        min={1}
                        max={5000}
                        step={10}
                        className="field num"
                        value={settings.slitMaxIterations}
                        onChange={(e) =>
                          updateStudioSettings({
                            ...settings,
                            slitMaxIterations: Math.min(
                              5000,
                              Math.max(1, Number(e.target.value) || 300)
                            )
                          })
                        }
                      />
                    </label>
                    <label className="slit-cfg-field">
                      <span>最大花型池</span>
                      <input
                        type="number"
                        min={1}
                        max={20000}
                        step={50}
                        className="field num"
                        value={settings.slitMaxPatterns}
                        onChange={(e) =>
                          updateStudioSettings({
                            ...settings,
                            slitMaxPatterns: Math.min(
                              20000,
                              Math.max(1, Number(e.target.value) || 800)
                            )
                          })
                        }
                      />
                    </label>
                    <label className="slit-cfg-field">
                      <span>不同宽幅上限</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        className="field num"
                        value={settings.slitMaxDistinctWidths}
                        onChange={(e) =>
                          updateStudioSettings({
                            ...settings,
                            slitMaxDistinctWidths: Math.min(
                              20,
                              Math.max(1, Number(e.target.value) || 4)
                            )
                          })
                        }
                      />
                    </label>
                    <label className="slit-cfg-field span-2">
                      <span>MIP 单阶段安全时限 (ms)</span>
                      <input
                        type="number"
                        min={1000}
                        max={600000}
                        step={1000}
                        className="field num"
                        value={settings.slitStageTimeLimitMs}
                        onChange={(e) =>
                          updateStudioSettings({
                            ...settings,
                            slitStageTimeLimitMs: Math.min(
                              600000,
                              Math.max(1000, Number(e.target.value) || 120000)
                            )
                          })
                        }
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}

            {/* Clean Solving Goal Selector */}
            <div className="wb-right-section">
              <div className="wb-right-section-head">
                <span>求解目标</span>
              </div>
              <div className="wb-goal-list">
                {is2D ? (
                  SCENARIOS_2D.map((sc) => {
                    const disabled = sc.id === 'MULTI_WIDTH' && canvasMode !== 'FREE_CANVAS';
                    return (
                      <label
                        key={sc.id}
                        className="wb-goal-item"
                        style={disabled ? { opacity: 0.5 } : undefined}
                      >
                        <input
                          type="radio"
                          name="scenario2d"
                          disabled={disabled}
                          checked={scenario2D === sc.id}
                          onChange={() => setScenario2D(sc.id)}
                        />
                        <div className="wb-goal-body">
                          <div className="wb-goal-title">{sc.label}</div>
                          <div className="wb-goal-desc">{sc.desc}</div>
                        </div>
                      </label>
                    );
                  })
                ) : (
                  <>
                    <label className="wb-goal-item">
                      <input
                        type="radio"
                        name="scenario1d"
                        checked={scenario1D === 'MIN_CARS'}
                        onChange={() => setScenario1D('MIN_CARS')}
                      />
                      <div className="wb-goal-body">
                        <div className="wb-goal-title">最少换刀车数</div>
                        <div className="wb-goal-desc">控制超产上限，减少上机换刀次数</div>
                      </div>
                    </label>
                    <label className="wb-goal-item">
                      <input
                        type="radio"
                        name="scenario1d"
                        checked={scenario1D === 'MAX_UTIL'}
                        onChange={() => setScenario1D('MAX_UTIL')}
                      />
                      <div className="wb-goal-body">
                        <div className="wb-goal-title">最高幅宽利用率</div>
                        <div className="wb-goal-desc">适度放宽超产以减少窄边余料</div>
                      </div>
                    </label>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Sticky Bottom-Right Primary Action Bar */}
          <div className="studio-right-foot">
            <div className="studio-right-foot-meta num">
              <span>
                待排{' '}
                <b>
                  {overviewStats.uncut > 0 ? overviewStats.uncut : overviewStats.ordered}
                  {overviewStats.unit}
                </b>{' '}
                · W
                {is2D
                  ? effectiveRollWidthMm
                  : slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
                  ? currentRoll1D.width
                  : slitMotherWidthMm}
              </span>
              {is2D ? (
                <button
                  type="button"
                  className="wb-algo-config-link"
                  onClick={openEngineSettings}
                >
                  已启 {activeAlgos.length} 算法 · 配置
                </button>
              ) : (
                <button
                  type="button"
                  className="wb-algo-config-link"
                  onClick={openEngineSettings}
                >
                  {settings.slitRunBothProfiles ? '快/精双档' : slitProfile} · 高级参数
                </button>
              )}
            </div>
            <div className="studio-right-foot-btns">
              {runningSolve && (
                <button type="button" className="btn" onClick={handleStopSolve}>
                  停止
                </button>
              )}
              <button
                type="button"
                className="btn pri studio-solve-btn"
                style={{ flex: 1 }}
                disabled={runningSolve}
                onClick={is2D ? handleRunSolve2D : handleRunSolve1D}
              >
                {runningSolve ? '正在排版…' : '开始排版'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Concrete Demand Overview & Spec Editor Modal ("本次具体需求概览") */}
      <ModalDialog
        open={overviewModalOpen}
        title={`本次具体需求概览 · ${
          (is2D ? loadedTaskName : slitLoadedTaskName) || '当前排程批次'
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
              物料品号：<b>{is2D ? materialModel2D : slitMaterialModel}</b> · 净面积：{' '}
              <b>{fmtN(overviewStats.totalAreaM2, 2)} m²</b>
            </div>
          </div>

          {overviewTab === 'progress' ? (
            <>
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
                          <td className="r num" style={{ color: '#4338ca', fontWeight: 600 }}>
                            {r.planned}
                          </td>
                          <td className="r num" style={{ color: '#5b61f6' }}>
                            {r.cand > 0 ? `+${r.cand}` : '—'}
                          </td>
                          <td
                            className="r num"
                            style={{
                              color: r.uncut > 0 ? '#52525b' : 'var(--ok)',
                              fontWeight: 650
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
                  调整待切余量、规格尺寸或新增部件（异形轮廓尺寸由 CAD 顶点锁定）
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
