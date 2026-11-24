import React, { useEffect, useMemo, useState } from 'react';
import {
  useStudioStore,
  DemandCluster,
  ClusterTemplatePiece,
  expandClusterToDemands
} from '../store/useStudioStore';
import { ModalDialog } from '../components/ModalDialog';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { NumberInput } from '../components/ui/NumberInput';
import { requestJSON, toast } from '@static/app/js/util.js';

const CATEGORY_LABELS: Record<DemandCluster['category'], { label: string; tagClass: string }> = {
  DXF_GARMENT: { label: '服装/异形纸样', tagClass: 'run' },
  CURTAIN_2D: { label: '家纺窗帘矩形', tagClass: 'ok' },
  BOARD_2D: { label: '板材开料套系', tagClass: 'warn' },
  SLITTING_1D: { label: '一维定长分条', tagClass: 'kind' }
};

function PieceMiniSvg({ piece, sizeKey }: { piece: ClusterTemplatePiece; sizeKey: string }) {
  const geom = piece.sizes[sizeKey] || Object.values(piece.sizes)[0];
  if (!geom) return null;
  const w = geom.w || 100;
  const h = geom.h || 100;
  const pts =
    geom.v && geom.v.length >= 3
      ? geom.v.map(([x, y]) => `${x},${y}`).join(' ')
      : `0,0 ${w},0 ${w},${h} 0,${h}`;
  return (
    <div className="mp-tpl-piece-chip" title={`${piece.name} (${sizeKey}: ${w}×${h}mm)`}>
      <svg viewBox={`-8 -8 ${w + 16} ${h + 16}`} width="34" height="34" aria-hidden="true">
        <polygon
          points={pts}
          fill="rgba(91, 97, 246, 0.11)"
          stroke="#5b61f6"
          strokeWidth={Math.max(w, h) * 0.045}
        />
      </svg>
      <div className="mp-tpl-piece-meta">
        <b>
          {piece.name}
          {piece.pairMirror ? ' · 对称' : ''}
        </b>
        <span className="num">
          {Math.round(w)}×{Math.round(h)} · ×{piece.quantityPerUnit}
        </span>
      </div>
    </div>
  );
}

export const ClusterCenterPage: React.FC = () => {
  const {
    clusters,
    clusterSelections,
    syncTemplatesFromServer,
    setClusterCount,
    importDxfAsCluster,
    addCustomCluster,
    deleteCustomCluster,
    loadClusterInto2D,
    loadSelectedClustersInto2D,
    loadClusterInto1D
  } = useStudioStore();

  const [filterCat, setFilterCat] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [checkedIds, setCheckedIds] = useState<string[]>(['DXF_1226']);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [pushingToPool, setPushingToPool] = useState(false);

  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<DemandCluster['category']>('CURTAIN_2D');
  const [newMaterialModel, setNewMaterialModel] = useState('TC涤棉-B2026');
  const [newWidth, setNewWidth] = useState(2000);
  const [newLength, setNewLength] = useState(2400);
  const [newSizesText, setNewSizesText] = useState('S, M, L');
  const [newPieces, setNewPieces] = useState<
    { name: string; w: number; h: number; qty: number; grainRule: 'STRICT_0' | 'HALF_TURN_180' | 'FREE_90' }[]
  >([
    { name: '主部件 A', w: 600, h: 900, qty: 2, grainRule: 'STRICT_0' },
    { name: '辅件 B', w: 320, h: 480, qty: 2, grainRule: 'FREE_90' }
  ]);

  useEffect(() => {
    syncTemplatesFromServer();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clusters.filter((c) => {
      if (filterCat !== 'ALL' && c.category !== filterCat) return false;
      if (!q) return true;
      const pieceText = c.pieces.map((p) => p.name).join(' ');
      return `${c.name} ${c.code} ${c.materialModel} ${c.description} ${pieceText}`
        .toLowerCase()
        .includes(q);
    });
  }, [clusters, filterCat, search]);

  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleDxfFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      setCheckedIds((prev) => [created.id, ...prev]);
      toast(`已解析并持久化需求模板：${created.name}（${created.pieces.length} 种部件）`);
    } catch (err: any) {
      toast('DXF 纸样导入失败：' + err.message, true);
    } finally {
      e.target.value = '';
    }
  };

  const handleCreateCustomCluster = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPieces.length) return;
    const isSlit = newCategory === 'SLITTING_1D';
    const sizes = isSlit
      ? ['标准批次']
      : newSizesText
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
    const sizeList = sizes.length ? sizes : ['标准规格'];
    const defaultCounts: Record<string, number> = {};
    sizeList.forEach((sz, idx) => {
      defaultCounts[sz] = idx === 0 ? 1 : 0;
    });

    const cluster: DemandCluster = {
      id: 'TPL_' + Date.now().toString(36).toUpperCase(),
      name: newName.trim(),
      code: 'TPL-' + Date.now().toString(36).slice(-4).toUpperCase(),
      category: newCategory,
      dimension: isSlit ? '1D' : '2D',
      subDimension: isSlit ? 'SLITTING_1D' : newCategory === 'DXF_GARMENT' ? 'CONTOUR_2D' : 'RECT_2D',
      description: `包含 ${newPieces.map((p) => p.name).join('、')}，用于快速展开拼凑排程需求`,
      defaultWidthMm: Number(newWidth) || 1650,
      defaultLengthMm: Number(newLength) || 2000,
      materialModel: newMaterialModel.trim() || 'CUSTOM-' + newName.trim().slice(0, 8),
      availableSizes: sizeList,
      defaultSizeCounts: defaultCounts,
      custom: true,
      pieces: newPieces.map((p) => {
        const sizeMap: Record<string, { w: number; h: number }> = {};
        sizeList.forEach((sz, idx) => {
          const scale = isSlit ? 1 : 1 + idx * 0.06;
          sizeMap[sz] = {
            w: Math.round(p.w * scale),
            h: isSlit ? Number(newLength) || p.h : Math.round(p.h * scale)
          };
        });
        return {
          name: p.name,
          quantityPerUnit: Math.max(1, Number(p.qty) || 1),
          grainRule: isSlit ? 'STRICT_0' : p.grainRule,
          sizes: sizeMap
        };
      })
    };
    addCustomCluster(cluster);
    setCheckedIds((prev) => [cluster.id, ...prev]);
    setShowCreateModal(false);
    setNewName('');
    toast(`已保存需求模板「${cluster.name}」`);
  };

  const handleExpandToDemandPool = async (targetClusters: DemandCluster[]) => {
    if (!targetClusters.length || pushingToPool) return;
    setPushingToPool(true);
    try {
      const first = targetClusters[0];
      const is1D = first.dimension === '1D';
      const compatible = targetClusters.filter((c) => c.dimension === first.dimension);
      let nextId = 1;
      const demandLines: any[] = [];

      for (const c of compatible) {
        const counts = clusterSelections[c.id] || c.defaultSizeCounts;
        const effectiveCounts = Object.values(counts).some((v) => v > 0)
          ? counts
          : { [c.availableSizes[0]]: 1 };
        if (is1D) {
          const mult = Math.max(
            1,
            Object.values(effectiveCounts).reduce((s, n) => s + (Number(n) || 0), 0)
          );
          for (const p of c.pieces) {
            const g = Object.values(p.sizes)[0];
            demandLines.push({
              id: nextId++,
              name: p.name,
              width: g.w,
              length: g.h,
              quantity: p.quantityPerUnit * mult,
              allowRotation: false,
              sourceTemplateId: c.id
            });
          }
        } else {
          const expanded = expandClusterToDemands(c, effectiveCounts, nextId);
          for (const item of expanded) {
            demandLines.push({
              id: item.id,
              name: compatible.length > 1 ? `${c.code} · ${item.name}` : item.name,
              width: item.width,
              length: item.length,
              quantity: item.quantity,
              allowRotation: Boolean(item.allowRotation),
              allowHalfTurn: Boolean(item.allowHalfTurn),
              sizeLabel: item.sizeLabel,
              sourceTemplateId: c.id,
              shape: item.shape
            });
          }
          nextId = demandLines.reduce((m, d) => Math.max(m, d.id), 0) + 1;
        }
      }

      const hasPoly = demandLines.some((d) => d.shape?.type === 'POLYGON');
      const dim = is1D ? 'SLITTING_1D' : hasPoly ? 'CONTOUR_2D' : 'RECT_2D';
      const famName =
        compatible.length === 1
          ? `${first.name} · 排程批次`
          : `${first.name} 等 ${compatible.length} 模板合排需求族`;

      await requestJSON('/api/v2/demand-pool', {
        name: famName,
        materialModel: first.materialModel,
        externalRef: `模板展开 (${compatible.map((c) => c.code).join('+')})`,
        dimension: dim,
        bedLengthMm: first.defaultLengthMm,
        maxWidthMm: Math.round(first.defaultWidthMm),
        demands: demandLines
      });

      toast(`已生成排程需求族「${famName}」（共 ${demandLines.length} 项规格），可随时拼单排程`);
      location.hash = '#/demands';
    } catch (err: any) {
      toast('加入待排需求池失败：' + err.message, true);
    } finally {
      setPushingToPool(false);
    }
  };

  const selectedTemplates = clusters.filter((c) => checkedIds.includes(c.id));

  const categoryOptions: SegmentedOption<string>[] = useMemo(
    () => [
      { value: 'ALL', label: '全部模板', count: clusters.length },
      {
        value: 'DXF_GARMENT',
        label: '二维异形纸样',
        count: clusters.filter((c) => c.category === 'DXF_GARMENT').length
      },
      {
        value: 'CURTAIN_2D',
        label: '二维家纺窗帘',
        count: clusters.filter((c) => c.category === 'CURTAIN_2D').length
      },
      {
        value: 'BOARD_2D',
        label: '二维板材开料',
        count: clusters.filter((c) => c.category === 'BOARD_2D').length
      },
      {
        value: 'SLITTING_1D',
        label: '一维定长分条',
        count: clusters.filter((c) => c.category === 'SLITTING_1D').length
      }
    ],
    [clusters]
  );

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>需求模板库</h1>
            <span className="mp-page-summary num">
              {clusters.length} 个模板 · 已勾选 {selectedTemplates.length} 项用于拼单
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
              aria-label="搜索需求模板"
              placeholder="筛选模板名称、编号、物料品号或部件"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <span className="mp-toolbar-count num">
            显示 {filtered.length} / {clusters.length}
          </span>

          <div className="mp-toolbar-actions">
            <label className="mp-ghost-btn" style={{ cursor: 'pointer' }}>
              导入 CAD DXF 模板
              <input type="file" accept=".dxf" hidden onChange={handleDxfFileUpload} />
            </label>
            <button
              type="button"
              className="mp-ghost-btn"
              disabled={!selectedTemplates.length || pushingToPool}
              onClick={() => handleExpandToDemandPool(selectedTemplates)}
            >
              展开加入需求池 ({selectedTemplates.length})
            </button>
            <button
              type="button"
              className="btn soft-accent"
              disabled={!selectedTemplates.length}
              onClick={() => {
                loadSelectedClustersInto2D(checkedIds, false);
                location.hash = '#/workbench';
              }}
            >
              拼凑直达搭切工作台 ({selectedTemplates.length}) →
            </button>
            <button type="button" className="btn pri" onClick={() => setShowCreateModal(true)}>
              ＋ 新建需求模板
            </button>
          </div>
        </div>

        <div className="mp-tpl-seg-row">
          <SegmentedControl
            options={categoryOptions}
            value={filterCat}
            onChange={(next) => setFilterCat(next)}
            ariaLabel="模板分类筛选"
          />
          <span className="mp-toolbar-count num">
            维护款式纸样、套板与分条 BOM 配方 · 按配码套数展开排程
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="mp-empty-card">
            <strong>暂无匹配的需求模板</strong>
            <p>
              可调整上方搜索关键词或切换维度分类，也可以导入 CAD DXF 纸样或新建自定义需求模板。
            </p>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setFilterCat('ALL');
                  setSearch('');
                }}
              >
                重置筛选
              </button>
              <button
                type="button"
                className="btn soft-accent"
                onClick={() => setShowCreateModal(true)}
              >
                ＋ 新建需求模板
              </button>
            </div>
          </div>
        ) : (
          <div className="mp-tpl-grid">
            {filtered.map((cluster) => {
              const catMeta = CATEGORY_LABELS[cluster.category];
              const counts = clusterSelections[cluster.id] || cluster.defaultSizeCounts;
              const totalUnits = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
              const perUnitPieces = cluster.pieces.reduce((s, p) => s + p.quantityPerUnit, 0);
              const totalPieces = Math.max(1, totalUnits) * perUnitPieces;
              const isChecked = checkedIds.includes(cluster.id);
              const previewSize =
                cluster.availableSizes.find((sz) => (counts[sz] || 0) > 0) ||
                cluster.availableSizes[0];

              return (
                <article
                  key={cluster.id}
                  className={`mp-tpl-card ${isChecked ? 'is-checked' : ''}`}
                >
                  <header className="mp-tpl-card-head">
                    <label className="mp-tpl-title-wrap">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCheck(cluster.id)}
                      />
                      <strong>{cluster.name}</strong>
                      <CodeBadge>{cluster.code}</CodeBadge>
                    </label>
                    <div className="mp-tpl-head-right">
                      <span className={`tag ${catMeta.tagClass}`}>{catMeta.label}</span>
                      {cluster.custom && (
                        <button
                          type="button"
                          className="mp-ghost-btn mp-ghost-sm mp-btn-danger-ghost"
                          style={{ height: 22, padding: '0 6px', fontSize: 11.5 }}
                          title="删除自定义需求模板"
                          onClick={() => deleteCustomCluster(cluster.id)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </header>

                  <p className="mp-tpl-desc">{cluster.description}</p>

                  <div className="mp-tpl-spec-bar num">
                    <span>
                      品号 <b>{cluster.materialModel}</b>
                    </span>
                    <span>
                      标准门幅 <b>{cluster.defaultWidthMm} mm</b>
                    </span>
                    <span>
                      展开量{' '}
                      <b className="is-accent">
                        {totalUnits || 1} 套 · {totalPieces}{' '}
                        {cluster.dimension === '1D' ? '卷' : '片'}
                      </b>
                    </span>
                  </div>

                  <div className="mp-tpl-pieces">
                    {cluster.pieces.slice(0, 8).map((p, idx) => (
                      <PieceMiniSvg key={idx} piece={p} sizeKey={previewSize} />
                    ))}
                    {cluster.pieces.length > 8 && (
                      <div className="mp-tpl-piece-more">+{cluster.pieces.length - 8} 种部件</div>
                    )}
                  </div>

                  <div className="mp-tpl-sizes">
                    <small>选取配码 / 批次套数</small>
                    <div className="mp-tpl-size-pills">
                      {cluster.availableSizes.map((sz) => (
                        <label
                          key={sz}
                          className={`mp-tpl-size-pill ${(counts[sz] || 0) > 0 ? 'active' : ''}`}
                        >
                          <span>{sz}</span>
                          <NumberInput
                            min={0}
                            max={200}
                            fallback={0}
                            integer
                            className="num"
                            value={counts[sz] ?? 0}
                            onValueChange={(v) => setClusterCount(cluster.id, sz, v)}
                          />
                        </label>
                      ))}
                    </div>
                  </div>

                  <footer className="mp-tpl-card-actions">
                    <button
                      type="button"
                      className="btn sm soft-accent"
                      onClick={() => {
                        if (cluster.dimension === '1D') {
                          loadClusterInto1D(cluster.id, false);
                        } else {
                          loadClusterInto2D(cluster.id, false);
                        }
                        location.hash = '#/workbench';
                      }}
                    >
                      送入搭切工作台 →
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={pushingToPool}
                      onClick={() => handleExpandToDemandPool([cluster])}
                    >
                      展开入需求池
                    </button>
                    <button
                      type="button"
                      className="mp-ghost-btn mp-ghost-sm"
                      onClick={() => {
                        if (cluster.dimension === '1D') {
                          loadClusterInto1D(cluster.id, true);
                        } else {
                          loadClusterInto2D(cluster.id, true);
                        }
                        toast(`已将「${cluster.name}」追加拼入工作台待排清单`);
                      }}
                    >
                      ＋ 追加合排
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <ModalDialog
        open={showCreateModal}
        title="新建可复用需求模板（支持二维套系与一维分条）"
        onClose={() => setShowCreateModal(false)}
        maxWidth={720}
      >
        <form onSubmit={handleCreateCustomCluster}>
          <div className="form" style={{ gridTemplateColumns: '115px 1fr', padding: '4px 0 12px' }}>
            <label htmlFor="new-cluster-name">模板名称</label>
            <input
              id="new-cluster-name"
              className="field"
              required
              autoFocus
              placeholder="如：2026秋季工装夹克 / 酒店遮光窗帘套系 / 1200mm保护膜分条组"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <label htmlFor="new-cluster-cat">需求维度与类型</label>
            <select
              id="new-cluster-cat"
              className="field"
              value={newCategory}
              onChange={(e) => {
                const val = e.target.value as DemandCluster['category'];
                setNewCategory(val);
                if (val === 'SLITTING_1D') {
                  setNewWidth(4600);
                  setNewLength(2000);
                  setNewMaterialModel('光学膜-4600');
                } else if (val === 'BOARD_2D') {
                  setNewWidth(1220);
                  setNewLength(2440);
                  setNewMaterialModel('定制板材-1220');
                }
              }}
            >
              <option value="CURTAIN_2D">二维矩形套系（窗帘 / 家纺 / 工业卷材）</option>
              <option value="BOARD_2D">二维板材直刀开料（家具 / 柜体 / 玻璃）</option>
              <option value="SLITTING_1D">一维定长分条（薄膜 / 金属卷 / 涂层面料）</option>
            </select>
            <label htmlFor="new-cluster-mat">默认物料品号</label>
            <input
              id="new-cluster-mat"
              className="field"
              value={newMaterialModel}
              onChange={(e) => setNewMaterialModel(e.target.value)}
              placeholder="用于自动匹配同材质需求族与在库母卷"
            />
            <label htmlFor="new-cluster-w">推荐母卷门幅 mm</label>
            <NumberInput
              id="new-cluster-w"
              min={100}
              className="field num"
              value={newWidth}
              onValueChange={setNewWidth}
            />
            <label htmlFor="new-cluster-l">
              {newCategory === 'SLITTING_1D' ? '标准定长卷长 mm' : '预设画布版长 mm'}
            </label>
            <NumberInput
              id="new-cluster-l"
              min={100}
              className="field num"
              value={newLength}
              onValueChange={setNewLength}
            />
            {newCategory !== 'SLITTING_1D' && (
              <>
                <label htmlFor="new-cluster-sizes">尺码/规格档位</label>
                <input
                  id="new-cluster-sizes"
                  className="field"
                  value={newSizesText}
                  onChange={(e) => setNewSizesText(e.target.value)}
                  placeholder="逗号分隔，如 S, M, L 或 标准高, 挑空高"
                />
              </>
            )}
          </div>

          <div className="sec" style={{ margin: '0 -16px' }}>
            组成部件 / 分条明细
          </div>
          <div className="mp-table-scroll" style={{ marginTop: 8 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>部件 / 条宽名称</th>
                  <th className="r">{newCategory === 'SLITTING_1D' ? '条宽 mm' : '基准宽 mm'}</th>
                  {newCategory !== 'SLITTING_1D' && <th className="r">基准长 mm</th>}
                  <th className="r">{newCategory === 'SLITTING_1D' ? '每批卷数' : '每套数量'}</th>
                  {newCategory !== 'SLITTING_1D' && <th>丝缕/旋转方向</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {newPieces.map((p, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        className="field"
                        value={p.name}
                        onChange={(e) =>
                          setNewPieces((arr) =>
                            arr.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item))
                          )
                        }
                      />
                    </td>
                    <td className="r">
                      <NumberInput
                        min={1}
                        className="field num"
                        style={{ width: 82 }}
                        value={p.w}
                        onValueChange={(v) =>
                          setNewPieces((arr) =>
                            arr.map((item, i) => (i === idx ? { ...item, w: v } : item))
                          )
                        }
                      />
                    </td>
                    {newCategory !== 'SLITTING_1D' && (
                      <td className="r">
                        <NumberInput
                          min={1}
                          className="field num"
                          style={{ width: 82 }}
                          value={p.h}
                          onValueChange={(v) =>
                            setNewPieces((arr) =>
                              arr.map((item, i) => (i === idx ? { ...item, h: v } : item))
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="r">
                      <NumberInput
                        min={1}
                        integer
                        className="field num"
                        style={{ width: 64 }}
                        value={p.qty}
                        onValueChange={(v) =>
                          setNewPieces((arr) =>
                            arr.map((item, i) => (i === idx ? { ...item, qty: v } : item))
                          )
                        }
                      />
                    </td>
                    {newCategory !== 'SLITTING_1D' && (
                      <td>
                        <select
                          className="field"
                          style={{ height: 26, fontSize: 12 }}
                          value={p.grainRule}
                          onChange={(e) =>
                            setNewPieces((arr) =>
                              arr.map((item, i) =>
                                i === idx ? { ...item, grainRule: e.target.value as any } : item
                              )
                            )
                          }
                        >
                          <option value="STRICT_0">严格 0° 经向</option>
                          <option value="FREE_90">允许 90° 旋转</option>
                        </select>
                      </td>
                    )}
                    <td>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setNewPieces((arr) => arr.filter((_, i) => i !== idx))}
                      >
                        移除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                setNewPieces((arr) => [
                  ...arr,
                  {
                    name: `规格 ${arr.length + 1}`,
                    w: 450,
                    h: 650,
                    qty: 2,
                    grainRule: 'STRICT_0'
                  }
                ])
              }
            >
              ＋ 添加部件
            </button>
            <span className="sp" />
            <button type="button" className="btn" onClick={() => setShowCreateModal(false)}>
              取消
            </button>
            <button type="submit" className="btn pri">
              保存需求模板
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
};
