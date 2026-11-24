import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandFamilySummary,
  expandClusterToDemands
} from '../store/useStudioStore';
import { ModalDialog } from '../components/ModalDialog';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { NumberInput } from '../components/ui/NumberInput';
import { requestJSON, toast, fmtN, shortId, loadSheetLib } from '@static/app/js/util.js';
import {
  parseDemandSheet,
  parseDemandJSON,
  importGroups
} from '@static/js/business/cutting/demand-import-model.js';
import { parseDxfGarmentText } from '@static/js/nesting/dxf-garment-samples.js';
import { demandTemplateCsv } from '@static/app/js/model/task-form.js';
import '../styles/theme-demand-split.css';

type DimensionKey = 'CONTOUR_2D' | 'RECT_2D' | 'SLITTING_1D';
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

const DIM_LABELS: Record<string, { text: string; fullText: string; cls: string; unit: string }> = {
  CONTOUR_2D: { text: '二维异形', fullText: '二维异形裁片', cls: 'run', unit: '片' },
  RECT_2D: { text: '二维矩形', fullText: '二维矩形开料', cls: 'ok', unit: '件' },
  SLITTING_1D: { text: '一维分条', fullText: '一维定长分条', cls: 'kind', unit: '卷' }
};

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  OPEN: { text: '待排程', cls: 'idle' },
  PARTIAL_PLANNED: { text: '部分已排', cls: 'run' },
  FULLY_PLANNED: { text: '已排待切', cls: 'warn' },
  COMPLETED: { text: '已齐套完结', cls: 'ok' }
};

const CREATE_DIM_OPTIONS: SegmentedOption<DimensionKey>[] = [
  { value: 'RECT_2D', label: '二维矩形' },
  { value: 'CONTOUR_2D', label: '二维异形' },
  { value: 'SLITTING_1D', label: '一维分条' }
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
  if (mode === 'ROTATE_90') {
    return { ...ln, allowRotation: true, allowHalfTurn: false };
  }
  if (mode === 'HALF_180') {
    return { ...ln, allowRotation: false, allowHalfTurn: true };
  }
  return { ...ln, allowRotation: false, allowHalfTurn: false };
}

export const DemandPoolPage: React.FC = () => {
  const {
    clusters,
    syncTemplatesFromServer,
    loadDemandFamilyIntoWorkbench,
    loadDemandFamiliesMergedIntoWorkbench
  } = useStudioStore();

  const [families, setFamilies] = useState<DemandFamilySummary[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Right Ledger Filter State
  const [search, setSearch] = useState('');
  const [dimFilter, setDimFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Left Inline Create / Append Workspace State
  const [createDim, setCreateDim] = useState<DimensionKey>('RECT_2D');
  const [mergeTargetId, setMergeTargetId] = useState<string>('');
  const [familyName, setFamilyName] = useState('');
  const [materialModel, setMaterialModel] = useState('TC涤棉-B2026');
  const [externalRef, setExternalRef] = useState('');
  const [motherWidthMm, setMotherWidthMm] = useState(2000);
  const [fixedLenMm, setFixedLenMm] = useState(2000);
  const [templateQuickId, setTemplateQuickId] = useState('');
  const [templateQuickSets, setTemplateQuickSets] = useState(2);
  const [draftLines, setDraftLines] = useState<DraftLine[]>(createDefaultDraftLines);
  const [isPristineDraft, setIsPristineDraft] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const createPaneRef = useRef<HTMLElement | null>(null);
  const createBodyRef = useRef<HTMLDivElement | null>(null);
  const firstSpecInputRef = useRef<HTMLInputElement | null>(null);

  // File Import Preview Modal State
  const [importPreview, setImportPreview] = useState<{
    fileName: string;
    groups: any[];
    groupIndex: number;
    mergeId: string;
    customName: string;
    customModel: string;
    dimension: DimensionKey;
  } | null>(null);

  const loadPool = async () => {
    setLoading(true);
    setError(null);
    try {
      const [poolData, rollData] = await Promise.all([
        requestJSON('/api/v2/demand-pool'),
        requestJSON('/api/rolls').catch(() => [])
      ]);
      const list = Array.isArray(poolData) ? poolData : [];
      setFamilies(list);
      setRolls(Array.isArray(rollData) ? rollData : []);
      if (!expandedId && list.length > 0) {
        setExpandedId(list[0].id);
      }
    } catch (err: any) {
      setError(err.message || '读取待排需求池失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPool();
    syncTemplatesFromServer();
  }, []);

  const materialOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.rollModel && set.add(r.rollModel));
    clusters.forEach((c) => c.materialModel && set.add(c.materialModel));
    families.forEach((f) => f.materialModel && set.add(f.materialModel));
    return [...set].sort();
  }, [rolls, clusters, families]);

  const mergeTargetFamily = useMemo(
    () => families.find((f) => f.id === mergeTargetId) || null,
    [families, mergeTargetId]
  );

  const openFamilyCount = useMemo(
    () => families.filter((f) => f.openTotal > 0).length,
    [families]
  );

  const filteredFamilies = useMemo(() => {
    const q = search.trim().toLowerCase();
    return families.filter((f) => {
      if (dimFilter !== 'ALL' && f.dimension !== dimFilter) return false;
      if (statusFilter === 'OPEN_ONLY' && f.openTotal <= 0) return false;
      if (
        ['OPEN', 'PARTIAL_PLANNED', 'FULLY_PLANNED', 'COMPLETED'].includes(statusFilter) &&
        f.status !== statusFilter
      ) {
        return false;
      }
      if (!q) return true;
      return `${f.name} ${f.materialModel} ${f.externalRef || ''} ${f.id}`
        .toLowerCase()
        .includes(q);
    });
  }, [families, dimFilter, statusFilter, search]);

  const checkedFamilies = useMemo(
    () => families.filter((f) => selectedIds.includes(f.id)),
    [families, selectedIds]
  );

  const draftSummary = useMemo(() => {
    const is1D = createDim === 'SLITTING_1D';
    let validCount = 0;
    let totalQty = 0;
    for (const ln of draftLines) {
      const lenOk = is1D ? fixedLenMm > 0 : ln.length > 0;
      if (ln.quantity > 0 && ln.width > 0 && lenOk) {
        validCount += 1;
        totalQty += Number(ln.quantity) || 0;
      }
    }
    return { validCount, totalQty };
  }, [draftLines, createDim, fixedLenMm]);

  const toggleSelectFamily = (fam: DemandFamilySummary) => {
    setSelectedIds((prev) => {
      if (prev.includes(fam.id)) return prev.filter((id) => id !== fam.id);
      if (prev.length > 0) {
        const first = families.find((x) => x.id === prev[0]);
        if (first) {
          const is1DFirst = first.dimension === 'SLITTING_1D';
          const is1DCur = fam.dimension === 'SLITTING_1D';
          if (is1DFirst !== is1DCur) {
            toast('一维定长分条与二维排料需求维度不同，不能勾选混排', true);
            return prev;
          }
        }
      }
      return [...prev, fam.id];
    });
  };

  const focusCreateWorkspace = () => {
    createBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    createPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    requestAnimationFrame(() => {
      firstSpecInputRef.current?.focus();
    });
  };

  const handleEnterAppendMode = (fam: DemandFamilySummary) => {
    setMergeTargetId(fam.id);
    setCreateDim(fam.dimension);
    setMaterialModel(fam.materialModel);
    if (draftLines.length === 0) {
      setDraftLines([
        {
          name: '追加规格 #1',
          width: 600,
          length: fam.dimension === 'SLITTING_1D' ? fixedLenMm : 1000,
          quantity: 10,
          allowRotation: false,
          allowHalfTurn: false
        }
      ]);
      setIsPristineDraft(false);
    }
    focusCreateWorkspace();
  };

  const handleExitAppendMode = () => {
    setMergeTargetId('');
  };

  const handleResetForm = () => {
    setFamilyName('');
    setExternalRef('');
    setTemplateQuickId('');
    setTemplateQuickSets(2);
    setDraftLines(createDefaultDraftLines());
    setIsPristineDraft(true);
    if (!mergeTargetId) {
      setCreateDim('RECT_2D');
      setMaterialModel('TC涤棉-B2026');
      setMotherWidthMm(2000);
      setFixedLenMm(2000);
    }
    toast('已重置录单内容');
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      let parsed: any;
      let inferredDim: DimensionKey = 'RECT_2D';
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
        inferredDim = 'CONTOUR_2D';
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
        throw new Error('文件中未解析到有效需求行，请核对列名（名称、宽度、长度、数量）');
      }
      const g0 = groups[0];
      if (g0.demands?.some((d: any) => d.shape?.type === 'POLYGON')) {
        inferredDim = 'CONTOUR_2D';
      }
      setImportPreview({
        fileName: file.name,
        groups,
        groupIndex: 0,
        mergeId: mergeTargetId || '',
        customName: `${file.name.replace(/\.[^.]+$/, '')} · 导入需求族`,
        customModel: g0.materialModel || materialModel || 'TC涤棉-B2026',
        dimension: inferredDim
      });
    } catch (err: any) {
      toast('导入文件解析失败：' + err.message, true);
    } finally {
      e.target.value = '';
    }
  };

  const handleLoadImportIntoForm = () => {
    if (!importPreview) return;
    const grp = importPreview.groups[importPreview.groupIndex];
    if (!grp?.demands?.length) return;
    const mapped: DraftLine[] = grp.demands.map((d: any, idx: number) => ({
      name: d.name || `导入规格 #${idx + 1}`,
      width: Number(d.width) || 0,
      length: Number(d.length) || 0,
      quantity: Math.max(1, Number(d.quantity || d.demand) || 1),
      allowRotation: Boolean(d.allowRotation),
      allowHalfTurn: Boolean(d.allowHalfTurn),
      shape: d.shape || undefined
    }));
    setCreateDim(importPreview.dimension);
    if (importPreview.mergeId) {
      setMergeTargetId(importPreview.mergeId);
    } else {
      setMergeTargetId('');
      setFamilyName(importPreview.customName);
      setMaterialModel(importPreview.customModel);
      setExternalRef(`文件导入: ${importPreview.fileName}`);
    }
    setDraftLines(mapped);
    setIsPristineDraft(false);
    setImportPreview(null);
    toast(`已将 ${mapped.length} 项解析规格填入左侧工作区`);
    focusCreateWorkspace();
  };

  const handleConfirmImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importPreview || submitting) return;
    const grp = importPreview.groups[importPreview.groupIndex];
    if (!grp?.demands?.length) return;
    setSubmitting(true);
    try {
      const saved = await requestJSON('/api/v2/demand-pool', {
        mergeIntoTaskId: importPreview.mergeId || undefined,
        name: importPreview.customName,
        materialModel: importPreview.customModel,
        externalRef: `文件导入: ${importPreview.fileName}`,
        dimension: importPreview.dimension,
        demands: grp.demands.map((d: any, idx: number) => ({
          id: idx + 1,
          name: d.name,
          width: Number(d.width),
          length: Number(d.length),
          quantity: Math.max(1, Number(d.quantity || d.demand) || 1),
          allowRotation: Boolean(d.allowRotation),
          shape: d.shape || undefined
        }))
      });
      toast(`已导入需求族「${saved.name}」（共 ${saved.orderedTotal} 件/卷）`);
      setImportPreview(null);
      setExpandedId(saved.id);
      await loadPool();
    } catch (err: any) {
      toast('保存导入需求失败：' + err.message, true);
    } finally {
      setSubmitting(false);
    }
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
      setMotherWidthMm(tpl.defaultWidthMm);
      setFixedLenMm(tpl.defaultLengthMm);
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
      }
      setMotherWidthMm(tpl.defaultWidthMm);
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

  const handleSubmitCreateFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    const is1D = createDim === 'SLITTING_1D';
    const valid = draftLines.filter(
      (d) => d.quantity > 0 && d.width > 0 && (is1D ? fixedLenMm > 0 : d.length > 0)
    );
    if (!valid.length || submitting) {
      toast('请至少填写 1 行有效尺寸与数量', true);
      return;
    }
    setSubmitting(true);
    try {
      const saved = await requestJSON('/api/v2/demand-pool', {
        mergeIntoTaskId: mergeTargetId || undefined,
        name: familyName.trim() || `${materialModel} · 排程需求族`,
        materialModel: materialModel.trim() || 'STANDARD-MAT',
        externalRef: externalRef.trim() || undefined,
        dimension: createDim,
        bedLengthMm: is1D ? fixedLenMm : 2400,
        maxWidthMm: is1D ? Math.max(1000, motherWidthMm - 20) : motherWidthMm,
        leftTrimMm: 10,
        rightTrimMm: 10,
        demands: valid.map((d, idx) => ({
          id: idx + 1,
          name: d.name,
          width: d.width,
          length: is1D ? fixedLenMm : d.length,
          quantity: d.quantity,
          allowRotation: d.allowRotation,
          allowHalfTurn: d.allowHalfTurn,
          sizeLabel: d.sizeLabel,
          sourceTemplateId: d.sourceTemplateId,
          shape: d.shape
        }))
      });
      toast(
        mergeTargetId
          ? `已追加规格至需求族「${saved.name}」`
          : `已创建排程需求族「${saved.name}」`
      );
      setFamilyName('');
      setExternalRef('');
      setMergeTargetId('');
      setDraftLines(createDefaultDraftLines());
      setIsPristineDraft(true);
      setExpandedId(saved.id);
      await loadPool();
    } catch (err: any) {
      toast('保存需求族失败：' + err.message, true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadTemplateCsv = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([demandTemplateCsv()], { type: 'text/csv;charset=utf-8' })
    );
    a.download = 'CutPlan多格式需求导入模板.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const updateDraftLine = (idx: number, patch: Partial<DraftLine>) => {
    setIsPristineDraft(false);
    setDraftLines((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const removeDraftLine = (idx: number) => {
    setIsPristineDraft(false);
    setDraftLines((arr) => arr.filter((_, i) => i !== idx));
  };

  const addDraftLine = () => {
    setIsPristineDraft(false);
    setDraftLines((arr) => [
      ...arr,
      {
        name: `规格 #${arr.length + 1}`,
        width: 600,
        length: createDim === 'SLITTING_1D' ? fixedLenMm || 2000 : 1000,
        quantity: 5,
        allowRotation: false,
        allowHalfTurn: false
      }
    ]);
  };

  const hasActiveFilters = search.trim() !== '' || dimFilter !== 'ALL' || statusFilter !== 'ALL';
  const createDimMeta = DIM_LABELS[createDim] || DIM_LABELS.RECT_2D;

  return (
    <div className="react-page dp-split-page">
      {/* Compact Page Header */}
      <header className="dp-split-head">
        <div className="dp-split-title-group">
          <h1>需求管理</h1>
          <span className="dp-split-summary num">
            {families.length} 个需求族 · {openFamilyCount} 项待排
          </span>
        </div>
        <span className="dp-split-hint">
          左侧直接录单或导入 · 右侧点击展开规格明细 · 勾选同维度可合并排程
        </span>
      </header>

      {/* Main Dual-Column Workspace */}
      <div className="dp-split-grid">
        {/* LEFT PANE: Permanent Inline Create / Append Demand Workspace */}
        <section
          ref={createPaneRef}
          className={`dp-pane dp-create-pane ${mergeTargetFamily ? 'is-append-mode' : ''}`}
          aria-label="新建或追加需求工作区"
        >
          <div className="dp-pane-head">
            <h2
              className="dp-pane-head-title"
              title={
                mergeTargetFamily
                  ? `向「${mergeTargetFamily.name}」追加规格`
                  : '新建需求'
              }
            >
              {mergeTargetFamily ? `向「${mergeTargetFamily.name}」追加规格` : '新建需求'}
            </h2>
            <div className="dp-pane-head-actions">
              {mergeTargetFamily ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={handleExitAppendMode}
                >
                  返回新建
                </button>
              ) : (
                <>
                  <label className="dp-head-ghost" title="导入 Excel / CSV / DXF / JSON 文件">
                    导入 Excel/CSV/DXF
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv,.dxf,.json"
                      hidden
                      onChange={handleFileImport}
                    />
                  </label>
                  <button
                    type="button"
                    className="dp-head-ghost"
                    onClick={handleDownloadTemplateCsv}
                  >
                    模板 CSV
                  </button>
                </>
              )}
            </div>
          </div>

          {mergeTargetFamily && (
            <div className="dp-append-banner">
              <div className="dp-append-meta">
                <span className={`tag ${(DIM_LABELS[mergeTargetFamily.dimension] || DIM_LABELS.RECT_2D).cls}`}>
                  {(DIM_LABELS[mergeTargetFamily.dimension] || DIM_LABELS.RECT_2D).text}
                </span>
                <span className="num">{mergeTargetFamily.materialModel}</span>
                <CodeBadge>{shortId(mergeTargetFamily.id)}</CodeBadge>
              </div>
              <label className="dp-head-ghost" title="导入文件并追加到此需求族">
                导入文件
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.dxf,.json"
                  hidden
                  onChange={handleFileImport}
                />
              </label>
            </div>
          )}

          <form className="dp-create-form" onSubmit={handleSubmitCreateFamily}>
            <div ref={createBodyRef} className="dp-create-body">
              {/* Dimension Switcher */}
              {!mergeTargetFamily && (
                <div className="dp-field-block">
                  <span className="dp-field-label">裁切维度</span>
                  <SegmentedControl
                    options={CREATE_DIM_OPTIONS}
                    value={createDim}
                    onChange={(next) => setCreateDim(next)}
                    ariaLabel="选择新建需求裁切维度"
                    fullWidth
                    size="sm"
                  />
                </div>
              )}

              {/* Base Metadata Compact 2-Column Grid */}
              {!mergeTargetFamily && (
                <div className="dp-form-grid">
                  <div className="dp-field-block dp-span-2">
                    <label className="dp-field-label" htmlFor="dp-name">
                      需求族名称
                    </label>
                    <input
                      id="dp-name"
                      className="field"
                      required
                      placeholder="如：11月窗帘合排单 / MES-光学膜分条"
                      value={familyName}
                      onChange={(e) => setFamilyName(e.target.value)}
                    />
                  </div>

                  <div className="dp-field-block">
                    <label className="dp-field-label" htmlFor="dp-mat">
                      物料品号
                    </label>
                    <input
                      id="dp-mat"
                      className="field"
                      list="dp-mat-list"
                      required
                      placeholder="输入或选择品号"
                      value={materialModel}
                      onChange={(e) => setMaterialModel(e.target.value)}
                    />
                    <datalist id="dp-mat-list">
                      {materialOptions.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>

                  <div className="dp-field-block">
                    <label className="dp-field-label" htmlFor="dp-ext">
                      <span>外部工单号</span>
                      <span className="dp-field-opt">选填</span>
                    </label>
                    <input
                      id="dp-ext"
                      className="field"
                      placeholder="MES / ERP 单号"
                      value={externalRef}
                      onChange={(e) => setExternalRef(e.target.value)}
                    />
                  </div>

                  {createDim === 'SLITTING_1D' && (
                    <>
                      <div className="dp-field-block">
                        <label className="dp-field-label" htmlFor="dp-slit-w">
                          母卷幅宽 (mm)
                        </label>
                        <NumberInput
                          id="dp-slit-w"
                          min={100}
                          className="field num"
                          value={motherWidthMm}
                          onValueChange={setMotherWidthMm}
                        />
                      </div>
                      <div className="dp-field-block">
                        <label className="dp-field-label" htmlFor="dp-slit-l">
                          定长卷长 (mm)
                        </label>
                        <NumberInput
                          id="dp-slit-l"
                          min={100}
                          className="field num"
                          value={fixedLenMm}
                          onValueChange={setFixedLenMm}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              {mergeTargetFamily && createDim === 'SLITTING_1D' && (
                <div className="dp-form-grid">
                  <div className="dp-field-block">
                    <label className="dp-field-label" htmlFor="dp-slit-w">
                      母卷幅宽 (mm)
                    </label>
                    <NumberInput
                      id="dp-slit-w"
                      min={100}
                      className="field num"
                      value={motherWidthMm}
                      onValueChange={setMotherWidthMm}
                    />
                  </div>
                  <div className="dp-field-block">
                    <label className="dp-field-label" htmlFor="dp-slit-l">
                      定长卷长 (mm)
                    </label>
                    <NumberInput
                      id="dp-slit-l"
                      min={100}
                      className="field num"
                      value={fixedLenMm}
                      onValueChange={setFixedLenMm}
                    />
                  </div>
                </div>
              )}

              {/* Quick Template One-Click Expand Strip */}
              <div className="dp-tpl-strip">
                <span className="dp-tpl-strip-title">快捷模板展开</span>
                <div className="dp-tpl-row">
                  <select
                    aria-label="选择需求模板"
                    className="field dp-tpl-select"
                    value={templateQuickId}
                    onChange={(e) => setTemplateQuickId(e.target.value)}
                  >
                    <option value="">选择需求模板快速填入…</option>
                    {clusters.map((c) => (
                      <option key={c.id} value={c.id}>
                        [{c.dimension}] {c.name} ({c.materialModel})
                      </option>
                    ))}
                  </select>
                  <NumberInput
                    min={1}
                    max={100}
                    fallback={1}
                    integer
                    aria-label="模板套数"
                    className="field num dp-tpl-sets"
                    value={templateQuickSets}
                    onValueChange={setTemplateQuickSets}
                  />
                  <span className="dp-tpl-unit">套</span>
                  <button
                    type="button"
                    className="btn sm dp-tpl-btn"
                    disabled={!templateQuickId}
                    onClick={handleAppendFromTemplate}
                  >
                    展开填入
                  </button>
                </div>
              </div>

              {/* Editable Spec Lines Table */}
              <div className="dp-spec-section">
                <div className="dp-spec-head">
                  <span className="dp-spec-title">
                    规格明细
                    <span className="dp-spec-count num">共 {draftLines.length} 行</span>
                  </span>
                  <button type="button" className="dp-head-ghost" onClick={addDraftLine}>
                    ＋ 添加规格行
                  </button>
                </div>

                <div className="dp-spec-table-wrap">
                  {draftLines.length === 0 ? (
                    <div className="dp-spec-empty">
                      暂无规格行，点击上方「＋ 添加规格行」或从快捷模板展开填入
                    </div>
                  ) : (
                    <table className="dp-spec-table">
                      <colgroup>
                        <col />
                        <col style={{ width: createDim === 'SLITTING_1D' ? 74 : 54 }} />
                        {createDim !== 'SLITTING_1D' && <col style={{ width: 54 }} />}
                        <col style={{ width: createDim === 'SLITTING_1D' ? 56 : 40 }} />
                        {createDim !== 'SLITTING_1D' && <col style={{ width: 66 }} />}
                        <col style={{ width: 22 }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>名称</th>
                          <th className="r">{createDim === 'SLITTING_1D' ? '条宽' : '宽(mm)'}</th>
                          {createDim !== 'SLITTING_1D' && <th className="r">长(mm)</th>}
                          <th className="r">数量</th>
                          {createDim !== 'SLITTING_1D' && <th>方向</th>}
                          <th aria-label="删除" />
                        </tr>
                      </thead>
                      <tbody>
                        {draftLines.map((ln, idx) => (
                          <tr key={idx}>
                            <td>
                              <input
                                ref={idx === 0 ? firstSpecInputRef : undefined}
                                aria-label={`规格行 ${idx + 1} 名称`}
                                className="dp-cell-input"
                                value={ln.name}
                                onChange={(e) => updateDraftLine(idx, { name: e.target.value })}
                              />
                              {ln.shape?.type === 'POLYGON' && (
                                <span className="dp-shape-chip">
                                  异形 {ln.shape.vertices?.length || 0}点
                                </span>
                              )}
                            </td>
                            <td>
                              <NumberInput
                                min={1}
                                aria-label={`规格行 ${idx + 1} 宽度`}
                                className="dp-cell-input dp-cell-num num"
                                value={ln.width}
                                disabled={Boolean(ln.shape)}
                                onValueChange={(v) => updateDraftLine(idx, { width: v })}
                              />
                            </td>
                            {createDim !== 'SLITTING_1D' && (
                              <td>
                                <NumberInput
                                  min={1}
                                  aria-label={`规格行 ${idx + 1} 长度`}
                                  className="dp-cell-input dp-cell-num num"
                                  value={ln.length}
                                  disabled={Boolean(ln.shape)}
                                  onValueChange={(v) => updateDraftLine(idx, { length: v })}
                                />
                              </td>
                            )}
                            <td>
                              <NumberInput
                                min={1}
                                integer
                                aria-label={`规格行 ${idx + 1} 数量`}
                                className="dp-cell-input dp-cell-num num"
                                value={ln.quantity}
                                onValueChange={(v) => updateDraftLine(idx, { quantity: v })}
                              />
                            </td>
                            {createDim !== 'SLITTING_1D' && (
                              <td>
                                <select
                                  aria-label={`规格行 ${idx + 1} 方向规则`}
                                  className="dp-cell-input"
                                  value={getDirectionMode(ln)}
                                  onChange={(e) => {
                                    const mode = e.target.value as DirectionMode;
                                    setIsPristineDraft(false);
                                    setDraftLines((arr) =>
                                      arr.map((it, i) =>
                                        i === idx ? applyDirectionMode(it, mode) : it
                                      )
                                    );
                                  }}
                                >
                                  <option value="FIXED">0°经向</option>
                                  <option value="ROTATE_90">90°旋</option>
                                  <option value="HALF_180">180°倒</option>
                                </select>
                              </td>
                            )}
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="dp-row-del"
                                aria-label={`删除规格行 ${idx + 1}`}
                                title="删除此规格行"
                                onClick={() => removeDraftLine(idx)}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>

            {/* Sticky Footer Bar */}
            <div className="dp-create-foot">
              <div className="dp-foot-left">
                <span className="dp-foot-stats num">
                  <strong>{draftSummary.validCount}</strong> 项 · 共{' '}
                  <strong>{draftSummary.totalQty}</strong> {createDimMeta.unit}
                </span>
                <button type="button" className="dp-head-ghost" onClick={handleResetForm}>
                  重置
                </button>
              </div>
              <button
                type="submit"
                className="btn pri dp-foot-submit"
                disabled={submitting}
              >
                {submitting
                  ? '正在保存…'
                  : mergeTargetFamily
                  ? '确认追加规格'
                  : '创建需求族'}
              </button>
            </div>
          </form>
        </section>

        {/* RIGHT PANE: Existing Demands Ledger Card */}
        <section className="dp-pane dp-list-pane" aria-label="已建需求台账">
          {/* Single-Row Minimal Filter Toolbar */}
          <div className="dp-list-toolbar">
            <div className="dp-search-wrap">
              <span className="mp-search-ico" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="13.5" height="13.5">
                  <circle
                    cx="7.2"
                    cy="7.2"
                    r="4.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="m10.8 10.8 2.8 2.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <input
                type="search"
                className="dp-search-input"
                aria-label="搜索需求族"
                placeholder="筛选需求族、品号或工单号"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="dp-filter-selects">
              <select
                aria-label="按维度筛选"
                className="dp-filter-select"
                value={dimFilter}
                onChange={(e) => setDimFilter(e.target.value)}
              >
                <option value="ALL">全部维度</option>
                <option value="CONTOUR_2D">二维异形</option>
                <option value="RECT_2D">二维矩形</option>
                <option value="SLITTING_1D">一维分条</option>
              </select>

              <select
                aria-label="按状态筛选"
                className="dp-filter-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="ALL">全部状态</option>
                <option value="OPEN_ONLY">有待排余量</option>
                <option value="OPEN">待排程</option>
                <option value="PARTIAL_PLANNED">部分已排</option>
                <option value="FULLY_PLANNED">已排待切</option>
                <option value="COMPLETED">已齐套完结</option>
              </select>
            </div>

            <div className="dp-list-toolbar-right">
              <span className="mp-toolbar-count num">
                显示 {filteredFamilies.length} / {families.length}
              </span>

              {checkedFamilies.length > 0 && (
                <button
                  type="button"
                  className="btn sm soft-accent"
                  onClick={() => {
                    loadDemandFamiliesMergedIntoWorkbench(checkedFamilies);
                    location.hash = '#/workbench';
                  }}
                >
                  合并去搭切排程 ({checkedFamilies.length}) →
                </button>
              )}

              <a className="dp-head-ghost" href="#/clusters">
                模板库
              </a>
            </div>
          </div>

          {/* Scrollable Table Container */}
          <div className="dp-list-body">
            {error ? (
              <div style={{ padding: 16 }}>
                <div className="error-box" role="alert">
                  <b>读取失败</b>
                  <p>{error}</p>
                </div>
              </div>
            ) : loading ? (
              <div className="loading">正在读取多维待排需求池…</div>
            ) : filteredFamilies.length === 0 ? (
              <div className="dp-empty-state">
                <strong>
                  {hasActiveFilters ? '没有符合当前筛选条件的需求族' : '当前暂无排程需求族'}
                </strong>
                <p>
                  {hasActiveFilters
                    ? '可调整维度或状态下拉筛选条件，或清空关键词重新查看全部需求。'
                    : '直接在左侧工作区填写规格并提交，或导入 Excel / CSV / DXF 文件生成需求族。'}
                </p>
                <div style={{ display: 'inline-flex', gap: 8 }}>
                  {hasActiveFilters && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setSearch('');
                        setDimFilter('ALL');
                        setStatusFilter('ALL');
                      }}
                    >
                      重置筛选
                    </button>
                  )}
                  <a className="btn sm" href="#/clusters">
                    前往模板库 →
                  </a>
                </div>
              </div>
            ) : (
              <div className="dp-table-xscroll">
                <table className="t">
                  <thead>
                    <tr>
                      <th className="dp-col-check" />
                      <th>需求族 / 工单</th>
                      <th>维度</th>
                      <th>物料品号</th>
                      <th>数量账本</th>
                      <th>状态</th>
                      <th className="dp-col-actions">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFamilies.map((fam) => {
                      const dimMeta = DIM_LABELS[fam.dimension] || DIM_LABELS.RECT_2D;
                      const stMeta = STATUS_LABELS[fam.status] || STATUS_LABELS.OPEN;
                      const isExpanded = expandedId === fam.id;
                      const isChecked = selectedIds.includes(fam.id);
                      const isMergeTarget = mergeTargetId === fam.id;
                      const donePct = fam.orderedTotal
                        ? (fam.completedTotal / fam.orderedTotal) * 100
                        : 0;
                      const planPct = fam.orderedTotal
                        ? (fam.plannedTotal / fam.orderedTotal) * 100
                        : 0;

                      return (
                        <React.Fragment key={fam.id}>
                          <tr
                            className={`click ${isExpanded ? 'sel' : ''} ${
                              isMergeTarget ? 'dp-row-is-target' : ''
                            }`}
                            onClick={() => setExpandedId(isExpanded ? null : fam.id)}
                          >
                            <td
                              className="dp-col-check"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                aria-label={`勾选需求族 ${fam.name}`}
                                checked={isChecked}
                                onChange={() => toggleSelectFamily(fam)}
                              />
                            </td>
                            <td className="dp-col-name">
                              <div className="mp-fam-title-row">
                                <strong>{fam.name}</strong>
                                <CodeBadge>{shortId(fam.id)}</CodeBadge>
                              </div>
                              <div className="mp-fam-sub num">
                                {fam.externalRef || '内部自建'} · {fam.lines.length} 项
                                {fam.schemeCount > 0 ? ` · ${fam.schemeCount} 方案` : ''}
                              </div>
                            </td>
                            <td>
                              <span className={`tag ${dimMeta.cls}`} title={dimMeta.fullText}>
                                {dimMeta.text}
                              </span>
                            </td>
                            <td className="dp-col-mat num" title={fam.materialModel}>
                              {fam.materialModel}
                            </td>
                            <td className="dp-col-ledger">
                              <div className="demand-ledger-cell num">
                                <div className="demand-ledger-nums">
                                  <span>
                                    总 <b>{fam.orderedTotal}</b>
                                  </span>
                                  <span style={{ color: 'var(--cp-accent-ink)' }}>
                                    已排 <b>{fam.plannedTotal}</b>
                                  </span>
                                  <span style={{ color: '#059669' }}>
                                    实完 <b>{fam.completedTotal}</b>
                                  </span>
                                  <span
                                    style={{
                                      color: fam.openTotal > 0 ? '#b45309' : 'var(--cp-ink-3)',
                                      fontWeight: 600
                                    }}
                                  >
                                    待排 {fam.openTotal} {dimMeta.unit}
                                  </span>
                                </div>
                                <div className="demand-dual-bar" aria-hidden="true">
                                  <i
                                    className="seg-done"
                                    style={{ width: `${Math.min(100, donePct)}%` }}
                                  />
                                  <i
                                    className="seg-plan"
                                    style={{ width: `${Math.min(100 - donePct, planPct)}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                            <td>
                              <span className={`tag ${stMeta.cls}`}>{stMeta.text}</span>
                            </td>
                            <td
                              className="dp-col-actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="dp-row-actions">
                                <button
                                  type="button"
                                  className={`btn sm ${fam.openTotal > 0 ? 'soft-accent' : ''}`}
                                  onClick={() => {
                                    loadDemandFamilyIntoWorkbench(fam);
                                    location.hash = '#/workbench';
                                  }}
                                >
                                  {fam.openTotal > 0 ? '去搭切排程 →' : '重新试算'}
                                </button>
                                {fam.schemeCount > 0 && (
                                  <a
                                    className="btn sm"
                                    title={`查看 ${fam.schemeCount} 个已保存方案`}
                                    href={`#/results?taskId=${encodeURIComponent(fam.id)}`}
                                  >
                                    查看方案
                                  </a>
                                )}
                              </div>
                            </td>
                          </tr>

                          {isExpanded && (
                            <tr>
                              <td colSpan={7} className="mp-demand-expand-cell">
                                <div className="mp-demand-expand-inner">
                                  <div className="mp-demand-expand-head">
                                    <strong style={{ fontSize: 12 }}>
                                      需求族规格明细（共 {fam.lines.length} 项）
                                    </strong>
                                    <button
                                      type="button"
                                      className="btn sm"
                                      onClick={() => handleEnterAppendMode(fam)}
                                    >
                                      ＋ 向此需求族追加规格
                                    </button>
                                  </div>
                                  <div className="dp-expand-inner-scroll">
                                    <table className="t dp-sub-table">
                                      <thead>
                                        <tr>
                                          <th>行号</th>
                                          <th>规格名称</th>
                                          <th>形态</th>
                                          <th className="r">宽 × 长 mm</th>
                                          <th>方向</th>
                                          <th className="r">总需求</th>
                                          <th className="r">已排</th>
                                          <th className="r">实完</th>
                                          <th className="r">剩余待排</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {fam.lines.map((ln) => (
                                          <tr key={ln.id}>
                                            <td className="num">#{ln.id}</td>
                                            <td className="dp-sub-name">
                                              {ln.name}
                                              {ln.sizeLabel && (
                                                <span className="tag" style={{ marginLeft: 5 }}>
                                                  {ln.sizeLabel}
                                                </span>
                                              )}
                                            </td>
                                            <td>
                                              {fam.dimension === 'SLITTING_1D'
                                                ? '一维卷条'
                                                : ln.shape?.type === 'POLYGON'
                                                ? `异形(${ln.shape.vertices?.length || 0}点)`
                                                : '标准矩形'}
                                            </td>
                                            <td className="r num">
                                              {fmtN(ln.width, 1)} × {fmtN(ln.length, 1)}
                                            </td>
                                            <td>
                                              {fam.dimension === 'SLITTING_1D'
                                                ? '纵向开条'
                                                : ln.allowRotation
                                                ? '允许 90°'
                                                : ln.allowHalfTurn
                                                ? '180° 倒顺'
                                                : '0° 经向'}
                                            </td>
                                            <td className="r num">{ln.orderedQty}</td>
                                            <td
                                              className="r num"
                                              style={{ color: 'var(--cp-accent-ink)' }}
                                            >
                                              {ln.plannedQty}
                                            </td>
                                            <td className="r num" style={{ color: '#059669' }}>
                                              {ln.completedQty}
                                            </td>
                                            <td
                                              className="r num"
                                              style={{
                                                fontWeight: 600,
                                                color:
                                                  ln.openQty > 0 ? '#b45309' : 'var(--cp-ink-3)'
                                              }}
                                            >
                                              {ln.openQty}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Multi-Format Import Preview Modal */}
      <ModalDialog
        open={importPreview !== null}
        title="多格式需求文件导入核对"
        onClose={() => setImportPreview(null)}
        maxWidth={680}
      >
        {importPreview && (
          <form onSubmit={handleConfirmImport}>
            <div className="form" style={{ gridTemplateColumns: '115px 1fr', padding: '4px 0 12px' }}>
              <label>来源文件</label>
              <div className="num" style={{ fontWeight: 600 }}>
                {importPreview.fileName}
              </div>
              {importPreview.groups.length > 1 && (
                <>
                  <label>选择面料/分组</label>
                  <select
                    className="field"
                    value={importPreview.groupIndex}
                    onChange={(e) => {
                      const gi = Number(e.target.value);
                      const g = importPreview.groups[gi];
                      setImportPreview({
                        ...importPreview,
                        groupIndex: gi,
                        customModel: g?.materialModel || importPreview.customModel
                      });
                    }}
                  >
                    {importPreview.groups.map((g, idx) => (
                      <option key={idx} value={idx}>
                        {g.label || g.materialModel || `分组 #${idx + 1}`} (
                        {(g.demands || []).length} 项)
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label>导入方式</label>
              <select
                className="field"
                value={importPreview.mergeId}
                onChange={(e) => setImportPreview({ ...importPreview, mergeId: e.target.value })}
              >
                <option value="">创建为全新需求族</option>
                {families
                  .filter((f) => f.dimension === importPreview.dimension)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      追加合并入：{f.name} ({f.materialModel})
                    </option>
                  ))}
              </select>
              {!importPreview.mergeId && (
                <>
                  <label>需求族名称</label>
                  <input
                    className="field"
                    required
                    value={importPreview.customName}
                    onChange={(e) =>
                      setImportPreview({ ...importPreview, customName: e.target.value })
                    }
                  />
                  <label>识别维度</label>
                  <select
                    className="field"
                    value={importPreview.dimension}
                    onChange={(e) =>
                      setImportPreview({
                        ...importPreview,
                        dimension: e.target.value as DimensionKey
                      })
                    }
                  >
                    <option value="RECT_2D">二维矩形开料</option>
                    <option value="CONTOUR_2D">二维异形裁片</option>
                    <option value="SLITTING_1D">一维定长分条</option>
                  </select>
                  <label>物料品号</label>
                  <input
                    className="field"
                    required
                    value={importPreview.customModel}
                    onChange={(e) =>
                      setImportPreview({ ...importPreview, customModel: e.target.value })
                    }
                  />
                </>
              )}
            </div>

            <div className="sec" style={{ margin: '0 -16px 8px' }}>
              解析预览（共 {importPreview.groups[importPreview.groupIndex]?.demands?.length || 0} 项）
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th className="r">宽 mm</th>
                    <th className="r">长 mm</th>
                    <th className="r">数量</th>
                  </tr>
                </thead>
                <tbody>
                  {(importPreview.groups[importPreview.groupIndex]?.demands || [])
                    .slice(0, 30)
                    .map((d: any, idx: number) => (
                      <tr key={idx}>
                        <td>{d.name}</td>
                        <td className="r num">{fmtN(d.width, 1)}</td>
                        <td className="r num">{fmtN(d.length, 1)}</td>
                        <td className="r num">{d.quantity || d.demand}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn" onClick={() => setImportPreview(null)}>
                取消
              </button>
              <button type="button" className="btn" onClick={handleLoadImportIntoForm}>
                填入左栏微调
              </button>
              <button type="submit" className="btn pri" disabled={submitting}>
                确认导入需求池
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </div>
  );
};
