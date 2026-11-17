import React, { useEffect, useMemo, useState } from 'react';
import {
  requestJSON,
  fmtM,
  fmtN,
  toast,
  idempotentPost,
  pendingWrite,
  retryWrite,
  dropWrite
} from '@static/app/js/util.js';
import { workflowTemplate } from '@static/app/js/model/showcase.js';

const ROLL_QUALITY_MAP: Record<string, [string, string]> = {
  PASSED: ['合格', 'ok'],
  PENDING: ['待检', 'warn'],
  FAILED: ['不合格', 'err'],
  QUARANTINED: ['隔离', 'err']
};

const REMNANT_STATUS_MAP: Record<string, [string, string]> = {
  AVAILABLE: ['可用', 'ok'],
  RESERVED: ['已预约', 'run'],
  CONSUMED: ['已消耗', ''],
  SCRAPPED: ['已报废', ''],
  QUARANTINED: ['隔离', 'err']
};

const ACTION_TITLES: Record<string, string> = {
  receive: '母卷入库',
  transfer: '移库',
  count: '盘点',
  scrap: '料头报废'
};

interface CountRowState {
  present: boolean;
  width: string | number;
  length: string | number;
}

export const InventoryPage: React.FC<{ params?: string[] }> = ({ params = [] }) => {
  const [intent, templateId] = params;

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<'roll' | 'rem'>('roll');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterModel, setFilterModel] = useState<string>('');
  const [filterLoc, setFilterLoc] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<'receive' | 'transfer' | 'count' | 'scrap' | null>(
    null
  );
  const [opts, setOpts] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);

  // Action form fields
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');
  const [rollIdInput, setRollIdInput] = useState('');
  const [rollModelInput, setRollModelInput] = useState('');
  const [widthInput, setWidthInput] = useState<string | number>('');
  const [lengthInput, setLengthInput] = useState<string | number>('');
  const [scrapId, setScrapId] = useState('');
  const [countsMap, setCountsMap] = useState<Record<string, CountRowState>>({});

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, rem] = await Promise.all([
        requestJSON('/api/rolls'),
        requestJSON('/api/remnants')
      ]);
      setRolls(r || []);
      setRemnants(rem || []);
    } catch (e: any) {
      setError(e.message || '读取库存档案失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const openActionPanel = async (
    kind: 'receive' | 'transfer' | 'count' | 'scrap',
    extra: any = {}
  ) => {
    setAction(kind);
    setReason('');
    setOpts(null);
    if (extra.rollId !== undefined) setRollIdInput(extra.rollId);
    if (extra.rollModel !== undefined) setRollModelInput(extra.rollModel);
    if (extra.width !== undefined) setWidthInput(extra.width);
    if (extra.length !== undefined) setLengthInput(extra.length);
    if (extra.scrapId !== undefined) setScrapId(extra.scrapId);

    if (kind === 'transfer' || kind === 'count') {
      try {
        const res = await requestJSON(
          `/api/v2/inventory-${kind === 'transfer' ? 'transfers' : 'counts'}/options`
        );
        setOpts(res);
      } catch (e: any) {
        toast(e.message, true);
      }
    }
  };

  useEffect(() => {
    if (intent === 'receive') {
      const tpl = templateId ? workflowTemplate(templateId) : null;
      openActionPanel(
        'receive',
        tpl
          ? {
              ...tpl.material,
              rollId: 'DEMO-' + crypto.randomUUID().slice(0, 8)
            }
          : {}
      );
    }
  }, [intent, templateId]);

  const isRoll = tab === 'roll';
  const allItems = isRoll ? rolls : remnants;
  const fieldKeys = isRoll
    ? { model: 'rollModel', loc: 'storageLocation', status: 'inspectionStatus' }
    : { model: 'materialBatch', loc: 'location', status: 'status' };

  const distinctOptions = (rows: any[], key: string) =>
    [...new Set(rows.map((x) => x[key]).filter(Boolean))].sort();

  const idOf = (rollMode: boolean, item: any) =>
    `${rollMode ? 'roll' : 'remnant'}:${rollMode ? item.rollId : item.id}`;

  const filteredList = useMemo(() => {
    const qLower = searchQuery.trim().toLowerCase();
    return allItems.filter(
      (x) =>
        (!filterModel || x[fieldKeys.model] === filterModel) &&
        (!filterLoc || x[fieldKeys.loc] === filterLoc) &&
        (!filterStatus || x[fieldKeys.status] === filterStatus) &&
        (!qLower ||
          JSON.stringify([
            x.rollId,
            x.id,
            x.rollModel,
            x.materialName,
            x.materialBatch,
            x.storageLocation,
            x.location,
            x.sourceRollId
          ])
            .toLowerCase()
            .includes(qLower))
    );
  }, [allItems, fieldKeys.model, fieldKeys.loc, fieldKeys.status, filterModel, filterLoc, filterStatus, searchQuery]);

  const currentItem =
    filteredList[Math.min(selectedIndex, Math.max(0, filteredList.length - 1))] || null;

  const pendings = useMemo(() => {
    void pendingTick;
    return (['transfer', 'count'] as const)
      .map((s) => [s, pendingWrite(s)] as const)
      .filter(([, v]) => Boolean(v));
  }, [pendingTick, busy]);

  const selectedMaterials = useMemo(() => {
    return [...picked].map((s) => {
      const [type, id] = s.split(':');
      const m = opts?.materials?.find((x: any) => x.type === type && x.id === id);
      return { type, id, m };
    });
  }, [picked, opts]);

  const blockedMaterials = useMemo(
    () => selectedMaterials.filter((x) => !x.m?.allowed),
    [selectedMaterials]
  );

  const getCountRow = (key: string): CountRowState => {
    if (countsMap[key]) return countsMap[key];
    const [type, mid] = key.split(':');
    const m = opts?.materials?.find((x: any) => x.type === type && x.id === mid);
    return {
      present: true,
      width: m?.width ?? '',
      length: m?.length ?? ''
    };
  };

  const updateCountRow = (key: string, patch: Partial<CountRowState>) => {
    const cur = getCountRow(key);
    setCountsMap((prev) => ({
      ...prev,
      [key]: { ...cur, ...patch }
    }));
  };

  const handleSubmitAction = async () => {
    if (!action || busy) return;
    setBusy(true);
    try {
      if (action === 'receive') {
        const body = {
          rollId: String(rollIdInput).trim(),
          rollModel: String(rollModelInput).trim(),
          width: Number(widthInput),
          totalLength: Math.round(Number(lengthInput) * 1000)
        };
        if (!body.rollId || !body.rollModel || !(body.width > 0) || !(body.totalLength > 0)) {
          throw new Error('请填写卷号、型号、幅宽与整卷长');
        }
        await requestJSON('/api/inspection/rolls', body);
        toast('母卷已登记，进入跑布验疵');
        location.hash = '#/inspection/' + encodeURIComponent(body.rollId);
        return;
      }

      if (action === 'scrap') {
        if (!reason.trim()) throw new Error('请填写报废原因');
        await requestJSON('/api/remnants/' + encodeURIComponent(scrapId) + '/scrap', {
          reason: reason.trim()
        });
        toast('料头已报废');
        setAction(null);
      } else {
        if (
          !reason.trim() ||
          !operator.trim() ||
          (action === 'transfer' && !destination.trim())
        ) {
          throw new Error(
            action === 'transfer'
              ? '请填写目标库位、原因与操作人'
              : '请填写原因与操作人'
          );
        }
        const materials = selectedMaterials.map(({ type, id }) => {
          if (action === 'transfer') return { type, id };
          const c = getCountRow(type + ':' + id);
          return {
            type,
            id,
            present: Boolean(c.present),
            width: c.present ? Number(c.width) : 0,
            length: c.present ? Number(c.length) : 0
          };
        });
        const body =
          action === 'transfer'
            ? {
                expectedRevision: opts.revision,
                destination: destination.trim(),
                reason: reason.trim(),
                operator: operator.trim(),
                materials
              }
            : {
                expectedRevision: opts.revision,
                reason: reason.trim(),
                operator: operator.trim(),
                materials
              };
        await idempotentPost(
          action,
          `/api/v2/inventory-${action === 'transfer' ? 'transfers' : 'counts'}`,
          body
        );
        toast(`${ACTION_TITLES[action]}已过账`);
        setPicked(new Set());
        setAction(null);
      }
      await loadData();
    } catch (e: any) {
      const msg = e.message || '提交失败';
      toast(
        (e.httpStatus || msg.startsWith('请') || msg.startsWith('上次')
          ? ''
          : '结果未确认，可重试：') + msg,
        true
      );
    } finally {
      setBusy(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleRetryWrite = async (slot: 'transfer' | 'count') => {
    try {
      await retryWrite(slot);
      toast('原操作已确认');
      await loadData();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setPendingTick((t) => t + 1);
    }
  };

  const handleDropWrite = (slot: 'transfer' | 'count') => {
    dropWrite(slot);
    toast('已放弃待确认操作，请到库存单据核对是否已过账');
    setPendingTick((t) => t + 1);
  };

  return (
    <div className="react-page">
      <div className="ph">
        <h1>库存</h1>
        <span className="crumb">母卷与料头档案</span>
        <div className="hub-tabs" role="navigation" aria-label="材料与台账视图">
          <a className="on" href="#/inventory">
            实物库存
          </a>
          <a href="#/inspection">跑布验疵</a>
          <a href="#/documents">移库与盘点单</a>
          <a href="#/analysis">产出对账</a>
        </div>
        <span className="sp" />
        <button
          type="button"
          className="btn"
          disabled={picked.size === 0}
          title={picked.size === 0 ? '先在列表中勾选材料' : undefined}
          onClick={() => openActionPanel('transfer')}
        >
          移库{picked.size ? ` (${picked.size})` : ''}
        </button>
        <button
          type="button"
          className="btn"
          disabled={picked.size === 0}
          title={picked.size === 0 ? '先在列表中勾选材料' : undefined}
          onClick={() => openActionPanel('count')}
        >
          盘点{picked.size ? ` (${picked.size})` : ''}
        </button>
        <button
          type="button"
          className="btn pri"
          onClick={() => openActionPanel('receive')}
        >
          母卷入库
        </button>
      </div>

      {pendings.length > 0 && (
        <div className="notice" style={{ margin: '8px 16px 0' }}>
          {pendings.map(([s]) => (
            <span key={s} style={{ marginRight: 16 }}>
              {ACTION_TITLES[s]}提交结果未确认{' '}
              <button
                type="button"
                className="btn sm"
                onClick={() => handleRetryWrite(s)}
              >
                重试原操作
              </button>{' '}
              <button
                type="button"
                className="btn sm"
                onClick={() => handleDropWrite(s)}
              >
                放弃
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="seg">
          <button
            type="button"
            className={isRoll ? 'on' : ''}
            onClick={() => {
              setTab('roll');
              setSelectedIndex(0);
              setFilterModel('');
              setFilterLoc('');
              setFilterStatus('');
            }}
          >
            母卷 {rolls.length}
          </button>
          <button
            type="button"
            className={!isRoll ? 'on' : ''}
            onClick={() => {
              setTab('rem');
              setSelectedIndex(0);
              setFilterModel('');
              setFilterLoc('');
              setFilterStatus('');
            }}
          >
            料头 {remnants.length}
          </button>
        </div>
        <span className="vsep" />
        <select
          className="field"
          value={filterModel}
          onChange={(e) => {
            setFilterModel(e.target.value);
            setSelectedIndex(0);
          }}
        >
          <option value="">{isRoll ? '全部型号' : '全部批次'}</option>
          {distinctOptions(allItems, fieldKeys.model).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="field"
          value={filterLoc}
          onChange={(e) => {
            setFilterLoc(e.target.value);
            setSelectedIndex(0);
          }}
        >
          <option value="">全部库位</option>
          {distinctOptions(allItems, fieldKeys.loc).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="field"
          value={filterStatus}
          onChange={(e) => {
            setFilterStatus(e.target.value);
            setSelectedIndex(0);
          }}
        >
          <option value="">全部状态</option>
          {distinctOptions(allItems, fieldKeys.status).map((v) => {
            const labelMap = isRoll ? ROLL_QUALITY_MAP : REMNANT_STATUS_MAP;
            return (
              <option key={v} value={v}>
                {labelMap[v]?.[0] || v}
              </option>
            );
          })}
        </select>
        {(filterModel || filterLoc || filterStatus || searchQuery) && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setFilterModel('');
              setFilterLoc('');
              setFilterStatus('');
              setSearchQuery('');
              setSelectedIndex(0);
            }}
          >
            清除筛选
          </button>
        )}
        {picked.size > 0 && (
          <button
            type="button"
            className="btn sm"
            onClick={() => setPicked(new Set())}
          >
            清空勾选 {picked.size}
          </button>
        )}
        <span className="sp" />
        <span className="muted" style={{ fontSize: 12 }}>
          {filteredList.length} / {allItems.length}
        </span>
        <input
          className="field"
          placeholder="搜索编号 / 型号 / 批次 / 库位"
          style={{ width: 220 }}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />
      </div>

      {error ? (
        <div className="body">
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        </div>
      ) : loading ? (
        <div className="body">
          <div className="loading">正在读取库存台账…</div>
        </div>
      ) : (
        <div
          className="split"
          style={{ gridTemplateColumns: `1fr ${action ? 420 : 340}px` }}
        >
          <section className="pane" style={{ background: 'var(--bg)' }}>
            <div className="body">
              {filteredList.length > 0 ? (
                <table className="t">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={
                            filteredList.length > 0 &&
                            filteredList.every((x) => picked.has(idOf(isRoll, x)))
                          }
                          onChange={(e) => {
                            const next = new Set(picked);
                            filteredList.forEach((x) => {
                              const k = idOf(isRoll, x);
                              if (e.target.checked) next.add(k);
                              else next.delete(k);
                            });
                            setPicked(next);
                          }}
                        />
                      </th>
                      {isRoll ? (
                        <>
                          <th>卷号</th>
                          <th>型号 / 材料</th>
                          <th className="r">幅宽</th>
                          <th className="r">剩余 / 总长</th>
                          <th>余量</th>
                          <th className="r">疵点</th>
                          <th>库位</th>
                          <th>验布</th>
                        </>
                      ) : (
                        <>
                          <th>编号</th>
                          <th>来源</th>
                          <th className="r">宽 × 长</th>
                          <th className="r">面积</th>
                          <th>库位</th>
                          <th>疵点</th>
                          <th>状态</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredList.map((x, i) => {
                      const itemKey = idOf(isRoll, x);
                      const isChecked = picked.has(itemKey);
                      const isSel = x === currentItem;

                      if (isRoll) {
                        const rem =
                          x.currentRemainingLength ?? x.totalLength - x.usedLength;
                        const [qt, qc] = ROLL_QUALITY_MAP[x.inspectionStatus] || [
                          x.inspectionStatus || '—',
                          ''
                        ];
                        return (
                          <tr
                            key={x.rollId}
                            className={`click ${isSel ? 'sel' : ''}`}
                            onClick={() => setSelectedIndex(i)}
                          >
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  const next = new Set(picked);
                                  if (e.target.checked) next.add(itemKey);
                                  else next.delete(itemKey);
                                  setPicked(next);
                                }}
                              />
                            </td>
                            <td className="num">{x.rollId}</td>
                            <td>
                              {x.rollModel || ''}{' '}
                              <span className="muted">{x.materialName || ''}</span>
                            </td>
                            <td className="r num">{fmtN(x.width)}</td>
                            <td className="r num">
                              {fmtM(rem)} / {fmtM(x.totalLength)} m
                            </td>
                            <td>
                              <span className="bar">
                                <i
                                  style={{
                                    width: `${
                                      x.totalLength ? (rem / x.totalLength) * 100 : 0
                                    }%`
                                  }}
                                />
                              </span>
                            </td>
                            <td className="r num">
                              {x.defectsCount ?? (x.defects || []).length}
                            </td>
                            <td>{x.storageLocation || '—'}</td>
                            <td>
                              <span className={`tag ${qc}`}>{qt}</span>
                            </td>
                          </tr>
                        );
                      }

                      const [stLabel, stClass] = REMNANT_STATUS_MAP[x.status] || [
                        x.status,
                        ''
                      ];
                      return (
                        <tr
                          key={x.id}
                          className={`click ${isSel ? 'sel' : ''}`}
                          onClick={() => setSelectedIndex(i)}
                        >
                          <td onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                const next = new Set(picked);
                                if (e.target.checked) next.add(itemKey);
                                else next.delete(itemKey);
                                setPicked(next);
                              }}
                            />
                          </td>
                          <td className="num">{x.id}</td>
                          <td className="num">{x.sourceRollId || '—'}</td>
                          <td className="r num">
                            {fmtN(x.width)} × {fmtN(x.length)}
                          </td>
                          <td className="r num">{fmtN(x.area, 2)} m²</td>
                          <td>{x.location || '—'}</td>
                          <td>
                            {x.hasDefect ? (
                              <span className="tag warn">带疵</span>
                            ) : (
                              '无'
                            )}
                          </td>
                          <td>
                            <span className={`tag ${stClass}`}>{stLabel}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="empty">没有匹配的记录</div>
              )}
            </div>
          </section>

          <section className="pane">
            {action ? (
              <>
                <div className="pane-h">
                  {ACTION_TITLES[action]}
                  <span className="sp" />
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => setAction(null)}
                  >
                    关闭
                  </button>
                </div>
                {action === 'receive' ? (
                  <div className="pane-b">
                    <div className="form" style={{ gridTemplateColumns: '90px 1fr' }}>
                      <label>卷号</label>
                      <input
                        className="field"
                        value={rollIdInput}
                        placeholder="如 ROLL-2026-1101"
                        onChange={(e) => setRollIdInput(e.target.value)}
                      />
                      <label>型号</label>
                      <input
                        className="field"
                        list="inv-models-datalist"
                        value={rollModelInput}
                        onChange={(e) => setRollModelInput(e.target.value)}
                      />
                      <datalist id="inv-models-datalist">
                        {distinctOptions(rolls, 'rollModel').map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      <label>幅宽 mm</label>
                      <input
                        type="number"
                        className="field num"
                        value={widthInput}
                        onChange={(e) => setWidthInput(e.target.value)}
                      />
                      <label>整卷长 m</label>
                      <input
                        type="number"
                        className="field num"
                        value={lengthInput}
                        onChange={(e) => setLengthInput(e.target.value)}
                      />
                    </div>
                    <div
                      className="muted"
                      style={{ padding: '0 12px 8px', fontSize: 12 }}
                    >
                      登记后状态为“待检”，在跑布验疵中标记疵点并入档；验布合格前不能下达执行。
                    </div>
                    <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
                      <button
                        type="button"
                        className="btn pri"
                        disabled={busy}
                        onClick={handleSubmitAction}
                      >
                        登记并去验布
                      </button>
                    </div>
                  </div>
                ) : action === 'scrap' ? (
                  <div className="pane-b">
                    {(() => {
                      const targetRem = remnants.find((r) => r.id === scrapId);
                      return (
                        <>
                          <div className="kv">
                            <div>料头</div>
                            <div className="num">{targetRem?.id}</div>
                            <div>尺寸</div>
                            <div className="num">
                              {fmtN(targetRem?.width)} × {fmtN(targetRem?.length)} mm
                            </div>
                          </div>
                          <div
                            className="form"
                            style={{ gridTemplateColumns: '90px 1fr' }}
                          >
                            <label>报废原因</label>
                            <input
                              className="field"
                              value={reason}
                              placeholder="如：现场破损"
                              onChange={(e) => setReason(e.target.value)}
                            />
                          </div>
                          <div
                            style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}
                          >
                            <button
                              type="button"
                              className="btn pri"
                              disabled={busy}
                              onClick={handleSubmitAction}
                            >
                              确认报废
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : !opts ? (
                  <div className="loading">读取可操作材料…</div>
                ) : (
                  <div className="pane-b">
                    <table className="t" style={{ border: 0 }}>
                      <thead>
                        <tr>
                          <th>类型</th>
                          <th>编号</th>
                          <th>现库位</th>
                          {action === 'count' && (
                            <>
                              <th>在库</th>
                              <th className="r">实测宽</th>
                              <th className="r">实测长 mm</th>
                            </>
                          )}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {selectedMaterials.map(({ type, id, m }) => {
                          const rowKey = `${type}:${id}`;
                          const c = getCountRow(rowKey);
                          return (
                            <tr key={rowKey}>
                              <td>{type === 'roll' ? '母卷' : '料头'}</td>
                              <td className="num">{id}</td>
                              <td>{m?.location || '—'}</td>
                              {action === 'count' && (
                                <>
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={c.present}
                                      onChange={(e) =>
                                        updateCountRow(rowKey, {
                                          present: e.target.checked
                                        })
                                      }
                                    />
                                  </td>
                                  <td className="r">
                                    <input
                                      type="number"
                                      className="field num"
                                      value={c.width}
                                      style={{
                                        width: 66,
                                        height: 22,
                                        textAlign: 'right'
                                      }}
                                      disabled={type === 'roll' || !c.present}
                                      onChange={(e) =>
                                        updateCountRow(rowKey, {
                                          width: e.target.value
                                        })
                                      }
                                    />
                                  </td>
                                  <td className="r">
                                    <input
                                      type="number"
                                      className="field num"
                                      value={c.length}
                                      style={{
                                        width: 76,
                                        height: 22,
                                        textAlign: 'right'
                                      }}
                                      disabled={!c.present}
                                      onChange={(e) =>
                                        updateCountRow(rowKey, {
                                          length: e.target.value
                                        })
                                      }
                                    />
                                  </td>
                                </>
                              )}
                              <td>
                                {!m?.allowed && (
                                  <span
                                    className="tag err"
                                    title={m?.reason || '不可操作'}
                                  >
                                    不可
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {blockedMaterials.length > 0 && (
                      <div className="notice">
                        {blockedMaterials.map((x) => (
                          <div key={`${x.type}:${x.id}`}>
                            {x.id}：{x.m?.reason || '当前不可操作'}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="form" style={{ gridTemplateColumns: '90px 1fr' }}>
                      {action === 'transfer' && (
                        <>
                          <label>目标库位</label>
                          <input
                            className="field"
                            value={destination}
                            onChange={(e) => setDestination(e.target.value)}
                          />
                        </>
                      )}
                      <label>原因</label>
                      <input
                        className="field"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <label>操作人</label>
                      <input
                        className="field"
                        value={operator}
                        onChange={(e) => setOperator(e.target.value)}
                      />
                    </div>
                    <div
                      className="muted"
                      style={{ padding: '0 12px 8px', fontSize: 12 }}
                    >
                      {action === 'count'
                        ? '母卷盘点实测未切长度（幅宽不随盘点改变）；料头实测宽、长；不在库取消勾选。差额单独记账，不算生产产出。'
                        : '移库只改库位，不改数量、质量与来源。'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
                      <button
                        type="button"
                        className="btn pri"
                        disabled={
                          busy ||
                          blockedMaterials.length > 0 ||
                          selectedMaterials.length === 0
                        }
                        onClick={handleSubmitAction}
                      >
                        确认{ACTION_TITLES[action]}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : currentItem ? (
              isRoll ? (
                <>
                  <div className="pane-h num">
                    {currentItem.rollId}
                    <span className="sp" />
                    <a
                      className="btn sm"
                      href={`#/inspection/${encodeURIComponent(currentItem.rollId)}`}
                    >
                      跑布验疵
                    </a>
                  </div>
                  <div className="pane-b">
                    <div className="metric">
                      <div>
                        <small>剩余</small>
                        <b>
                          {fmtM(
                            currentItem.currentRemainingLength ??
                              currentItem.totalLength - currentItem.usedLength
                          )}
                          <em>m</em>
                        </b>
                      </div>
                      <div>
                        <small>幅宽</small>
                        <b>
                          {fmtN(currentItem.width)}
                          <em>mm</em>
                        </b>
                      </div>
                    </div>
                    <div className="kv">
                      <div>型号</div>
                      <div>{currentItem.rollModel || '—'}</div>
                      <div>材料</div>
                      <div>{currentItem.materialName || '—'}</div>
                      <div>成分</div>
                      <div>{currentItem.composition || '—'}</div>
                      <div>颜色</div>
                      <div>{currentItem.color || '—'}</div>
                      <div>批次</div>
                      <div>{currentItem.batchNo || '—'}</div>
                      <div>供应商</div>
                      <div>{currentItem.supplier || '—'}</div>
                      <div>库位</div>
                      <div>{currentItem.storageLocation || '—'}</div>
                      <div>验布</div>
                      <div>
                        {currentItem.inspector || '—'} ·{' '}
                        {currentItem.inspectionDate || ''}
                      </div>
                      <div>料头</div>
                      <div className="num">
                        {currentItem.remnantCount ?? 0} 块 ·{' '}
                        {fmtN(currentItem.remnantTotalArea, 2)} m²
                      </div>
                    </div>
                    <div className="sec">
                      疵点 {(currentItem.defects || []).length || currentItem.defectsCount || 0}{' '}
                      处
                      {(currentItem.voidedDefects || []).length
                        ? ` · 已作废 ${currentItem.voidedDefects.length}`
                        : ''}
                    </div>
                    {(currentItem.defects || []).length > 0 ? (
                      <table className="t" style={{ border: 0 }}>
                        <thead>
                          <tr>
                            <th>Y m</th>
                            <th className="r">X</th>
                            <th className="r">宽×长</th>
                            <th>类型</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentItem.defects.map((d: any, idx: number) => (
                            <tr key={d.id || idx}>
                              <td className="num">{(d.y / 1000).toFixed(2)}</td>
                              <td className="r num">{fmtN(d.x)}</td>
                              <td className="r num">
                                {fmtN(d.w)}×{fmtN(d.h)}
                              </td>
                              <td>{d.typeName || d.defectType}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="empty" style={{ padding: 12 }}>
                        无疵点记录
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="pane-h num">
                    {currentItem.id}
                    <span className="sp" />
                    {(currentItem.status === 'AVAILABLE' ||
                      currentItem.status === 'QUARANTINED') && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() =>
                          openActionPanel('scrap', { scrapId: currentItem.id })
                        }
                      >
                        报废
                      </button>
                    )}
                  </div>
                  <div className="pane-b">
                    <div className="metric">
                      <div>
                        <small>面积</small>
                        <b>
                          {fmtN(currentItem.area, 2)}
                          <em>m²</em>
                        </b>
                      </div>
                      <div>
                        <small>尺寸</small>
                        <b style={{ fontSize: 14 }}>
                          {fmtN(currentItem.width)}×{fmtN(currentItem.length)}
                        </b>
                      </div>
                    </div>
                    <div className="kv">
                      <div>来源母卷</div>
                      <div className="num">{currentItem.sourceRollId || '—'}</div>
                      <div>批次</div>
                      <div>{currentItem.materialBatch || '—'}</div>
                      <div>库位</div>
                      <div>{currentItem.location || '—'}</div>
                      <div>等级</div>
                      <div>{currentItem.qualityGrade || '—'}</div>
                      <div>代数</div>
                      <div className="num">{currentItem.generation ?? '—'}</div>
                      <div>来源报工</div>
                      <div className="num">{currentItem.sourceReportId || '—'}</div>
                      <div>说明</div>
                      <div>{currentItem.defectDesc || '—'}</div>
                      {currentItem.consumedByOrder && (
                        <>
                          <div>消耗于</div>
                          <div className="num">{currentItem.consumedByOrder}</div>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
};
