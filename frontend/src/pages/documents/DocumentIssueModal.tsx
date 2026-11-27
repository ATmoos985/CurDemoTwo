import React from 'react';
import { fmtM } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';
import { SegmentedControl } from '../../components/ui/MagpiePrimitives';

interface DocumentIssueModalProps {
  open: boolean;
  submitting: boolean;
  rolls: any[];
  issueDirection: 'ISSUE' | 'RETURN';
  onChangeDirection: (next: 'ISSUE' | 'RETURN') => void;
  issueRollId: string;
  onChangeRollId: (v: string) => void;
  issueMachineId: string;
  onChangeMachineId: (v: string) => void;
  issueShiftTeam: string;
  onChangeShiftTeam: (v: string) => void;
  issueTargetLoc: string;
  onChangeTargetLoc: (v: string) => void;
  issueOperator: string;
  onChangeOperator: (v: string) => void;
  issueReason: string;
  onChangeReason: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

export const DocumentIssueModal: React.FC<DocumentIssueModalProps> = ({
  open,
  submitting,
  rolls,
  issueDirection,
  onChangeDirection,
  issueRollId,
  onChangeRollId,
  issueMachineId,
  onChangeMachineId,
  issueShiftTeam,
  onChangeShiftTeam,
  issueTargetLoc,
  onChangeTargetLoc,
  issueOperator,
  onChangeOperator,
  issueReason,
  onChangeReason,
  onSubmit,
  onClose
}) => {
  return (
    <ModalDialog
      open={open}
      title="新建车间领 / 退料单"
      onClose={() => {
        if (!submitting) onClose();
      }}
      maxWidth={560}
    >
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 12 }}>
          <SegmentedControl
            options={[
              { value: 'ISSUE', label: '车间领料出库 (ISSUE)' },
              { value: 'RETURN', label: '车间余卷退库 (RETURN)' }
            ]}
            value={issueDirection}
            onChange={onChangeDirection}
            ariaLabel="选择领料或退料方向"
            fullWidth
          />
        </div>
        <div className="form" style={{ gridTemplateColumns: '96px 1fr', padding: '4px 0 14px' }}>
          <label htmlFor="iss-roll">选择母卷</label>
          <div>
            <select
              id="iss-roll"
              className="field num"
              style={{ width: '100%' }}
              required
              value={issueRollId}
              onChange={(e) => onChangeRollId(e.target.value)}
            >
              <option value="">请选择在库母卷…</option>
              {rolls
                .filter((r) => r.inspectionStatus !== 'SCRAPPED' && r.status !== 'SCRAPPED')
                .map((r) => {
                  const notPassed = r.inspectionStatus !== 'PASSED';
                  const disabledOption = issueDirection === 'ISSUE' && notPassed;
                  return (
                    <option key={r.rollId} value={r.rollId} disabled={disabledOption}>
                      {r.rollId} · {r.rollModel}
                      {r.batchNo ? ` [缸:${r.batchNo}]` : ''} · 余
                      {fmtM(r.currentRemainingLength ?? r.totalLength)}m ·{' '}
                      {r.storageLocation || '未分配库位'}
                      {disabledOption ? '（未验布放行，禁领）' : ''}
                    </option>
                  );
                })}
            </select>
            {issueDirection === 'ISSUE' && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                仅已通过跑布验疵放行（PASSED）的母卷允许车间领料出库；待检卷请先前往「跑布验疵」放行。
              </div>
            )}
          </div>
          <label htmlFor="iss-machine">机台编号</label>
          <input
            id="iss-machine"
            className="field num"
            required={issueDirection === 'ISSUE'}
            placeholder="如：裁床-01 / SLIT-02"
            value={issueMachineId}
            onChange={(e) => onChangeMachineId(e.target.value)}
          />
          <label htmlFor="iss-shift">班组</label>
          <input
            id="iss-shift"
            className="field"
            placeholder="如：甲班 / 白班一组"
            value={issueShiftTeam}
            onChange={(e) => onChangeShiftTeam(e.target.value)}
          />
          <label htmlFor="iss-loc">目标库位</label>
          <input
            id="iss-loc"
            className="field"
            required
            placeholder={issueDirection === 'ISSUE' ? '如：车间:裁床-01' : '如：原料库位 R-01-A03'}
            value={issueTargetLoc}
            onChange={(e) => onChangeTargetLoc(e.target.value)}
          />
          <label htmlFor="iss-operator">经办人</label>
          <input
            id="iss-operator"
            className="field"
            required
            placeholder="如：领料员陈工"
            value={issueOperator}
            onChange={(e) => onChangeOperator(e.target.value)}
          />
          <label htmlFor="iss-reason">原因说明</label>
          <input
            id="iss-reason"
            className="field"
            placeholder={issueDirection === 'ISSUE' ? '如：按排程工单领用投产' : '如：本班完工余卷退库'}
            value={issueReason}
            onChange={(e) => onChangeReason(e.target.value)}
          />
        </div>
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
            {submitting
              ? '过账中…'
              : issueDirection === 'ISSUE'
              ? '确认发料出库'
              : '确认退料入库'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
};
