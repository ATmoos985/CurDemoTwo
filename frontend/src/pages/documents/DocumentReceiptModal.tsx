import React from 'react';
import { fmtM } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';
import { ReceiptRollDraft, createEmptyReceiptRoll } from './documentLedgerUtils';

interface DocumentReceiptModalProps {
  open: boolean;
  submitting: boolean;
  supplierName: string;
  onChangeSupplierName: (v: string) => void;
  deliveryNoteNo: string;
  onChangeDeliveryNoteNo: (v: string) => void;
  receiptOperator: string;
  onChangeReceiptOperator: (v: string) => void;
  receiptInspector: string;
  onChangeReceiptInspector: (v: string) => void;
  receiptRemarks: string;
  onChangeReceiptRemarks: (v: string) => void;
  receiptRolls: ReceiptRollDraft[];
  onChangeReceiptRolls: React.Dispatch<React.SetStateAction<ReceiptRollDraft[]>>;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

export const DocumentReceiptModal: React.FC<DocumentReceiptModalProps> = ({
  open,
  submitting,
  supplierName,
  onChangeSupplierName,
  deliveryNoteNo,
  onChangeDeliveryNoteNo,
  receiptOperator,
  onChangeReceiptOperator,
  receiptInspector,
  onChangeReceiptInspector,
  receiptRemarks,
  onChangeReceiptRemarks,
  receiptRolls,
  onChangeReceiptRolls,
  onSubmit,
  onClose
}) => {
  return (
    <ModalDialog
      open={open}
      title="新建采购批量入库单（原子建档多卷母卷与不可变流水）"
      onClose={() => {
        if (!submitting) onClose();
      }}
      maxWidth={1120}
    >
      <form onSubmit={onSubmit}>
        <div
          className="form"
          style={{
            gridTemplateColumns: '90px 1fr 90px 1fr',
            gap: '8px 12px',
            padding: '4px 0 12px'
          }}
        >
          <label htmlFor="rec-supplier">供应商</label>
          <input
            id="rec-supplier"
            className="field"
            required
            placeholder="如：华联高新纺织印染"
            value={supplierName}
            onChange={(e) => onChangeSupplierName(e.target.value)}
          />
          <label htmlFor="rec-delivery">送货单号</label>
          <input
            id="rec-delivery"
            className="field num"
            required
            placeholder="如：DN-20261125-01"
            value={deliveryNoteNo}
            onChange={(e) => onChangeDeliveryNoteNo(e.target.value)}
          />
          <label htmlFor="rec-operator">经办仓管</label>
          <input
            id="rec-operator"
            className="field"
            required
            placeholder="如：仓管王工"
            value={receiptOperator}
            onChange={(e) => onChangeReceiptOperator(e.target.value)}
          />
          <label htmlFor="rec-remarks">备注</label>
          <input
            id="rec-remarks"
            className="field"
            placeholder="选填：来料批次或质检说明"
            value={receiptRemarks}
            onChange={(e) => onChangeReceiptRemarks(e.target.value)}
          />
          {receiptRolls.some((r) => r.inspectionStatus === 'PASSED') && (
            <>
              <label htmlFor="rec-inspector">来料质检员 *</label>
              <input
                id="rec-inspector"
                className="field"
                required
                placeholder="直通合格(PASSED)必填检验员"
                value={receiptInspector}
                onChange={(e) => onChangeReceiptInspector(e.target.value)}
              />
            </>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6
          }}
        >
          <strong style={{ fontSize: 12.5 }}>入库母卷明细（共 {receiptRolls.length} 卷）</strong>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                onChangeReceiptRolls((prev) => [
                  ...prev,
                  createEmptyReceiptRoll(prev[prev.length - 1])
                ])
              }
            >
              ＋ 复制末行添加母卷
            </button>
          </div>
        </div>

        <div className="mp-table-scroll" style={{ maxHeight: 320, overflowX: 'auto', marginBottom: 12 }}>
          <table className="t" style={{ minWidth: 1020 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 112 }}>卷号(选填)</th>
                <th style={{ minWidth: 112 }}>品号 *</th>
                <th style={{ minWidth: 74 }}>类型</th>
                <th style={{ minWidth: 96 }}>缸号</th>
                <th style={{ minWidth: 82 }}>色号</th>
                <th style={{ minWidth: 74 }} className="r">门幅 mm</th>
                <th style={{ minWidth: 84 }} className="r">卷长 mm</th>
                <th style={{ minWidth: 64 }} className="r">克重</th>
                <th style={{ minWidth: 64 }} className="r">缩水%</th>
                <th style={{ minWidth: 96 }}>库位</th>
                <th style={{ minWidth: 80 }}>检验态</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {receiptRolls.map((row, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      className="field num"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      placeholder="留空自动"
                      value={row.id}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) => p.map((x, i) => (i === idx ? { ...x, id: v } : x)));
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field num"
                      required
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      value={row.materialModel}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, materialModel: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      value={row.materialType}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, materialType: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field num"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      placeholder="BAT-xxx"
                      value={row.batchNo}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, batchNo: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      placeholder="藏青"
                      value={row.color}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, color: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      required
                      className="field num"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                      value={row.widthMm}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, widthMm: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={100}
                      required
                      className="field num"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                      value={row.totalLengthMm}
                      title={
                        Number(row.totalLengthMm) > 0
                          ? `折合 ${fmtM(Number(row.totalLengthMm))} m`
                          : undefined
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, totalLengthMm: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      className="field num"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                      value={row.grammage}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, grammage: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step="0.1"
                      className="field num"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                      value={row.shrinkageRate}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, shrinkageRate: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                      value={row.storageLocation}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, storageLocation: v } : x))
                        );
                      }}
                    />
                  </td>
                  <td>
                    <select
                      className="field"
                      style={{ width: '100%', padding: '3px 4px', fontSize: 12 }}
                      value={row.inspectionStatus}
                      onChange={(e) => {
                        const v = e.target.value as 'PENDING' | 'PASSED';
                        onChangeReceiptRolls((p) =>
                          p.map((x, i) => (i === idx ? { ...x, inspectionStatus: v } : x))
                        );
                      }}
                    >
                      <option value="PENDING">待检</option>
                      <option value="PASSED">已合格</option>
                    </select>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {receiptRolls.length > 1 && (
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`删除第 ${idx + 1} 行母卷`}
                        onClick={() =>
                          onChangeReceiptRolls((p) => p.filter((_, i) => i !== idx))
                        }
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
          默认来料检验状态为「待检 (PENDING)」，入库后须经跑布验疵放行方可锁卷排切；支持跨刷新幂等防重。
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="btn"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="btn pri" disabled={submitting}>
            {submitting ? '过账中…' : `确认采购入库 (${receiptRolls.length} 卷)`}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
};
