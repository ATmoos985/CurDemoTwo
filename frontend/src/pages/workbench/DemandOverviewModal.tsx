import React from 'react';
import { DemandItem, SlittingOrderLine } from '../../store/useStudioStore';
import { ModalDialog } from '../../components/ModalDialog';
import { NumberInput } from '../../components/ui/NumberInput';
import { fmtN } from '@static/app/js/util.js';
import { DemandRowView, OverviewStats } from './workbenchTypes';

export interface DemandOverviewModalProps {
  open: boolean;
  onClose: () => void;
  overviewTab: 'progress' | 'edit';
  setOverviewTab: (tab: 'progress' | 'edit') => void;
  is2D: boolean;
  loadedTaskName: string;
  slitLoadedTaskName: string;
  materialModel2D: string;
  slitMaterialModel: string;
  overviewStats: OverviewStats;
  demandRowsView: DemandRowView[];
  taskSchemes: any[];
  activeDemands2D: DemandItem[];
  updateDemand2D: (id: number, patch: Partial<DemandItem>) => void;
  removeDemand2D: (id: number) => void;
  addBlankDemand2D: () => void;
  slitOrders: SlittingOrderLine[];
  updateSlitOrder: (id: string, patch: Partial<SlittingOrderLine>) => void;
  removeSlitOrder: (id: string) => void;
  addSlitOrder: () => void;
}

export const DemandOverviewModal: React.FC<DemandOverviewModalProps> = ({
  open,
  onClose,
  overviewTab,
  setOverviewTab,
  is2D,
  loadedTaskName,
  slitLoadedTaskName,
  materialModel2D,
  slitMaterialModel,
  overviewStats,
  demandRowsView,
  taskSchemes,
  activeDemands2D,
  updateDemand2D,
  removeDemand2D,
  addBlankDemand2D,
  slitOrders,
  updateSlitOrder,
  removeSlitOrder,
  addSlitOrder
}) => {
  return (
    <ModalDialog
      open={open}
      title={`本次具体需求概览 · ${
        (is2D ? loadedTaskName : slitLoadedTaskName) || '当前排程批次'
      }`}
      onClose={onClose}
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
                              onClick={onClose}
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
                    const candPct = Math.min(100 - donePct - planPct, (r.cand / r.ordered) * 100);
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
                              <NumberInput
                                className="field num"
                                style={{ width: 90, textAlign: 'right' }}
                                min={1}
                                value={d.width}
                                onValueChange={(v) => updateDemand2D(d.id, { width: v })}
                              />
                            )}
                          </td>
                          <td className="r num">
                            {isPoly ? (
                              fmtN(d.length, 1)
                            ) : (
                              <NumberInput
                                className="field num"
                                style={{ width: 90, textAlign: 'right' }}
                                min={1}
                                value={d.length}
                                onValueChange={(v) => updateDemand2D(d.id, { length: v })}
                              />
                            )}
                          </td>
                          <td className="r">
                            <NumberInput
                              min={0}
                              max={5000}
                              fallback={0}
                              integer
                              className="field num"
                              style={{ width: 84, textAlign: 'right' }}
                              value={d.quantity}
                              onValueChange={(nextQ) => {
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
                          <NumberInput
                            className="field num"
                            style={{ width: 100, textAlign: 'right' }}
                            min={1}
                            value={o.widthMm}
                            onValueChange={(v) => updateSlitOrder(o.id, { widthMm: v })}
                          />
                        </td>
                        <td className="r">
                          <NumberInput
                            min={0}
                            fallback={0}
                            integer
                            className="field num"
                            style={{ width: 90, textAlign: 'right' }}
                            value={o.quantity}
                            onValueChange={(nextQ) => {
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
  );
};
