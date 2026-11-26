import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandFamilySummary,
  Scenario1DType,
  Scenario2DType,
  WorkbenchLaunchPreset,
  expandClusterToDemands
} from '../store/useStudioStore';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { NumberInput } from '../components/ui/NumberInput';
import { requestJSON, toast, fmtN, fmtM, loadSheetLib } from '../lib/core/util.js';
import {
  parseDemandSheet,
  parseDemandJSON,
  importGroups,
  demandTemplateCsv
} from '../lib/domain/demand-import-model.js';
import { parseDxfGarmentText } from '../lib/nesting/dxf-garment-samples.js';
import '../styles/theme-demand-create.css';

type DimensionKey = 'RECT_2D' | 'CONTOUR_2D' | 'SLITTING_1D';
type DirectionMode = 'FIXED' | 'ROTATE_90' | 'HALF_180';

interface DraftLine {
  name: string;
  width: number;
  length: number;
  quantity: number;
  allowRotation: boolean;
  allowHalfTurn?: boolean;
  sizeLabel?: string;
  sourceTemplateId?: string;
  shape?: any;
}

interface ParsedFileContext {
  fileName: string;
  groups: any[];
  groupIndex: number;
}

const CREATE_DIM_OPTIONS: SegmentedOption<DimensionKey>[] = [
  { value: 'RECT_2D', label: '二维矩形' },
  { value: 'CONTOUR_2D', label: '二维异形' },
  { value: 'SLITTING_1D', label: '一维分条' }
];

const QUICK_WIDTHS_2D = [1220, 1500, 1650, 1800, 2000];

const GOALS_2D: { id: Scenario2DType; title: string; sub: string }[] = [
  { id: 'SHORTEN_KIT', title: '齐套最短版长', sub: '全数排入并压紧用料长度' },
  { id: 'SHORTEN_GAP_FILL', title: '齐套 + 空隙补片', sub: '齐套后在空隙自动填补备片' },
  { id: 'FIXED_BED', title: '定长台板装入', sub: '按设定版长装入最大面积' },
  { id: 'MULTI_WIDTH', title: '多门幅阶梯比选', sub: '虚拟卷横向对比多门幅单耗' }
];

const GOALS_1D: { id: Scenario1DType; title: string; sub: string }[] = [
  { id: 'MIN_CARS', title: '最少出车换刀', sub: '严格控超产，减少换刀次数' },
  { id: 'MAX_UTIL', title: '最高母卷利用率', sub: '适度放宽备库超产压废边' }
];

const createDefaultDraftLines = (): DraftLine[] => [
  {
    name: '主规格 #1',
    width: 800,
    length: 1200,
    quantity: 10,
    allowRotation: false,
    allowHalfTurn: false
  },
  {
    name: '配片 #2',
    width: 450,
    length: 600,
    quantity: 10,
    allowRotation: true,
    allowHalfTurn: false
  }
];

function getDirectionMode(ln: DraftLine): DirectionMode {
  if (ln.allowRotation) return 'ROTATE_90';
  if (ln.allowHalfTurn) return 'HALF_180';
  return 'FIXED';
}

function applyDirectionMode(ln: DraftLine, mode: DirectionMode): DraftLine {
  if (mode === 'ROTATE_90') return { ...ln, allowRotation: true, allowHalfTurn: false };
  if (mode === 'HALF_180') return { ...ln, allowRotation: false, allowHalfTurn: true };
  return { ...ln, allowRotation: false, allowHalfTurn: false };
}

function estimatePolygonArea(vertices: any[]): number {
  if (!Array.isArray(vertices) || vertices.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const ax = Number(a?.x ?? a?.[0] ?? 0);
    const ay = Number(a?.y ?? a?.[1] ?? 0);
    const bx = Number(b?.x ?? b?.[0] ?? 0);
    const by = Number(b?.y ?? b?.[1] ?? 0);
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) * 0.5;
}

const PieceSilhouetteSvg: React.FC<{ line: DraftLine; is1D: boolean; oversize: boolean }> = ({
  line,
  is1D,
  oversize
}) => {
  const stroke = oversize ? '#e11d48' : '#5b61f6';
  const fill = oversize ? 'rgba(225, 29, 72, 0.12)' : 'rgba(91, 97, 246, 0.12)';
  const verts = line.shape?.type === 'POLYGON' ? line.shape?.vertices : null;

  if (!is1D && Array.isArray(verts) && verts.length >= 3) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const pts = verts.map((p: any) => {
      const x = Number(p?.x ?? p?.[0] ?? 0);
      const y = Number(p?.y ?? p?.[1] ?? 0);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return [x, y];
    });
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const scale = Math.min(82 / bw, 42 / bh);
    const ox = (92 - bw * scale) / 2;
    const oy = (46 - bh * scale) / 2;
    const polyPts = pts
      .map(([x, y]) => `${(ox + (x - minX) * scale).toFixed(1)},${(oy + (y - minY) * scale).toFixed(1)}`)
      .join(' ');
    return (
      <svg viewBox="0 0 92 46" width="92" height="46" aria-hidden="true">
        <polygon points={polyPts} fill={fill} stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }

  const w = Math.max(1, Number(line.width) || 100);
  const h = is1D ? Math.max(1, Math.min(w * 2.2, 1600)) : Math.max(1, Number(line.length) || 100);
  const scale = Math.min(80 / w, 40 / h);
  const rw = Math.max(12, w * scale);
  const rh = Math.max(10, h * scale);
  const rx = (92 - rw) / 2;
  const ry = (46 - rh) / 2;

  return (
    <svg viewBox="0 0 92 46" width="92" height="46" aria-hidden="true">
      <rect
        x={rx}
        y={ry}
        width={rw}
        height={rh}
        rx="2"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.4"
      />
      {is1D && (
        <path
          d={`M ${rx + rw * 0.25} ${ry} V ${ry + rh} M ${rx + rw * 0.75} ${ry} V ${ry + rh}`}
          stroke={stroke}
          strokeOpacity="0.45"
          strokeDasharray="2 2"
          strokeWidth="1"
        />
      )}
    </svg>
  );
};

export const DemandCreatePage: React.FC<{ appendTaskId?: string }> = ({ appendTaskId }) => {
  const {
    clusters,
    settings,
    syncTemplatesFromServer,
    loadDemandFamilyIntoWorkbench
  } = useStudioStore();

  const [families, setFamilies] = useState<DemandFamilySummary[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);

  // Core Demand Metadata & Lines
  const [createDim, setCreateDim] = useState<DimensionKey>('RECT_2D');
  const [mergeTargetId, setMergeTargetId] = useState<string>(appendTaskId || '');
  const [familyName, setFamilyName] = useState('');
  const [materialModel, setMaterialModel] = useState('TC涤棉-B2026');
  const [externalRef, setExternalRef] = useState('');
  // 生产排产主数据：交期、优先级、客户/齐套组、缸号色号防色差约束、指定机台/班组
  const [priority, setPriority] = useState<'NORMAL' | 'HIGH' | 'URGENT'>('NORMAL');
  const [dueDate, setDueDate] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [kittingGroup, setKittingGroup] = useState('');
  const [requiredBatchNo, setRequiredBatchNo] = useState('');
  const [requiredColor, setRequiredColor] = useState('');
  const [strictBatchMatch, setStrictBatchMatch] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [shiftTeam, setShiftTeam] = useState('');
  const [templateQuickId, setTemplateQuickId] = useState('');
  const [templateQuickSets, setTemplateQuickSets] = useState(2);
  const [draftLines, setDraftLines] = useState<DraftLine[]>(createDefaultDraftLines);
  const [isPristineDraft, setIsPristineDraft] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Drag & Drop File Recognition State
  const [isDragOver, setIsDragOver] = useState(false);
  const [parsedFile, setParsedFile] = useState<ParsedFileContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Pre-Scheduling Configuration (carried directly into CuttingWorkbenchPage!)
  const [canvasMode2D, setCanvasMode2D] = useState<'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT'>(
    'FREE_CANVAS'
  );
  const [motherWidth2D, setMotherWidth2D] = useState(1650);
  const [bedLength2D, setBedLength2D] = useState(3200);
  const [selectedRollId2D, setSelectedRollId2D] = useState('');
  const [selectedRemnantId2D, setSelectedRemnantId2D] = useState('');
  const [scenario2D, setScenario2D] = useState<Scenario2DType>('SHORTEN_KIT');
  const [pieceGapMm, setPieceGapMm] = useState<number>(settings.pieceGapMm ?? 0);
  const [trimStartMm, setTrimStartMm] = useState<number>(settings.trimStartMm ?? 0);

  const [slitMode1D, setSlitMode1D] = useState<'VIRTUAL_ROLL' | 'STOCK_ROLL'>('VIRTUAL_ROLL');
  const [motherWidth1D, setMotherWidth1D] = useState(4600);
  const [fixedLen1D, setFixedLen1D] = useState(1350000);
  const [selectedRollId1D, setSelectedRollId1D] = useState('');
  const [leftTrim1D, setLeftTrim1D] = useState(100);
  const [rightTrim1D, setRightTrim1D] = useState(100);
  const [minWidth1D, setMinWidth1D] = useState(4300);
  const [maxWidth1D, setMaxWidth1D] = useState(4400);
  const [widthStep1D, setWidthStep1D] = useState(10);
  const [overCap1D, setOverCap1D] = useState(20);
  const [scenario1D, setScenario1D] = useState<Scenario1DType>('MIN_CARS');

  useEffect(() => {
    syncTemplatesFromServer();
    Promise.all([
      requestJSON('/api/v2/demand-pool').catch(() => []),
      requestJSON('/api/rolls').catch(() => []),
      requestJSON('/api/remnants').catch(() => [])
    ]).then(([poolData, rollData, remData]) => {
      const fams = Array.isArray(poolData) ? poolData : [];
      const rList = Array.isArray(rollData) ? rollData : [];
      const rmList = Array.isArray(remData) ? remData : [];
      setFamilies(fams);
      setRolls(rList);
      setRemnants(rmList);

      const passed = rList.filter(
        (r: any) =>
          (r.inspectionStatus === 'PASSED' || r.inspectionStatus === 'APPROVED') &&
          Number(r.currentRemainingLength) > 0
      );
      if (passed.length) {
        setSelectedRollId2D((prev) => prev || passed[0].rollId);
        setSelectedRollId1D((prev) => prev || passed[0].rollId);
      }
      const availRem = rmList.filter((rm: any) => rm.status === 'AVAILABLE');
      if (availRem.length) {
        setSelectedRemnantId2D((prev) => prev || availRem[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (!appendTaskId) {
      setMergeTargetId('');
      return;
    }
    const target = families.find((f) => f.id === appendTaskId);
    setMergeTargetId(appendTaskId);
    if (target) {
      setCreateDim(target.dimension);
      setMaterialModel(target.materialModel);
    }
  }, [appendTaskId, families]);

  const passedRolls = useMemo(
    () =>
      rolls.filter(
        (r) =>
          (r.inspectionStatus === 'PASSED' || r.inspectionStatus === 'APPROVED') &&
          Number(r.currentRemainingLength) > 0
      ),
    [rolls]
  );

  const availableRemnants = useMemo(
    () => remnants.filter((rm) => rm.status === 'AVAILABLE'),
    [remnants]
  );

  const materialOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.rollModel && set.add(r.rollModel));
    clusters.forEach((c) => c.materialModel && set.add(c.materialModel));
    families.forEach((f) => f.materialModel && set.add(f.materialModel));
    return [...set].sort();
  }, [rolls, clusters, families]);

  const batchNoOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.batchNo && set.add(String(r.batchNo)));
    return [...set].sort();
  }, [rolls]);

  const colorOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.color && set.add(String(r.color)));
    return [...set].sort();
  }, [rolls]);

  const mergeTargetFamily = useMemo(
    () => families.find((f) => f.id === mergeTargetId) || null,
    [families, mergeTargetId]
  );

  const is1D = createDim === 'SLITTING_1D';

  const effectiveTargetWidthMm = useMemo(() => {
    if (is1D) {
      const r = passedRolls.find((x) => x.rollId === selectedRollId1D);
      const rawW = slitMode1D === 'STOCK_ROLL' && r ? Number(r.width) : motherWidth1D;
      return Math.max(100, rawW - leftTrim1D - rightTrim1D);
    }
    if (canvasMode2D === 'STOCK_ROLL') {
      const r = passedRolls.find((x) => x.rollId === selectedRollId2D);
      return Number(r?.width) || motherWidth2D;
    }
    if (canvasMode2D === 'REMNANT') {
      const rm = availableRemnants.find((x) => x.id === selectedRemnantId2D);
      return Number(rm?.width) || motherWidth2D;
    }
    return motherWidth2D;
  }, [
    is1D,
    slitMode1D,
    selectedRollId1D,
    motherWidth1D,
    leftTrim1D,
    rightTrim1D,
    canvasMode2D,
    selectedRollId2D,
    selectedRemnantId2D,
    motherWidth2D,
    passedRolls,
    availableRemnants
  ]);

  const isLineOversize = (ln: DraftLine) => {
    const w = Number(ln.width) || 0;
    const l = Number(ln.length) || 0;
    if (w <= 0) return false;
    if (is1D) return w > effectiveTargetWidthMm;
    if (ln.allowRotation) return Math.min(w, l) > effectiveTargetWidthMm;
    return w > effectiveTargetWidthMm;
  };

  const draftStats = useMemo(() => {
    let validCount = 0;
    let totalQty = 0;
    let areaMm2 = 0;
    let oversizeCount = 0;
    for (const ln of draftLines) {
      const len = is1D ? fixedLen1D : Number(ln.length) || 0;
      const w = Number(ln.width) || 0;
      const q = Number(ln.quantity) || 0;
      if (q > 0 && w > 0 && len > 0) {
        validCount += 1;
        totalQty += q;
        const unitArea =
          !is1D && ln.shape?.type === 'POLYGON' && Array.isArray(ln.shape?.vertices)
            ? estimatePolygonArea(ln.shape.vertices) || w * len
            : w * len;
        areaMm2 += unitArea * q;
        if (isLineOversize(ln)) oversizeCount += 1;
      }
    }
    return { validCount, totalQty, areaM2: areaMm2 / 1_000_000, oversizeCount };
  }, [draftLines, is1D, fixedLen1D, effectiveTargetWidthMm]);

  const applyParsedGroup = (fileName: string, groups: any[], index: number) => {
    const grp = groups[index];
    if (!grp?.demands?.length) return;
    const hasPoly = grp.demands.some((d: any) => d.shape?.type === 'POLYGON');
    const inferredDim: DimensionKey = /\.dxf$/i.test(fileName) || hasPoly ? 'CONTOUR_2D' : 'RECT_2D';
    const mapped: DraftLine[] = grp.demands.map((d: any, idx: number) => ({
      name: d.name || `识别规格 #${idx + 1}`,
      width: Number(d.width) || 0,
      length: Number(d.length) || 0,
      quantity: Math.max(1, Number(d.quantity || d.demand) || 1),
      allowRotation: Boolean(d.allowRotation),
      allowHalfTurn: Boolean(d.allowHalfTurn),
      shape: d.shape || undefined
    }));
    setCreateDim(inferredDim);
    if (!mergeTargetId) {
      setFamilyName(
        groups.length > 1
          ? `${fileName.replace(/\.[^.]+$/, '')} · 组${index + 1}`
          : `${fileName.replace(/\.[^.]+$/, '')}`
      );
      if (grp.materialModel) setMaterialModel(grp.materialModel);
      setExternalRef(`文件识别: ${fileName}`);
    }
    setDraftLines(mapped);
    setIsPristineDraft(false);
    setParsedFile({ fileName, groups, groupIndex: index });
  };

  const processImportedFile = async (file: File) => {
    try {
      let parsed: any;
      if (/\.json$/i.test(file.name)) {
        parsed = parseDemandJSON(JSON.parse(await file.text()));
      } else if (/\.dxf$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        if (!text.includes('Piece Name:') || text.includes('\uFFFD')) {
          try {
            text = new TextDecoder('gb18030').decode(buf);
          } catch {}
        }
        parsed = parseDxfGarmentText(text, file.name);
      } else {
        const XLSX = await loadSheetLib();
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sheet = book.Sheets[book.SheetNames[0]];
        parsed = parseDemandSheet(
          XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
        );
      }
      const groups = importGroups(parsed).filter((g: any) => (g.demands || []).length > 0);
      if (!groups.length) {
        throw new Error('文件中未解析到有效需求行，请检查列名（名称、宽度、长度、数量）');
      }
      applyParsedGroup(file.name, groups, 0);
      toast(`已识别「${file.name}」：共 ${groups[0].demands.length} 项规格`);
    } catch (err: any) {
      toast('文件识别失败：' + err.message, true);
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processImportedFile(file);
    e.target.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await processImportedFile(file);
  };

  const handleDownloadTemplateCsv = () => {
    const csv = demandTemplateCsv();
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'CutPlan-需求导入模板.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleAppendFromTemplate = () => {
    const tpl = clusters.find((c) => c.id === templateQuickId);
    if (!tpl) return;
    const sz = tpl.availableSizes[0];
    const mult = Math.max(1, templateQuickSets);
    let added: DraftLine[] = [];

    if (tpl.dimension === '1D') {
      if (!mergeTargetId) {
        setCreateDim('SLITTING_1D');
        setMaterialModel(tpl.materialModel);
      }
      setMotherWidth1D(tpl.defaultWidthMm);
      setFixedLen1D(tpl.defaultLengthMm);
      added = tpl.pieces.map((p) => {
        const g = Object.values(p.sizes)[0];
        return {
          name: p.name,
          width: g.w,
          length: g.h,
          quantity: p.quantityPerUnit * mult,
          allowRotation: false,
          allowHalfTurn: false,
          sourceTemplateId: tpl.id
        };
      });
    } else {
      const expanded = expandClusterToDemands(tpl, { [sz]: mult }, 1);
      if (!mergeTargetId) {
        if (expanded.some((d) => d.shape?.type === 'POLYGON')) {
          setCreateDim('CONTOUR_2D');
        }
        setMaterialModel(tpl.materialModel);
        if (!familyName.trim()) setFamilyName(`${tpl.name} (${sz}×${mult})`);
      }
      setMotherWidth2D(tpl.defaultWidthMm);
      setBedLength2D(Math.max(1600, tpl.defaultLengthMm));
      added = expanded.map((it) => ({
        name: it.name,
        width: it.width,
        length: it.length,
        quantity: it.quantity,
        allowRotation: it.allowRotation,
        allowHalfTurn: it.allowHalfTurn,
        sizeLabel: it.sizeLabel,
        sourceTemplateId: tpl.id,
        shape: it.shape
      }));
    }

    setDraftLines((prev) => (isPristineDraft ? added : [...prev, ...added]));
    setIsPristineDraft(false);
    toast(`已从模板「${tpl.name}」展开填入 ${added.length} 项规格`);
  };

  const handleReset = () => {
    setFamilyName('');
    setExternalRef('');
    setPriority('NORMAL');
    setDueDate('');
    setCustomerName('');
    setKittingGroup('');
    setRequiredBatchNo('');
    setRequiredColor('');
    setStrictBatchMatch(false);
    setMachineId('');
    setShiftTeam('');
    setTemplateQuickId('');
    setTemplateQuickSets(2);
    setParsedFile(null);
    setDraftLines(createDefaultDraftLines());
    setIsPristineDraft(true);
    if (!mergeTargetId) {
      setCreateDim('RECT_2D');
      setMaterialModel('TC涤棉-B2026');
    }
    toast('已重置本次需求内容');
  };

  const buildLaunchPreset = (): WorkbenchLaunchPreset => {
    if (is1D) {
      const usable = Math.max(100, motherWidth1D - leftTrim1D - rightTrim1D);
      const effMax = Math.min(usable, Math.max(100, maxWidth1D));
      const effMin = Math.min(effMax, Math.max(100, minWidth1D));
      return {
        slitMaterialMode: slitMode1D,
        slitMotherWidthMm: motherWidth1D,
        slitLeftTrimMm: leftTrim1D,
        slitRightTrimMm: rightTrim1D,
        slitMinWidthMm: effMin,
        slitMaxWidthMm: effMax,
        slitWidthStepMm: Math.max(1, widthStep1D),
        slitWidthMode: effMin === effMax ? 'FIXED' : 'FLEXIBLE',
        slitFixedLengthMm: fixedLen1D,
        slitRollId: selectedRollId1D,
        slitOverCap: overCap1D,
        scenario1D
      };
    }
    return {
      canvasMode: canvasMode2D,
      canvasWidthMm: motherWidth2D,
      canvasLengthMm: bedLength2D,
      selectedRollId: selectedRollId2D,
      selectedRemnantId: selectedRemnantId2D,
      pieceGapMm,
      trimStartMm,
      scenario2D
    };
  };

  const persistFamily = async (goWorkbench: boolean) => {
    const valid = draftLines.filter(
      (d) => d.quantity > 0 && d.width > 0 && (is1D ? fixedLen1D > 0 : d.length > 0)
    );
    if (!valid.length || submitting) {
      toast('请至少保留 1 行有效尺寸与数量', true);
      return;
    }
    setSubmitting(true);
    try {
      const saved: DemandFamilySummary = await requestJSON('/api/v2/demand-pool', {
        mergeIntoTaskId: mergeTargetId || undefined,
        name: familyName.trim() || `${materialModel} · 排程需求`,
        materialModel: materialModel.trim() || 'STANDARD-MAT',
        externalRef: externalRef.trim() || undefined,
        dueDate: dueDate.trim() || undefined,
        priority,
        customerName: customerName.trim() || undefined,
        kittingGroup: kittingGroup.trim() || undefined,
        requiredBatchNo: requiredBatchNo.trim() || undefined,
        requiredColor: requiredColor.trim() || undefined,
        strictBatchMatch: Boolean(strictBatchMatch),
        machineId: machineId.trim() || undefined,
        shiftTeam: shiftTeam.trim() || undefined,
        dimension: createDim,
        bedLengthMm: is1D ? fixedLen1D : bedLength2D,
        minWidthMm: is1D
          ? Math.min(
              Math.max(100, motherWidth1D - leftTrim1D - rightTrim1D),
              Math.max(100, minWidth1D)
            )
          : undefined,
        maxWidthMm: is1D
          ? Math.min(
              Math.max(200, motherWidth1D - leftTrim1D - rightTrim1D),
              Math.max(200, maxWidth1D)
            )
          : motherWidth2D,
        widthStepMm: is1D ? Math.max(1, widthStep1D) : undefined,
        leftTrimMm: is1D ? leftTrim1D : 0,
        rightTrimMm: is1D ? rightTrim1D : 0,
        totalOverCap: is1D ? overCap1D : 0,
        pieceGapMm: is1D ? 0 : pieceGapMm,
        trimStartMm: is1D ? 0 : trimStartMm,
        demands: valid.map((d, idx) => ({
          id: idx + 1,
          name: d.name || `规格 #${idx + 1}`,
          width: Number(d.width),
          length: is1D ? fixedLen1D : Number(d.length),
          quantity: Number(d.quantity),
          allowRotation: !is1D && Boolean(d.allowRotation),
          allowHalfTurn: !is1D && Boolean(d.allowHalfTurn),
          sizeLabel: d.sizeLabel || undefined,
          sourceTemplateId: d.sourceTemplateId || undefined,
          shape: d.shape || undefined
        }))
      });

      if (goWorkbench) {
        loadDemandFamilyIntoWorkbench(saved, buildLaunchPreset());
        toast(`已建档「${saved.name}」并携带排程配置进入工作台`);
        location.hash = '#/workbench';
      } else {
        toast(
          mergeTargetId
            ? `已向「${saved.name}」追加规格，当前共 ${saved.orderedTotal} 件/卷`
            : `已保存「${saved.name}」至需求库`
        );
        setFamilies((prev) => [saved, ...prev.filter((x) => x.id !== saved.id)]);
        setMergeTargetId('');
        setFamilyName('');
        setExternalRef('');
        setParsedFile(null);
      }
    } catch (err: any) {
      toast('保存需求失败：' + err.message, true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistFamily(true);
  };

  const unitLabel = is1D ? '卷' : createDim === 'CONTOUR_2D' ? '片' : '件';

  return (
    <div className="react-page">
      <form className="dc-page dc-create-form" onSubmit={handleFormSubmit}>
        <div className="dc-top-head">
          <div className="dc-top-title">
            <h1>需求管理</h1>
            <span className="dc-top-sub">
              拖拽识别文件、核对本次裁片并预选母卷工艺，一步进入搭切工作台
            </span>
          </div>
          <div className="dc-top-links">
            <a className="mp-ghost-btn" href="#/demand-library">
              历史需求库 ({families.length}) →
            </a>
            <a className="mp-ghost-btn" href="#/clusters">
              需求模板库
            </a>
          </div>
        </div>

        <div className="dc-split">
          {/* ==================== LEFT PANE: DROPZONE + METADATA + PRE-SCHEDULING CONFIG ==================== */}
          <section className="dc-pane" aria-label="文件识别与排程准备">
            <div className="dc-pane-body">
              {mergeTargetId && (
                <div className="dc-append-banner">
                  <span>
                    追加模式：<b>{mergeTargetFamily?.name || mergeTargetId}</b>
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setMergeTargetId('');
                      location.hash = '#/demands';
                    }}
                  >
                    切回新建
                  </button>
                </div>
              )}

              {/* 1. Drag-and-Drop File Recognition Area */}
              <div
                className={`dc-dropzone ${isDragOver ? 'is-dragover' : ''}`}
                role="button"
                tabIndex={0}
                aria-label="拖拽或点击上传 DXF、Excel、CSV 或 JSON 文件自动识别需求"
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setIsDragOver(false);
                  }
                }}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".dxf,.xlsx,.xls,.csv,.json"
                  hidden
                  onChange={handleFileInputChange}
                />
                <span className="dc-drop-ico" aria-hidden="true">
                  <svg viewBox="0 0 18 18" width="18" height="18">
                    <path
                      d="M9 12V3.5m0 0L5.8 6.7M9 3.5l3.2 3.2M3.2 12.2v1.6a1.4 1.4 0 0 0 1.4 1.4h8.8a1.4 1.4 0 0 0 1.4-1.4v-1.6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <div className="dc-drop-title">
                  {isDragOver ? '松开鼠标立即识别文件' : '拖拽文件到此自动识别，或点击上传'}
                </div>
                <div className="dc-drop-hint">
                  支持 CAD DXF 纸样、Excel (.xlsx/.xls)、CSV、JSON
                </div>
                {parsedFile && (
                  <div className="dc-file-pill" title={parsedFile.fileName}>
                    已识别：{parsedFile.fileName}
                  </div>
                )}
                <div
                  className="dc-drop-foot"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="mp-ghost-btn"
                    style={{ height: 24, fontSize: 11.5, padding: '0 8px' }}
                    onClick={handleDownloadTemplateCsv}
                  >
                    下载导入模板 CSV
                  </button>
                </div>
              </div>

              {/* 2. Basic Demand Info */}
              <div className="dc-sec">
                <div className="dc-sec-head">
                  <span className="dc-sec-title">需求信息</span>
                </div>

                <SegmentedControl
                  options={CREATE_DIM_OPTIONS}
                  value={createDim}
                  onChange={(next) => {
                    if (!mergeTargetId) setCreateDim(next);
                  }}
                  ariaLabel="选择裁切维度"
                  size="sm"
                  fullWidth
                />

                {!mergeTargetId && (
                  <>
                    <div className="dc-field">
                      <label htmlFor="dp-name">需求名称</label>
                      <input
                        id="dp-name"
                        className="field"
                        placeholder="如：11月卫衣排单 / MES-光学膜分条"
                        value={familyName}
                        onChange={(e) => setFamilyName(e.target.value)}
                      />
                    </div>
                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label htmlFor="dp-mat">物料品号</label>
                        <input
                          id="dp-mat"
                          list="dc-mat-list"
                          className="field num"
                          value={materialModel}
                          onChange={(e) => setMaterialModel(e.target.value)}
                        />
                        <datalist id="dc-mat-list">
                          {materialOptions.map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      </div>
                      <div className="dc-field">
                        <label htmlFor="dp-ext">
                          外部工单号 <small>选填</small>
                        </label>
                        <input
                          id="dp-ext"
                          className="field num"
                          placeholder="MES / ERP 单号"
                          value={externalRef}
                          onChange={(e) => setExternalRef(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label htmlFor="dp-priority">生产优先级</label>
                        <select
                          id="dp-priority"
                          className="field"
                          value={priority}
                          onChange={(e) =>
                            setPriority(e.target.value as 'NORMAL' | 'HIGH' | 'URGENT')
                          }
                        >
                          <option value="NORMAL">普通 (NORMAL)</option>
                          <option value="HIGH">高优 (HIGH)</option>
                          <option value="URGENT">加急 (URGENT)</option>
                        </select>
                      </div>
                      <div className="dc-field">
                        <label htmlFor="dp-duedate">
                          承诺交期 <small>选填</small>
                        </label>
                        <input
                          id="dp-duedate"
                          type="date"
                          className="field num"
                          value={dueDate}
                          onChange={(e) => setDueDate(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label htmlFor="dp-customer">
                          客户名称 <small>选填</small>
                        </label>
                        <input
                          id="dp-customer"
                          className="field"
                          placeholder="如：优衣库华东仓"
                          value={customerName}
                          onChange={(e) => setCustomerName(e.target.value)}
                        />
                      </div>
                      <div className="dc-field">
                        <label htmlFor="dp-kit">
                          齐套组 <small>选填</small>
                        </label>
                        <input
                          id="dp-kit"
                          className="field num"
                          placeholder="如：KIT-2026-W48"
                          value={kittingGroup}
                          onChange={(e) => setKittingGroup(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label htmlFor="dp-batch">
                          指定缸号 <small>防色差</small>
                        </label>
                        <input
                          id="dp-batch"
                          list="dc-batch-list"
                          className="field num"
                          placeholder="如：BAT-202609-A1"
                          value={requiredBatchNo}
                          onChange={(e) => setRequiredBatchNo(e.target.value)}
                        />
                        <datalist id="dc-batch-list">
                          {batchNoOptions.map((b) => (
                            <option key={b} value={b} />
                          ))}
                        </datalist>
                      </div>
                      <div className="dc-field">
                        <label htmlFor="dp-color">
                          指定色号 <small>选填</small>
                        </label>
                        <input
                          id="dp-color"
                          list="dc-color-list"
                          className="field"
                          placeholder="如：藏青"
                          value={requiredColor}
                          onChange={(e) => setRequiredColor(e.target.value)}
                        />
                        <datalist id="dc-color-list">
                          {colorOptions.map((c) => (
                            <option key={c} value={c} />
                          ))}
                        </datalist>
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label htmlFor="dp-machine">
                          指定机台 <small>选填</small>
                        </label>
                        <input
                          id="dp-machine"
                          className="field num"
                          placeholder="如：裁床-01"
                          value={machineId}
                          onChange={(e) => setMachineId(e.target.value)}
                        />
                      </div>
                      <div className="dc-field">
                        <label htmlFor="dp-shift">
                          指定班组 <small>选填</small>
                        </label>
                        <input
                          id="dp-shift"
                          className="field"
                          placeholder="如：甲班"
                          value={shiftTeam}
                          onChange={(e) => setShiftTeam(e.target.value)}
                        />
                      </div>
                    </div>

                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        background: strictBatchMatch
                          ? 'rgba(245, 158, 11, 0.12)'
                          : 'var(--panel-2, rgba(15,23,42,0.03))',
                        border: strictBatchMatch
                          ? '1px solid rgba(217, 119, 6, 0.45)'
                          : '1px solid var(--line-2, #e2e8f0)',
                        fontSize: 12,
                        cursor: 'pointer',
                        marginTop: 2
                      }}
                    >
                      <input
                        id="dp-strict-batch"
                        type="checkbox"
                        className="ux-switch"
                        checked={strictBatchMatch}
                        onChange={(e) => setStrictBatchMatch(e.target.checked)}
                      />
                      <span>
                        <strong>同单同缸强约束</strong>
                        <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>
                          绑卷/选料强校验缸号色号防色差
                        </span>
                      </span>
                    </label>
                  </>
                )}

                <div className="dc-field">
                  <label>从需求模板库快捷展开</label>
                  <div className="dc-tpl-row">
                    <select
                      className="field"
                      value={templateQuickId}
                      onChange={(e) => setTemplateQuickId(e.target.value)}
                    >
                      <option value="">选择模板快速填入…</option>
                      {clusters.map((c) => (
                        <option key={c.id} value={c.id}>
                          [{c.dimension}] {c.name}
                        </option>
                      ))}
                    </select>
                    <NumberInput
                      min={1}
                      max={999}
                      fallback={1}
                      integer
                      className="field num dc-tpl-sets"
                      aria-label="套数"
                      value={templateQuickSets}
                      onValueChange={setTemplateQuickSets}
                    />
                    <button
                      type="button"
                      className="btn sm"
                      style={{ flex: 'none' }}
                      disabled={!templateQuickId}
                      onClick={handleAppendFromTemplate}
                    >
                      展开填入
                    </button>
                  </div>
                </div>
              </div>

              {/* 3. Pre-Scheduling Configuration (Decoupled from Workbench!) */}
              <div className="dc-sec">
                <div className="dc-sec-head">
                  <span className="dc-sec-title">排程前置配置</span>
                  <span style={{ fontSize: 11, color: 'var(--cp-ink-3)' }}>直带入工作台</span>
                </div>

                {!is1D ? (
                  <>
                    <SegmentedControl
                      options={[
                        { value: 'FREE_CANVAS', label: '默认新母卷' },
                        { value: 'STOCK_ROLL', label: `现有母卷 (${passedRolls.length})` },
                        { value: 'REMNANT', label: `在库料头 (${availableRemnants.length})` }
                      ]}
                      value={canvasMode2D}
                      onChange={(v) => setCanvasMode2D(v)}
                      ariaLabel="预选二维母卷来源"
                      size="sm"
                      fullWidth
                    />

                    {canvasMode2D === 'FREE_CANVAS' ? (
                      <>
                        <div className="dc-grid-2">
                          <div className="dc-field">
                            <label htmlFor="dc-w2d">
                              新母卷门幅 <small>mm</small>
                            </label>
                            <NumberInput
                              id="dc-w2d"
                              min={200}
                              fallback={1650}
                              className="field num"
                              value={motherWidth2D}
                              onValueChange={setMotherWidth2D}
                            />
                          </div>
                          <div className="dc-field">
                            <label htmlFor="dc-l2d">
                              版长上限 <small>mm</small>
                            </label>
                            <NumberInput
                              id="dc-l2d"
                              min={500}
                              fallback={2400}
                              className="field num"
                              value={bedLength2D}
                              onValueChange={setBedLength2D}
                            />
                          </div>
                        </div>
                        <div className="dc-width-chips">
                          {QUICK_WIDTHS_2D.map((w) => (
                            <button
                              key={w}
                              type="button"
                              className={`dc-chip-btn num ${motherWidth2D === w ? 'on' : ''}`}
                              onClick={() => setMotherWidth2D(w)}
                            >
                              {w}mm
                            </button>
                          ))}
                        </div>
                      </>
                    ) : canvasMode2D === 'STOCK_ROLL' ? (
                      <div className="dc-field">
                        <label>选择在库合格母卷</label>
                        <select
                          className="field num"
                          value={selectedRollId2D}
                          onChange={(e) => setSelectedRollId2D(e.target.value)}
                        >
                          {passedRolls.length === 0 ? (
                            <option value="">暂无可用合格母卷</option>
                          ) : (
                            passedRolls.map((r) => (
                              <option key={r.rollId} value={r.rollId}>
                                {r.rollId} · W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    ) : (
                      <div className="dc-field">
                        <label>选择在库可用料头</label>
                        <select
                          className="field num"
                          value={selectedRemnantId2D}
                          onChange={(e) => setSelectedRemnantId2D(e.target.value)}
                        >
                          {availableRemnants.length === 0 ? (
                            <option value="">暂无可用料头</option>
                          ) : (
                            availableRemnants.map((rm) => (
                              <option key={rm.id} value={rm.id}>
                                {rm.id} · {rm.width}×{rm.length}mm ({rm.materialBatch})
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    )}

                    <div className="dc-field">
                      <label>求解目标</label>
                      <div className="dc-goal-grid">
                        {GOALS_2D.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            className={`dc-goal-btn ${scenario2D === g.id ? 'on' : ''}`}
                            aria-pressed={scenario2D === g.id}
                            onClick={() => setScenario2D(g.id)}
                          >
                            <strong>{g.title}</strong>
                            <span>{g.sub}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label htmlFor="dc-gap">
                          裁片间距 <small>mm</small>
                        </label>
                        <NumberInput
                          id="dc-gap"
                          min={0}
                          max={50}
                          fallback={0}
                          className="field num"
                          value={pieceGapMm}
                          onValueChange={setPieceGapMm}
                        />
                      </div>
                      <div className="dc-field">
                        <label htmlFor="dc-trim">
                          首端切头 <small>mm</small>
                        </label>
                        <NumberInput
                          id="dc-trim"
                          min={0}
                          max={500}
                          fallback={0}
                          className="field num"
                          value={trimStartMm}
                          onValueChange={setTrimStartMm}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <SegmentedControl
                      options={[
                        { value: 'VIRTUAL_ROLL', label: '默认新母卷' },
                        { value: 'STOCK_ROLL', label: `现有母卷 (${passedRolls.length})` }
                      ]}
                      value={slitMode1D}
                      onChange={(v) => setSlitMode1D(v)}
                      ariaLabel="预选一维母卷来源"
                      size="sm"
                      fullWidth
                    />

                    {slitMode1D === 'STOCK_ROLL' && (
                      <div className="dc-field">
                        <label>选择实卷避疵分切</label>
                        <select
                          className="field num"
                          value={selectedRollId1D}
                          onChange={(e) => {
                            setSelectedRollId1D(e.target.value);
                            const r = passedRolls.find((x) => x.rollId === e.target.value);
                            if (r) setMotherWidth1D(Number(r.width) || 2000);
                          }}
                        >
                          {passedRolls.map((r) => (
                            <option key={r.rollId} value={r.rollId}>
                              {r.rollId} · W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label>
                          母卷幅宽 <small>mm</small>
                        </label>
                        <NumberInput
                          min={500}
                          fallback={2000}
                          className="field num"
                          value={motherWidth1D}
                          onValueChange={(w) => {
                            const usable = Math.max(100, w - leftTrim1D - rightTrim1D);
                            setMotherWidth1D(w);
                            setMaxWidth1D((prev) => Math.min(prev, usable));
                            setMinWidth1D((prev) => Math.min(prev, usable));
                          }}
                        />
                      </div>
                      <div className="dc-field">
                        <label>
                          定长卷长 <small>mm</small>
                        </label>
                        <NumberInput
                          min={100}
                          fallback={2000}
                          className="field num"
                          value={fixedLen1D}
                          onValueChange={setFixedLen1D}
                        />
                      </div>
                    </div>

                    <div className="dc-field">
                      <label>分切目标</label>
                      <div className="dc-goal-grid">
                        {GOALS_1D.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            className={`dc-goal-btn ${scenario1D === g.id ? 'on' : ''}`}
                            aria-pressed={scenario1D === g.id}
                            onClick={() => setScenario1D(g.id)}
                          >
                            <strong>{g.title}</strong>
                            <span>{g.sub}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label>
                          左/右修边 <small>mm</small>
                        </label>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <NumberInput
                            min={0}
                            fallback={0}
                            className="field num"
                            aria-label="左修边"
                            value={leftTrim1D}
                            onValueChange={(lt) => {
                              const usable = Math.max(100, motherWidth1D - lt - rightTrim1D);
                              setLeftTrim1D(lt);
                              setMaxWidth1D((prev) => Math.min(prev, usable));
                              setMinWidth1D((prev) => Math.min(prev, usable));
                            }}
                          />
                          <NumberInput
                            min={0}
                            fallback={0}
                            className="field num"
                            aria-label="右修边"
                            value={rightTrim1D}
                            onValueChange={(rt) => {
                              const usable = Math.max(100, motherWidth1D - leftTrim1D - rt);
                              setRightTrim1D(rt);
                              setMaxWidth1D((prev) => Math.min(prev, usable));
                              setMinWidth1D((prev) => Math.min(prev, usable));
                            }}
                          />
                        </div>
                      </div>
                      <div className="dc-field">
                        <label>
                          超产上限 <small>卷</small>
                        </label>
                        <NumberInput
                          min={0}
                          fallback={0}
                          integer
                          className="field num"
                          value={overCap1D}
                          onValueChange={setOverCap1D}
                        />
                      </div>
                    </div>

                    <div className="dc-grid-2">
                      <div className="dc-field">
                        <label>
                          最小 / 最大组合宽 <small>mm</small>
                        </label>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <NumberInput
                            min={100}
                            fallback={100}
                            className="field num"
                            aria-label="最小组合宽"
                            value={minWidth1D}
                            onValueChange={setMinWidth1D}
                          />
                          <NumberInput
                            min={100}
                            fallback={100}
                            className="field num"
                            aria-label="最大组合宽"
                            value={maxWidth1D}
                            onValueChange={setMaxWidth1D}
                          />
                        </div>
                      </div>
                      <div className="dc-field">
                        <label>
                          幅宽步长 <small>mm</small>
                        </label>
                        <NumberInput
                          min={1}
                          fallback={10}
                          className="field num"
                          value={widthStep1D}
                          onValueChange={setWidthStep1D}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>

          {/* ==================== RIGHT PANE: CURRENT DEMAND RECOGNITION & SPEC RESULT ==================== */}
          <section className="dc-pane" aria-label="本次需求识别结果与核对">
            <div className="dc-result-head">
              <div className="dc-result-title">
                <strong>本次需求结果</strong>
                <span className="dc-stat-pill num">
                  {draftStats.validCount} 项 · 共 {draftStats.totalQty} {unitLabel}
                </span>
                <span className="dc-stat-pill num">净面积 {draftStats.areaM2.toFixed(2)} m²</span>
                <span className="dc-stat-pill num">
                  目标幅宽 {effectiveTargetWidthMm} mm
                </span>
                {draftStats.oversizeCount > 0 && (
                  <span className="dc-stat-pill warn">
                    {draftStats.oversizeCount} 项超当前幅宽
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setIsPristineDraft(false);
                  setDraftLines((prev) => [
                    ...prev,
                    {
                      name: `规格 #${prev.length + 1}`,
                      width: is1D ? 400 : 500,
                      length: is1D ? fixedLen1D : 800,
                      quantity: 5,
                      allowRotation: false,
                      allowHalfTurn: false
                    }
                  ]);
                }}
              >
                ＋ 添加规格行
              </button>
            </div>

            {parsedFile && parsedFile.groups.length > 1 && (
              <div className="dc-group-bar">
                <span>
                  文件 <CodeBadge>{parsedFile.fileName}</CodeBadge> 识别出 {parsedFile.groups.length}{' '}
                  个分组：
                </span>
                {parsedFile.groups.map((g, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={`dc-chip-btn ${parsedFile.groupIndex === idx ? 'on' : ''}`}
                    onClick={() => applyParsedGroup(parsedFile.fileName, parsedFile.groups, idx)}
                  >
                    组 {idx + 1} · {g.materialModel || '默认'} ({g.demands.length}项)
                  </button>
                ))}
              </div>
            )}

            <div className="dc-result-scroll">
              {/* Visual Silhouette Gallery */}
              {draftLines.length > 0 && (
                <div className="dc-gallery-box">
                  <div className="dc-gallery-head">
                    <span>裁片 / 分条几何预览（按长宽比例呈现）</span>
                    <span className="num">{draftLines.length} 种规格</span>
                  </div>
                  <div className="dc-gallery-grid">
                    {draftLines.map((ln, idx) => {
                      const over = isLineOversize(ln);
                      return (
                        <div
                          key={idx}
                          className={`dc-piece-card ${over ? 'is-oversize' : ''}`}
                          title={over ? `宽度超过当前目标幅宽 ${effectiveTargetWidthMm} mm` : ln.name}
                        >
                          <div className="dc-piece-svg-wrap">
                            <PieceSilhouetteSvg line={ln} is1D={is1D} oversize={over} />
                          </div>
                          <div className="dc-piece-meta">
                            <span className="dc-piece-name">{ln.name || `规格 #${idx + 1}`}</span>
                            <span className="dc-piece-qty num">×{ln.quantity}</span>
                          </div>
                          <div className="dc-piece-dim num">
                            <span>
                              {fmtN(ln.width, 0)}×{fmtN(is1D ? fixedLen1D : ln.length, 0)}
                            </span>
                            {over && <span className="over-flag">超宽</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Full-Width Spec Editor Table */}
              <div className="dc-table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th style={{ width: 42 }}>#</th>
                      <th style={{ minWidth: 160 }}>规格 / 裁片名称</th>
                      <th style={{ width: 92 }}>形态</th>
                      <th style={{ width: 96 }} className="r">
                        宽 (mm)
                      </th>
                      {!is1D && (
                        <th style={{ width: 96 }} className="r">
                          长 (mm)
                        </th>
                      )}
                      <th style={{ width: 80 }} className="r">
                        数量 ({unitLabel})
                      </th>
                      {!is1D && <th style={{ width: 116 }}>方向规则</th>}
                      <th style={{ width: 42 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {draftLines.length === 0 ? (
                      <tr>
                        <td colSpan={is1D ? 6 : 8} className="empty" style={{ padding: 28 }}>
                          暂无规格行，请拖入文件识别、从模板展开或点击右上角「＋ 添加规格行」
                        </td>
                      </tr>
                    ) : (
                      draftLines.map((ln, idx) => {
                        const isPoly = ln.shape?.type === 'POLYGON';
                        const over = isLineOversize(ln);
                        return (
                          <tr key={idx}>
                            <td className="num" style={{ color: 'var(--cp-ink-3)' }}>
                              {idx + 1}
                            </td>
                            <td>
                              <input
                                className="dc-cell-in"
                                value={ln.name}
                                placeholder={`规格 #${idx + 1}`}
                                onChange={(e) => {
                                  setIsPristineDraft(false);
                                  const v = e.target.value;
                                  setDraftLines((p) =>
                                    p.map((x, i) => (i === idx ? { ...x, name: v } : x))
                                  );
                                }}
                              />
                            </td>
                            <td>
                              <span className={`tag ${isPoly ? 'run' : is1D ? 'kind' : 'ok'}`}>
                                {is1D
                                  ? '一维条'
                                  : isPoly
                                  ? `异形(${ln.shape.vertices?.length || 0}点)`
                                  : '矩形'}
                              </span>
                            </td>
                            <td>
                              <NumberInput
                                min={1}
                                className="dc-cell-in num-in"
                                style={over ? { borderColor: '#e11d48', color: '#be123c' } : undefined}
                                value={ln.width}
                                onValueChange={(v) => {
                                  setIsPristineDraft(false);
                                  setDraftLines((p) =>
                                    p.map((x, i) => (i === idx ? { ...x, width: v } : x))
                                  );
                                }}
                              />
                            </td>
                            {!is1D && (
                              <td>
                                <NumberInput
                                  min={1}
                                  className="dc-cell-in num-in"
                                  value={ln.length}
                                  onValueChange={(v) => {
                                    setIsPristineDraft(false);
                                    setDraftLines((p) =>
                                      p.map((x, i) => (i === idx ? { ...x, length: v } : x))
                                    );
                                  }}
                                />
                              </td>
                            )}
                            <td>
                              <NumberInput
                                min={1}
                                integer
                                className="dc-cell-in num-in"
                                value={ln.quantity}
                                onValueChange={(v) => {
                                  setIsPristineDraft(false);
                                  setDraftLines((p) =>
                                    p.map((x, i) => (i === idx ? { ...x, quantity: v } : x))
                                  );
                                }}
                              />
                            </td>
                            {!is1D && (
                              <td>
                                <select
                                  className="dc-cell-in"
                                  aria-label={`规格 ${idx + 1} 方向规则`}
                                  value={getDirectionMode(ln)}
                                  onChange={(e) => {
                                    setIsPristineDraft(false);
                                    const mode = e.target.value as DirectionMode;
                                    setDraftLines((p) =>
                                      p.map((x, i) =>
                                        i === idx ? applyDirectionMode(x, mode) : x
                                      )
                                    );
                                  }}
                                >
                                  <option value="FIXED">0° 经向</option>
                                  <option value="ROTATE_90">允许 90°</option>
                                  <option value="HALF_180">允许 180°</option>
                                </select>
                              </td>
                            )}
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="dc-del-btn"
                                title="删除此规格行"
                                aria-label={`删除规格 ${idx + 1}`}
                                onClick={() => {
                                  setIsPristineDraft(false);
                                  setDraftLines((p) => p.filter((_, i) => i !== idx));
                                }}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="dc-result-foot">
              <div className="dc-foot-left">
                <button type="button" className="mp-ghost-btn" onClick={handleReset}>
                  重置
                </button>
                <span className="num">
                  共 {draftStats.validCount} 项 · {draftStats.totalQty} {unitLabel} ·{' '}
                  {draftStats.areaM2.toFixed(2)} m²
                </span>
              </div>
              <div className="dc-foot-right">
                <button
                  type="button"
                  className="btn"
                  disabled={submitting || draftStats.validCount === 0}
                  onClick={() => persistFamily(false)}
                >
                  仅保存至需求库
                </button>
                <button
                  type="submit"
                  className="btn pri"
                  disabled={submitting || draftStats.validCount === 0}
                >
                  {submitting
                    ? '正在建档进入工作台…'
                    : mergeTargetId
                    ? '追加并去搭切排程 →'
                    : '保存并去搭切排程 →'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </form>
    </div>
  );
};
