import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';
import { BarcodeSvg } from '../../components/BarcodeSvg';

export interface ResultsCutTicketModalProps {
  open: boolean;
  onClose: () => void;
  activeScheme: any;
  ticketModel: any;
  ticketShowCuts: boolean;
}

export const ResultsCutTicketModal: React.FC<ResultsCutTicketModalProps> = ({
  open,
  onClose,
  activeScheme,
  ticketModel,
  ticketShowCuts
}) => {
  return (
    <ModalDialog open={open} title="车间 A4 随工派工裁切单预览" onClose={onClose} maxWidth={820}>
      {activeScheme && ticketModel && (
        <div className="print-ticket-sheet">
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
              borderBottom: '2px solid #0f172a',
              paddingBottom: 10,
              marginBottom: 10
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>CutPlan 车间生产裁切派工单</h2>
              <div className="muted" style={{ fontSize: 12 }}>
                需求族：{activeScheme.taskName} · 外部单号：{activeScheme.externalOrderNo || '内部排产'}
              </div>
              <div style={{ fontSize: 11.5, marginTop: 4 }} className="num">
                工单号：<b>{ticketModel.workOrderNo}</b> · 方案号：{activeScheme.id} · 打印时间：
                {new Date().toLocaleString('zh-CN')}
              </div>
            </div>
            <div className="ticket-barcode-bar" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
              <BarcodeSvg value={ticketModel.workOrderNo} label="派工单号" height={36} moduleWidth={1.15} />
              {activeScheme.rollId && (
                <BarcodeSvg value={activeScheme.rollId} label="领用母卷" height={36} moduleWidth={1.15} />
              )}
            </div>
          </header>

          <div
            className="ticket-meta num"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 8,
              padding: '8px 10px',
              border: '1px solid #cbd5e1',
              marginBottom: 12,
              fontSize: 12
            }}
          >
            <div>
              物料品号：<b>{activeScheme.materialModel}</b>
            </div>
            <div>
              领用母卷：<b>{activeScheme.rollId || '按建议新母卷领料'}</b>
            </div>
            <div>
              幅宽×用长：<b>{activeScheme.widthMm} × {fmtN(activeScheme.occupiedLengthMm, 1)} mm</b>
            </div>
            <div>
              预计利用率：<b>{activeScheme.utilizationPct}%</b>
            </div>
          </div>

          {ticketModel.placements.length > 0 && (
            <div className="ticket-diagram" style={{ marginBottom: 12 }}>
              <svg
                viewBox={ticketModel.viewBox}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`排料示意图 ${ticketModel.workOrderNo}`}
                style={{
                  width: '100%',
                  height: 'auto',
                  maxHeight: 280,
                  border: '1px solid #94a3b8',
                  background: '#f8fafc',
                  display: 'block'
                }}
              >
                <text x={0} y={ticketModel.headerY} fontSize={ticketModel.headerFontSize} fontWeight="700" fill="#0f172a">
                  {ticketModel.workOrderNo} · {ticketModel.widthMm}×{fmtN(ticketModel.occupiedLengthMm, 1)}mm · 共{' '}
                  {ticketModel.placements.length} 件
                </text>
                <rect
                  x={0}
                  y={0}
                  width={ticketModel.widthMm}
                  height={ticketModel.occupiedLengthMm}
                  fill="#ffffff"
                  stroke="#0f172a"
                  strokeWidth={ticketModel.borderStroke}
                />

                {ticketModel.defects.map((d: any) => (
                  <g key={`def-${d.id}`}>
                    <rect
                      x={Math.max(0, d.x - d.margin)}
                      y={Math.max(0, d.y - d.margin)}
                      width={d.w + d.margin * 2}
                      height={d.h + d.margin * 2}
                      fill="rgba(239,68,68,0.14)"
                      stroke="#dc2626"
                      strokeWidth={ticketModel.pieceStroke}
                      strokeDasharray={`${ticketModel.borderStroke * 3} ${ticketModel.borderStroke * 2}`}
                    />
                    <text
                      x={d.x + d.w / 2}
                      y={d.y + d.h / 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={Math.max(16, ticketModel.cutBadgeFontSize)}
                      fontWeight="700"
                      fill="#b91c1c"
                    >
                      疵#{d.id}
                    </text>
                  </g>
                ))}

                {ticketModel.placements.map((p: any) => (
                  <g key={`p-${p.id}`}>
                    {p.pointsAttr ? (
                      <polygon points={p.pointsAttr} fill="rgba(2,132,199,0.14)" stroke="#0284c7" strokeWidth={ticketModel.pieceStroke} />
                    ) : (
                      <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="rgba(2,132,199,0.14)" stroke="#0284c7" strokeWidth={ticketModel.pieceStroke} />
                    )}
                    <text
                      x={p.cx}
                      y={p.showDimLabel ? p.cy - p.fontSize * 0.52 : p.cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={p.fontSize}
                      fontWeight="700"
                      fill="#0f172a"
                    >
                      {p.pieceLabel}
                    </text>
                    {p.showDimLabel && (
                      <text
                        x={p.cx}
                        y={p.cy + p.fontSize * 0.62}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={Math.max(12, Math.round(p.fontSize * 0.78))}
                        fill="#334155"
                      >
                        {p.dimLabel}
                      </text>
                    )}
                  </g>
                ))}

                {ticketModel.cuts.map((c: any, idx: number) => (
                  <g key={`cut-${idx}`}>
                    <line
                      x1={c.startX}
                      y1={c.startY}
                      x2={c.endX}
                      y2={c.endY}
                      stroke="#d97706"
                      strokeWidth={ticketModel.cutStroke}
                      strokeDasharray={`${ticketModel.borderStroke * 4} ${ticketModel.borderStroke * 2}`}
                    />
                    <circle cx={c.labelX} cy={c.labelY} r={ticketModel.cutBadgeRadius} fill="#ffffff" stroke="#d97706" strokeWidth={ticketModel.pieceStroke} />
                    <text
                      x={c.labelX}
                      y={c.labelY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={ticketModel.cutBadgeFontSize}
                      fontWeight="700"
                      fill="#b45309"
                    >
                      {c.sequence}
                    </text>
                  </g>
                ))}

                <g>
                  <circle
                    cx={ticketModel.originPoint.x}
                    cy={ticketModel.originPoint.y}
                    r={ticketModel.cutBadgeRadius * 0.85}
                    fill="#dc2626"
                    stroke="#ffffff"
                    strokeWidth={ticketModel.pieceStroke}
                  />
                  <text
                    x={
                      ticketModel.originPoint.x === 0
                        ? ticketModel.cutBadgeRadius * 1.3
                        : ticketModel.widthMm - ticketModel.cutBadgeRadius * 1.3
                    }
                    y={
                      ticketModel.originPoint.y === 0
                        ? ticketModel.cutBadgeRadius * 1.4
                        : ticketModel.occupiedLengthMm - ticketModel.cutBadgeRadius * 1.1
                    }
                    textAnchor={ticketModel.originPoint.x === 0 ? 'start' : 'end'}
                    fontSize={ticketModel.cutBadgeFontSize}
                    fontWeight="700"
                    fill="#dc2626"
                  >
                    {ticketModel.originPoint.label}
                  </text>
                </g>
              </svg>
            </div>
          )}

          <div className="mp-table-scroll" style={{ marginBottom: 16 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>部件 / 分条规格</th>
                  <th className="r">尺寸规格 mm</th>
                  <th className="r">计划产出</th>
                  <th>实切合格登记</th>
                  <th>异常/备注</th>
                </tr>
              </thead>
              <tbody>
                {activeScheme.dimension === 'SLITTING_1D' && activeScheme.slitting1D
                  ? activeScheme.slitting1D.fulfillment.map((f: any, i: number) => (
                      <tr key={i}>
                        <td className="num">{i + 1}</td>
                        <td>{f.name}</td>
                        <td className="r num">
                          {f.widthMm} × {activeScheme.slitting1D.fixedLengthMm}
                        </td>
                        <td className="r num">{f.produced} 卷</td>
                        <td>________</td>
                        <td>________</td>
                      </tr>
                    ))
                  : ticketModel.placements.map((p: any, i: number) => (
                      <tr key={`${p.id}-${i}`}>
                        <td className="num">{p.pieceLabel}</td>
                        <td>{p.name}</td>
                        <td className="r num">
                          {fmtN(p.w, 0)} × {fmtN(p.h, 0)}
                        </td>
                        <td className="r num">1 件</td>
                        <td>□ 合格</td>
                        <td />
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          {ticketShowCuts && ticketModel.cuts.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                贯通直刀下刀顺序明细（共 {ticketModel.cuts.length} 刀）
              </div>
              <table className="t">
                <thead>
                  <tr>
                    <th>刀序</th>
                    <th>方向</th>
                    <th className="r">起点坐标 (X, Y mm)</th>
                    <th className="r">终点坐标 (X, Y mm)</th>
                  </tr>
                </thead>
                <tbody>
                  {ticketModel.cuts.map((c: any, idx: number) => (
                    <tr key={idx}>
                      <td className="num">第 {c.sequence} 刀</td>
                      <td>{c.directionLabel}</td>
                      <td className="r num">
                        ({fmtN(c.startX, 1)}, {fmtN(c.startY, 1)})
                      </td>
                      <td className="r num">
                        ({fmtN(c.endX, 1)}, {fmtN(c.endY, 1)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div
            className="ticket-sign-row"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 16,
              paddingTop: 12,
              borderTop: '1px dashed #94a3b8',
              fontSize: 12
            }}
          >
            <div>领料确认签字：______________</div>
            <div>机台操作员签字：____________</div>
            <div>质检复核签字：______________</div>
          </div>

          <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
            <button type="button" className="btn pri" onClick={() => window.print()}>
              立即调用系统打印 / 导出 PDF
            </button>
          </div>
        </div>
      )}
    </ModalDialog>
  );
};
