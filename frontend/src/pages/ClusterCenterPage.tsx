import React, { useState } from 'react';
import { useStudioStore, DemandCluster, ClusterTemplatePiece } from '../store/useStudioStore';
import { toast } from '@static/app/js/util.js';

const CATEGORY_LABELS: Record<DemandCluster['category'], { label: string; tagClass: string }> = {
  DXF_GARMENT: { label: '服装 CAD 纸样簇 (DXF)', tagClass: 'run' },
  CURTAIN_2D: { label: '家纺窗帘套系簇 (2D)', tagClass: 'ok' },
  BOARD_2D: { label: '板材开料套系簇 (2D)', tagClass: 'warn' },
  SLITTING_1D: { label: '一维定长分条簇 (1D)', tagClass: 'kind' }
};

function PieceMiniSvg({ piece, sizeKey }: { piece: ClusterTemplatePiece; sizeKey: string }) {
  const geom = piece.sizes[sizeKey] || Object.values(piece.sizes)[0];
  if (!geom) return null;
  const w = geom.w || 100;
  const h = geom.h || 100;
  const pts = geom.v && geom.v.length >= 3
    ? geom.v.map(([x, y]) => `${x},${y}`).join(' ')
    : `0,0 ${w},0 ${w},${h} 0,${h}`;
  return (
    <div className="cluster-piece-chip" title={`${piece.name} (${sizeKey}: ${w}×${h}mm)`}>
      <svg viewBox={`-8 -8 ${w + 16} ${h + 16}`} width="42" height="42">
        <polygon
          points={pts}
          fill="rgba(37, 99, 235, 0.16)"
          stroke="#2563eb"
          strokeWidth={Math.max(w, h) * 0.04}
        />
      </svg>
      <div className="cluster-piece-meta">
        <b>{piece.name}{piece.pairMirror ? ' (左右对称)' : ''}</b>
        <span className="num">{Math.round(w)}×{Math.round(h)} mm · ×{piece.quantityPerUnit}</span>
      </div>
    </div>
  );
}

export const ClusterCenterPage: React.FC = () => {
  const {
    clusters,
    clusterSelections,
    setClusterCount,
    importDxfAsCluster,
    addCustomCluster,
    loadClusterInto2D,
    loadSelectedClustersInto2D,
    loadClusterInto1D
  } = useStudioStore();

  const [filterCat, setFilterCat] = useState<string>('ALL');
  const [checkedIds, setCheckedIds] = useState<string[]>(['DXF_1226']);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // New custom cluster form state
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<DemandCluster['category']>('CURTAIN_2D');
  const [newWidth, setNewWidth] = useState(1650);
  const [newLength, setNewLength] = useState(2400);
  const [newSizesText, setNewSizesText] = useState('S, M, L');
  const [newPieces, setNewPieces] = useState<{ name: string; w: number; h: number; qty: number }[]>([
    { name: '主裁片 A', w: 520, h: 680, qty: 2 },
    { name: '配片 B', w: 320, h: 420, qty: 2 }
  ]);

  const filtered = clusters.filter((c) => filterCat === 'ALL' || c.category === filterCat);

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
      toast(`成功解析并创建纸样簇：${created.name}（${created.pieces.length} 种裁片）`);
    } catch (err: any) {
      toast('DXF 纸样簇导入失败：' + err.message, true);
    } finally {
      e.target.value = '';
    }
  };

  const handleCreateCustomCluster = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPieces.length) return;
    const sizes = newSizesText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const sizeList = sizes.length ? sizes : ['标准码'];
    const defaultCounts: Record<string, number> = {};
    sizeList.forEach((sz, idx) => {
      defaultCounts[sz] = idx === 0 ? 1 : 0;
    });

    const cluster: DemandCluster = {
      id: 'CUSTOM_' + Date.now().toString(36).toUpperCase(),
      name: newName.trim(),
      code: 'TPL-' + Date.now().toString(36).slice(-4).toUpperCase(),
      category: newCategory,
      dimension: newCategory === 'SLITTING_1D' ? '1D' : '2D',
      description: `自定义模板簇（包含 ${newPieces.map((p) => p.name).join('、')}，支持按尺码阶梯缩放）`,
      defaultWidthMm: Number(newWidth) || 1650,
      defaultLengthMm: Number(newLength) || 2400,
      materialModel: 'CUSTOM-' + newName.trim().slice(0, 8),
      availableSizes: sizeList,
      defaultSizeCounts: defaultCounts,
      pieces: newPieces.map((p) => {
        const sizeMap: Record<string, { w: number; h: number }> = {};
        sizeList.forEach((sz, idx) => {
          const scale = 1 + idx * 0.06; // Automatic 6% grading per size step
          sizeMap[sz] = {
            w: Math.round(p.w * scale),
            h: Math.round(p.h * scale)
          };
        });
        return {
          name: p.name,
          quantityPerUnit: Math.max(1, Number(p.qty) || 1),
          sizes: sizeMap
        };
      })
    };
    addCustomCluster(cluster);
    setCheckedIds((prev) => [cluster.id, ...prev]);
    setShowCreateModal(false);
    setNewName('');
    toast(`已创建需求模板簇「${cluster.name}」`);
  };

  return (
    <div className="react-page">
      <div className="ph">
        <h1>需求与纸样簇库</h1>
        <span className="crumb">按款式/套系集中管理固定形状与多尺码模板 · 勾选几个簇即可直接送入二维或一维工作台</span>
        <span className="sp" />
        <label className="btn" style={{ cursor: 'pointer' }}>
          ＋ 导入 CAD DXF 为纸样簇
          <input type="file" accept=".dxf" hidden onChange={handleDxfFileUpload} />
        </label>
        <button type="button" className="btn" onClick={() => setShowCreateModal(true)}>
          ＋ 新建规格模板簇
        </button>
        <button
          type="button"
          className="btn pri"
          disabled={!checkedIds.length}
          onClick={() => {
            loadSelectedClustersInto2D(checkedIds, false);
            location.hash = '#/workbench';
          }}
        >
          将已选簇 ({checkedIds.length}) 送入二维画布搭切 →
        </button>
      </div>

      <div className="toolbar">
        <div className="seg">
          {[
            ['ALL', `全部簇 (${clusters.length})`],
            ['DXF_GARMENT', '服装 DXF 纸样簇'],
            ['CURTAIN_2D', '窗帘家纺簇'],
            ['BOARD_2D', '板材套系簇'],
            ['SLITTING_1D', '一维分条簇']
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={filterCat === k ? 'on' : ''}
              onClick={() => setFilterCat(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="sp" />
        <span className="muted" style={{ fontSize: 12 }}>
          提示：在下方每个簇卡片中直接调整各尺码件数（如 120码×2 + 140码×1），一键送入画布，免去逐行填表。
        </span>
      </div>

      {showCreateModal && (
        <div className="react-modal-backdrop">
          <form className="box react-modal" onSubmit={handleCreateCustomCluster}>
            <div className="pane-h">
              新建需求/纸样模板簇
              <span className="sp" />
              <button type="button" className="btn sm" onClick={() => setShowCreateModal(false)}>
                关闭
              </button>
            </div>
            <div className="pane-b" style={{ padding: 14 }}>
              <div className="form" style={{ gridTemplateColumns: '110px 1fr' }}>
                <label>簇名称</label>
                <input
                  className="field"
                  required
                  placeholder="如：2026秋季工装夹克簇 / 酒店标准窗帘簇"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <label>所属类型</label>
                <select
                  className="field"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as any)}
                >
                  <option value="CURTAIN_2D">二维矩形套系簇（窗帘/家纺）</option>
                  <option value="BOARD_2D">二维板材开料簇（家具/柜体）</option>
                  <option value="SLITTING_1D">一维定长分条簇（薄膜/卷材）</option>
                </select>
                <label>预设画布幅宽</label>
                <input
                  type="number"
                  className="field num"
                  value={newWidth}
                  onChange={(e) => setNewWidth(Number(e.target.value))}
                />
                <label>预设画布长度</label>
                <input
                  type="number"
                  className="field num"
                  value={newLength}
                  onChange={(e) => setNewLength(Number(e.target.value))}
                />
                <label>尺码/规格档位</label>
                <input
                  className="field"
                  value={newSizesText}
                  onChange={(e) => setNewSizesText(e.target.value)}
                  placeholder="用逗号分隔，如 S, M, L 或 110, 120, 130"
                />
              </div>
              <div className="sec">簇内固定组成部件（基准码尺寸，其余档位自动按阶梯放码）</div>
              <table className="t">
                <thead>
                  <tr>
                    <th>部件名称</th>
                    <th className="r">基准宽 mm</th>
                    <th className="r">基准长 mm</th>
                    <th className="r">每套数量</th>
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
                        <input
                          type="number"
                          className="field num"
                          style={{ width: 85 }}
                          value={p.w}
                          onChange={(e) =>
                            setNewPieces((arr) =>
                              arr.map((item, i) => (i === idx ? { ...item, w: Number(e.target.value) } : item))
                            )
                          }
                        />
                      </td>
                      <td className="r">
                        <input
                          type="number"
                          className="field num"
                          style={{ width: 85 }}
                          value={p.h}
                          onChange={(e) =>
                            setNewPieces((arr) =>
                              arr.map((item, i) => (i === idx ? { ...item, h: Number(e.target.value) } : item))
                            )
                          }
                        />
                      </td>
                      <td className="r">
                        <input
                          type="number"
                          className="field num"
                          style={{ width: 65 }}
                          value={p.qty}
                          onChange={(e) =>
                            setNewPieces((arr) =>
                              arr.map((item, i) => (i === idx ? { ...item, qty: Number(e.target.value) } : item))
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => setNewPieces((arr) => arr.filter((_, i) => i !== idx))}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    setNewPieces((arr) => [...arr, { name: `部件 ${arr.length + 1}`, w: 400, h: 600, qty: 1 }])
                  }
                >
                  ＋ 添加部件
                </button>
                <span className="sp" />
                <button type="submit" className="btn pri">
                  保存为需求簇
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="body">
        <div className="cluster-grid">
          {filtered.map((cluster) => {
            const catMeta = CATEGORY_LABELS[cluster.category];
            const counts = clusterSelections[cluster.id] || cluster.defaultSizeCounts;
            const totalUnits = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
            const perUnitPieces = cluster.pieces.reduce((s, p) => s + p.quantityPerUnit, 0);
            const totalPieces = Math.max(1, totalUnits) * perUnitPieces;
            const isChecked = checkedIds.includes(cluster.id);
            const previewSize =
              cluster.availableSizes.find((sz) => (counts[sz] || 0) > 0) || cluster.availableSizes[0];

            return (
              <article
                key={cluster.id}
                className={`cluster-card ${isChecked ? 'selected' : ''}`}
              >
                <div className="cluster-card-head">
                  <label className="cluster-check">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleCheck(cluster.id)}
                    />
                    <strong>{cluster.name}</strong>
                  </label>
                  <span className={`tag ${catMeta.tagClass}`}>{catMeta.label}</span>
                </div>

                <p className="cluster-desc">{cluster.description}</p>

                <div className="cluster-spec-bar">
                  <span>预设门幅/母卷：<b className="num">{cluster.defaultWidthMm} mm</b></span>
                  <span>每套含裁片：<b className="num">{perUnitPieces} 片 ({cluster.pieces.length} 种部件)</b></span>
                  <span>当前选配：<b className="num" style={{ color: 'var(--accent)' }}>{totalUnits || 1} 套 · 共 {totalPieces} 片</b></span>
                </div>

                <div className="cluster-pieces-preview">
                  {cluster.pieces.slice(0, 8).map((p, idx) => (
                    <PieceMiniSvg key={idx} piece={p} sizeKey={previewSize} />
                  ))}
                  {cluster.pieces.length > 8 && (
                    <div className="cluster-piece-more">
                      +{cluster.pieces.length - 8} 种裁片
                    </div>
                  )}
                </div>

                <div className="cluster-sizes-box">
                  <small>尺码 / 规格配比（直接输入件/套数）：</small>
                  <div className="cluster-size-inputs">
                    {cluster.availableSizes.map((sz) => (
                      <label key={sz} className={(counts[sz] || 0) > 0 ? 'active' : ''}>
                        <span>{sz}</span>
                        <input
                          type="number"
                          min={0}
                          max={50}
                          className="field num"
                          value={counts[sz] ?? 0}
                          onChange={(e) => setClusterCount(cluster.id, sz, Number(e.target.value))}
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="cluster-card-actions">
                  {cluster.dimension === '1D' ? (
                    <button
                      type="button"
                      className="btn sm pri"
                      onClick={() => {
                        loadClusterInto1D(cluster.id);
                        location.hash = '#/slitting';
                      }}
                    >
                      载入一维分切台 →
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn sm pri"
                        onClick={() => {
                          loadClusterInto2D(cluster.id, false);
                          location.hash = '#/workbench';
                        }}
                      >
                        独立送入二维画布 →
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          loadClusterInto2D(cluster.id, true);
                          toast(`已将「${cluster.name}」追加到当前二维待排列表`);
                        }}
                      >
                        ＋ 追加到当前画布合排
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
};
