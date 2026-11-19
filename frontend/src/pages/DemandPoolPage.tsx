import React, { useEffect, useMemo, useState } from 'react';
import {
  useStudioStore,
  DemandFamilySummary,
  expandClusterToDemands
} from '../store/useStudioStore';
import { ModalDialog } from '../components/ModalDialog';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { requestJSON, toast, fmtN, shortId, loadSheetLib } from '@static/app/js/util.js';
import {
  parseDemandSheet,
  parseDemandJSON,
  importGroups
} from '@static/js/business/cutting/demand-import-model.js';
import { parseDxfGarmentText } from '@static/js/nesting/dxf-garment-samples.js';
import { demandTemplateCsv } from '@static/app/js/model/task-form.js';

const DIM_LABELS: Record<string, { text: string; cls: string; unit: string }> = {
  CONTOUR_2D: { text: '二维异形裁片', cls: 'run', unit: '片' },
  RECT_2D: { text: '二维矩形开料', cls: 'ok', unit: '件' },
  SLITTING_1D: { text: '一维定长分条', cls: 'kind', unit: '卷' }
};

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  OPEN: { text: '待排程', cls: 'idle' },
  PARTIAL_PLANNED: { text: '部分已排', cls: 'run' },
  FULLY_PLANNED: { text: '已排待切', cls: 'warn' },
  COMPLETED: { text: '已齐套完结', cls: 'ok' }
};

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
  const [filterKey, setFilterKey] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Create / Merge Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createDim, setCreateDim] = useState<'CONTOUR_2D' | 'RECT_2D' | 'SLITTING_1D'>('RECT_2D');
  const [mergeTargetId, setMergeTargetId] = useState<string>('');
  const [familyName, setFamilyName] = useState('');
  const [materialModel, setMaterialModel] = useState('TC涤棉-B2026');
  const [externalRef, setExternalRef] = useState('');
  const [motherWidthMm, setMotherWidthMm] = useState(2000);
  const [fixedLenMm, setFixedLenMm] = useState(2000);
  const [templateQuickId, setTemplateQuickId] = useState('');
  const [templateQuickSets, setTemplateQuickSets] = useState(2);
  const [draftLines, setDraftLines] = useState<
    {
      name: string;
      width: number;
      length: number;
      quantity: number;
      allowRotation: boolean;
      allowHalfTurn?: boolean;
      sizeLabel?: string;
      sourceTemplateId?: string;
      shape?: any;
    }[]
  >([
    { name: '主规格 #1', width: 800, length: 1200, quantity: 10, allowRotation: false },
    { name: '配片 #2', width: 450, length: 600, quantity: 10, allowRotation: true }
  ]);
  const [submitting, setSubmitting] = useState(false);

  // File Import Preview Modal State
  const [importPreview, setImportPreview] = useState<{
    fileName: string;
    groups: any[];
    groupIndex: number;
    mergeId: string;
    customName: string;
    customModel: string;
    dimension: 'CONTOUR_2D' | 'RECT_2D' | 'SLITTING_1D';
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

  const filteredFamilies = useMemo(() => {
    const q = search.trim().toLowerCase();
    return families.filter((f) => {
      if (filterKey === 'OPEN_ONLY' && f.openTotal <= 0) return false;
      if (filterKey === 'COMPLETED' && f.status !== 'COMPLETED') return false;
      if (
        ['CONTOUR_2D', 'RECT_2D', 'SLITTING_1D'].includes(filterKey) &&
        f.dimension !== filterKey
      ) {
        return false;
      }
      if (!q) return true;
      return `${f.name} ${f.materialModel} ${f.externalRef || ''} ${f.id}`
        .toLowerCase()
        .includes(q);
    });
  }, [families, filterKey, search]);

  const checkedFamilies = useMemo(
    () => families.filter((f) => selectedIds.includes(f.id)),
    [families, selectedIds]
  );

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

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      let parsed: any;
      let inferredDim: 'CONTOUR_2D' | 'RECT_2D' | 'SLITTING_1D' = 'RECT_2D';
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
        mergeId: '',
        customName: `${file.name.replace(/\.[^.]+$/, '')} · 导入需求族`,
        customModel: g0.materialModel || 'TC涤棉-B2026',
        dimension: inferredDim
      });
    } catch (err: any) {
      toast('导入文件解析失败：' + err.message, true);
    } finally {
      e.target.value = '';
    }
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

  const handleAppendFromTemplateInModal = () => {
    const tpl = clusters.find((c) => c.id === templateQuickId);
    if (!tpl) return;
    const sz = tpl.availableSizes[0];
    const mult = Math.max(1, templateQuickSets);
    if (tpl.dimension === '1D') {
      setCreateDim('SLITTING_1D');
      setMaterialModel(tpl.materialModel);
      setMotherWidthMm(tpl.defaultWidthMm);
      setFixedLenMm(tpl.defaultLengthMm);
      const added = tpl.pieces.map((p) => {
        const g = Object.values(p.sizes)[0];
        return {
          name: p.name,
          width: g.w,
          length: g.h,
          quantity: p.quantityPerUnit * mult,
          allowRotation: false,
          sourceTemplateId: tpl.id
        };
      });
      setDraftLines((prev) => [...prev, ...added]);
    } else {
      const expanded = expandClusterToDemands(tpl, { [sz]: mult }, 1);
      if (expanded.some((d) => d.shape?.type === 'POLYGON')) {
        setCreateDim('CONTOUR_2D');
      }
      setMaterialModel(tpl.materialModel);
      setMotherWidthMm(tpl.defaultWidthMm);
      setDraftLines((prev) => [
        ...prev,
        ...expanded.map((it) => ({
          name: it.name,
          width: it.width,
          length: it.length,
          quantity: it.quantity,
          allowRotation: it.allowRotation,
          allowHalfTurn: it.allowHalfTurn,
          sizeLabel: it.sizeLabel,
          sourceTemplateId: tpl.id,
          shape: it.shape
        }))
      ]);
    }
    toast(`已从模板「${tpl.name}」展开追加部件`);
  };

  const handleSubmitCreateFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    const valid = draftLines.filter((d) => d.quantity > 0 && d.width > 0 && d.length > 0);
    if (!valid.length || submitting) {
      toast('请至少填写 1 行有效尺寸与数量', true);
      return;
    }
    setSubmitting(true);
    try {
      const is1D = createDim === 'SLITTING_1D';
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
          ? `已合并追加至需求族「${saved.name}」`
          : `已创建排程需求族「${saved.name}」`
      );
      setShowCreateModal(false);
      setFamilyName('');
      setMergeTargetId('');
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

  const openFamilyCount = useMemo(
    () => families.filter((f) => f.openTotal > 0).length,
    [families]
  );

  const filterOptions: SegmentedOption<string>[] = useMemo(
    () => [
      { value: 'ALL', label: '全部需求族', count: families.length },
      {
        value: 'OPEN_ONLY',
        label: '有待排余量',
        count: openFamilyCount,
        accent: 'indigo'
      },
      {
        value: 'CONTOUR_2D',
        label: '二维异形',
        count: families.filter((f) => f.dimension === 'CONTOUR_2D').length
      },
      {
        value: 'RECT_2D',
        label: '二维矩形',
        count: families.filter((f) => f.dimension === 'RECT_2D').length
      },
      {
        value: 'SLITTING_1D',
        label: '一维分条',
        count: families.filter((f) => f.dimension === 'SLITTING_1D').length
      },
      {
        value: 'COMPLETED',
        label: '已齐套完工',
        count: families.filter((f) => f.status === 'COMPLETED').length,
        accent: 'emerald'
      }
    ],
    [families, openFamilyCount]
  );

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>需求管理</h1>
            <span className="mp-page-summary num">
              {families.length} 个需求族 · {openFamilyCount} 项待排
            </span>
          </div>
        </div>

        <div className="mp-filter-toolbar">
          <div className="mp-search-wrap">
            <span className="mp-search-ico" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
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
              className="mp-search-input"
              aria-label="搜索需求族"
              placeholder="筛选需求族、物料品号或工单号"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <span className="mp-toolbar-count num">
            显示 {filteredFamilies.length} / {families.length}
          </span>

          <div className="mp-toolbar-actions">
            <button type="button" className="mp-ghost-btn" onClick={handleDownloadTemplateCsv}>
              模板 CSV
            </button>
            <label className="mp-ghost-btn" style={{ cursor: 'pointer' }}>
              导入文件
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.dxf,.json"
                hidden
                onChange={handleFileImport}
              />
            </label>
            <a className="mp-ghost-btn" href="#/clusters">
              模板库
            </a>
            {checkedFamilies.length > 0 && (
              <button
                type="button"
                className="btn soft-accent"
                onClick={() => {
                  loadDemandFamiliesMergedIntoWorkbench(checkedFamilies);
                  location.hash = '#/workbench';
                }}
              >
                合并去搭切排程 ({checkedFamilies.length}) →
              </button>
            )}
            <button type="button" className="btn pri" onClick={() => setShowCreateModal(true)}>
              ＋ 新建需求族
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <SegmentedControl
            options={filterOptions}
            value={filterKey}
            onChange={(next) => setFilterKey(next)}
            ariaLabel="按需求维度与状态筛选"
          />
          <span className="mp-toolbar-count">
            点击行展开明细 · 勾选同材质多族可合并排程
          </span>
        </div>

        {error ? (
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="mp-demand-card">
            <div className="loading">正在读取多维待排需求池…</div>
          </div>
        ) : filteredFamilies.length === 0 ? (
          <div className="mp-demand-card" style={{ padding: 36, textAlign: 'center' }}>
            <strong style={{ fontSize: 14 }}>当前暂无匹配的排程需求族</strong>
            <p className="muted" style={{ margin: '8px auto 16px', maxWidth: 460 }}>
              可通过上方导入 Excel / CSV / CAD DXF 文件，或从「需求模板库」按配码套数一键展开生成需求族。
            </p>
            <div style={{ display: 'inline-flex', gap: 10 }}>
              <button type="button" className="btn pri" onClick={() => setShowCreateModal(true)}>
                ＋ 立即创建需求族
              </button>
              <a className="btn" href="#/clusters">
                前往需求模板库选取 →
              </a>
            </div>
          </div>
        ) : (
          <div className="mp-demand-card">
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>需求族 / 工单标识</th>
                  <th>维度</th>
                  <th>物料品号</th>
                  <th className="r">项</th>
                  <th>数量账本</th>
                  <th>状态</th>
                  <th className="r">方案</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredFamilies.map((fam) => {
                  const dimMeta = DIM_LABELS[fam.dimension] || DIM_LABELS.RECT_2D;
                  const stMeta = STATUS_LABELS[fam.status] || STATUS_LABELS.OPEN;
                  const isExpanded = expandedId === fam.id;
                  const isChecked = selectedIds.includes(fam.id);
                  const donePct = fam.orderedTotal ? (fam.completedTotal / fam.orderedTotal) * 100 : 0;
                  const planPct = fam.orderedTotal ? (fam.plannedTotal / fam.orderedTotal) * 100 : 0;

                  return (
                    <React.Fragment key={fam.id}>
                      <tr
                        className={`click ${isExpanded ? 'sel' : ''}`}
                        onClick={() => setExpandedId(isExpanded ? null : fam.id)}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`勾选需求族 ${fam.name}`}
                            checked={isChecked}
                            onChange={() => toggleSelectFamily(fam)}
                          />
                        </td>
                        <td className="mp-col-name">
                          <div className="mp-fam-title-row">
                            <strong>{fam.name}</strong>
                            <CodeBadge>{shortId(fam.id)}</CodeBadge>
                          </div>
                          <div className="mp-fam-sub num">
                            {fam.externalRef || '内部自建'}
                          </div>
                        </td>
                        <td>
                          <span className={`tag ${dimMeta.cls}`}>{dimMeta.text}</span>
                        </td>
                        <td className="num" style={{ color: 'var(--cp-ink-2)' }}>
                          {fam.materialModel}
                        </td>
                        <td className="r num">{fam.lines.length}</td>
                        <td>
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
                        <td className="r num">{fam.schemeCount}</td>
                        <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
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
                          <td colSpan={9} className="mp-demand-expand-cell">
                            <div className="mp-demand-expand-inner">
                              <div className="mp-demand-expand-head">
                                <strong style={{ fontSize: 12 }}>
                                  需求族规格明细（共 {fam.lines.length} 项）
                                </strong>
                                <button
                                  type="button"
                                  className="btn sm"
                                  onClick={() => {
                                    setMergeTargetId(fam.id);
                                    setCreateDim(fam.dimension);
                                    setMaterialModel(fam.materialModel);
                                    setShowCreateModal(true);
                                  }}
                                >
                                  ＋ 向此需求族追加规格
                                </button>
                              </div>
                              <table className="t">
                                <thead>
                                  <tr>
                                    <th>行号</th>
                                    <th>规格 / 裁片名称</th>
                                    <th>几何形态</th>
                                    <th className="r">宽 × 长 mm</th>
                                    <th>方向规则</th>
                                    <th className="r">总需求</th>
                                    <th className="r">已排预占</th>
                                    <th className="r">实切合格</th>
                                    <th className="r">剩余待排</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {fam.lines.map((ln) => (
                                    <tr key={ln.id}>
                                      <td className="num">#{ln.id}</td>
                                      <td style={{ fontWeight: 600 }}>
                                        {ln.name}
                                        {ln.sizeLabel && (
                                          <span className="tag" style={{ marginLeft: 6 }}>
                                            {ln.sizeLabel}
                                          </span>
                                        )}
                                      </td>
                                      <td>
                                        {fam.dimension === 'SLITTING_1D'
                                          ? '一维定长卷条'
                                          : ln.shape?.type === 'POLYGON'
                                          ? `异形轮廓 (${ln.shape.vertices?.length || 0}顶点)`
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
                                          ? '允许 180° 倒顺'
                                          : '严格 0° 经向'}
                                      </td>
                                      <td className="r num">{ln.orderedQty}</td>
                                      <td className="r num" style={{ color: 'var(--cp-accent-ink)' }}>
                                        {ln.plannedQty}
                                      </td>
                                      <td className="r num" style={{ color: '#059669' }}>
                                        {ln.completedQty}
                                      </td>
                                      <td
                                        className="r num"
                                        style={{
                                          fontWeight: 600,
                                          color: ln.openQty > 0 ? '#b45309' : 'var(--cp-ink-3)'
                                        }}
                                      >
                                        {ln.openQty}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
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

      {/* Create / Merge Multi-Dimensional Demand Family Modal */}
      <ModalDialog
        open={showCreateModal}
        title={mergeTargetId ? '追加需求至已有需求族' : '新建排程需求族（支持多维度与模板快选）'}
        onClose={() => {
          setShowCreateModal(false);
          setMergeTargetId('');
        }}
        maxWidth={760}
      >
        <form onSubmit={handleSubmitCreateFamily}>
          <div className="form" style={{ gridTemplateColumns: '115px 1fr', padding: '4px 0 12px' }}>
            {!mergeTargetId && (
              <>
                <label htmlFor="dp-dim">需求维度</label>
                <select
                  id="dp-dim"
                  className="field"
                  value={createDim}
                  onChange={(e) => setCreateDim(e.target.value as any)}
                >
                  <option value="RECT_2D">二维矩形开料（家纺窗帘 / 板材 / 片材）</option>
                  <option value="CONTOUR_2D">二维异形轮廓（服装 CAD 纸样 / 异形件）</option>
                  <option value="SLITTING_1D">一维定长分条（光学膜 / 涂层面料分切）</option>
                </select>
                <label htmlFor="dp-name">需求族名称</label>
                <input
                  id="dp-name"
                  className="field"
                  required
                  placeholder="如：11月第三周窗帘合排单 / MES-20261118光学膜分条"
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                />
                <label htmlFor="dp-mat">物料品号</label>
                <input
                  id="dp-mat"
                  className="field"
                  list="dp-mat-list"
                  required
                  value={materialModel}
                  onChange={(e) => setMaterialModel(e.target.value)}
                />
                <datalist id="dp-mat-list">
                  {materialOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <label htmlFor="dp-ext">外部/MES工单号</label>
                <input
                  id="dp-ext"
                  className="field"
                  placeholder="选填，对接 MES 工单核销时用于双向追溯"
                  value={externalRef}
                  onChange={(e) => setExternalRef(e.target.value)}
                />
              </>
            )}

            {createDim === 'SLITTING_1D' && (
              <>
                <label htmlFor="dp-slit-w">参考母卷幅宽 mm</label>
                <input
                  id="dp-slit-w"
                  type="number"
                  className="field num"
                  value={motherWidthMm}
                  onChange={(e) => setMotherWidthMm(Number(e.target.value))}
                />
                <label htmlFor="dp-slit-l">统一卷长 mm</label>
                <input
                  id="dp-slit-l"
                  type="number"
                  className="field num"
                  value={fixedLenMm}
                  onChange={(e) => setFixedLenMm(Number(e.target.value))}
                />
              </>
            )}
          </div>

          <div
            className="notice"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              margin: '0 0 10px',
              background: 'var(--panel-2)'
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>从需求模板快速带入：</span>
            <select
              className="field"
              style={{ flex: 1, height: 28 }}
              value={templateQuickId}
              onChange={(e) => setTemplateQuickId(e.target.value)}
            >
              <option value="">选择需求模板…</option>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  [{c.dimension}] {c.name} ({c.materialModel})
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={100}
              className="field num"
              style={{ width: 64, height: 28 }}
              value={templateQuickSets}
              onChange={(e) => setTemplateQuickSets(Number(e.target.value))}
            />
            <span style={{ fontSize: 12 }}>套</span>
            <button
              type="button"
              className="btn sm"
              disabled={!templateQuickId}
              onClick={handleAppendFromTemplateInModal}
            >
              展开追加
            </button>
          </div>

          <table className="t">
            <thead>
              <tr>
                <th>规格/裁片名称</th>
                <th className="r">{createDim === 'SLITTING_1D' ? '条宽 mm' : '宽 mm'}</th>
                {createDim !== 'SLITTING_1D' && <th className="r">长 mm</th>}
                <th className="r">需求数量</th>
                {createDim !== 'SLITTING_1D' && <th>允许旋转</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {draftLines.map((ln, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      className="field"
                      value={ln.name}
                      onChange={(e) =>
                        setDraftLines((arr) =>
                          arr.map((it, i) => (i === idx ? { ...it, name: e.target.value } : it))
                        )
                      }
                    />
                  </td>
                  <td className="r">
                    <input
                      type="number"
                      className="field num"
                      style={{ width: 82 }}
                      value={ln.width}
                      disabled={Boolean(ln.shape)}
                      onChange={(e) =>
                        setDraftLines((arr) =>
                          arr.map((it, i) =>
                            i === idx ? { ...it, width: Number(e.target.value) } : it
                          )
                        )
                      }
                    />
                  </td>
                  {createDim !== 'SLITTING_1D' && (
                    <td className="r">
                      <input
                        type="number"
                        className="field num"
                        style={{ width: 82 }}
                        value={ln.length}
                        disabled={Boolean(ln.shape)}
                        onChange={(e) =>
                          setDraftLines((arr) =>
                            arr.map((it, i) =>
                              i === idx ? { ...it, length: Number(e.target.value) } : it
                            )
                          )
                        }
                      />
                    </td>
                  )}
                  <td className="r">
                    <input
                      type="number"
                      min={1}
                      className="field num"
                      style={{ width: 72 }}
                      value={ln.quantity}
                      onChange={(e) =>
                        setDraftLines((arr) =>
                          arr.map((it, i) =>
                            i === idx ? { ...it, quantity: Number(e.target.value) } : it
                          )
                        )
                      }
                    />
                  </td>
                  {createDim !== 'SLITTING_1D' && (
                    <td>
                      <input
                        type="checkbox"
                        checked={ln.allowRotation}
                        onChange={(e) =>
                          setDraftLines((arr) =>
                            arr.map((it, i) =>
                              i === idx ? { ...it, allowRotation: e.target.checked } : it
                            )
                          )
                        }
                      />
                    </td>
                  )}
                  <td>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setDraftLines((arr) => arr.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                setDraftLines((arr) => [
                  ...arr,
                  {
                    name: `规格 #${arr.length + 1}`,
                    width: 600,
                    length: fixedLenMm || 1000,
                    quantity: 5,
                    allowRotation: false
                  }
                ])
              }
            >
              ＋ 新增规格行
            </button>
            <span className="sp" />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setShowCreateModal(false);
                setMergeTargetId('');
              }}
            >
              取消
            </button>
            <button type="submit" className="btn pri" disabled={submitting}>
              {submitting ? '正在保存…' : '保存至待排需求池'}
            </button>
          </div>
        </form>
      </ModalDialog>

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
                        dimension: e.target.value as any
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
