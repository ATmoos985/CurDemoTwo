import React, { useCallback, useEffect, useState } from 'react';
import { ModalDialog } from '../components/ModalDialog';
import { CodeBadge } from '../components/ui/MagpiePrimitives';
import { AuthSession, roleDisplayName } from '../utils/authClient';
import {
  AuditPage,
  AuditRecord,
  canAccessAdminSecurity,
  queryAuditLogs
} from '../utils/securityApi';

export interface AuditLogsPageProps {
  auth: AuthSession;
}

function outcomeTone(outcome?: string): 'ok' | 'err' | 'warn' {
  const upper = String(outcome || '').toUpperCase();
  if (upper === 'SUCCESS') return 'ok';
  if (upper === 'DENIED') return 'warn';
  return 'err';
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatDetailJson(raw: string | null): string {
  if (!raw) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export const AuditLogsPage: React.FC<AuditLogsPageProps> = ({ auth }) => {
  const allowed = canAccessAdminSecurity(auth);

  const [targetId, setTargetId] = useState('');
  const [targetType, setTargetType] = useState('');
  const [actor, setActor] = useState('');
  const [actorType, setActorType] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');

  const [page, setPage] = useState(0);
  const [size] = useState(20);
  const [data, setData] = useState<AuditPage>({ items: [], total: 0, page: 0, size: 20 });
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(null);

  const loadPage = useCallback(
    async (targetPage: number) => {
      if (!allowed) return;
      setLoading(true);
      setErrorMsg('');
      try {
        const fromMs = fromInput ? Date.parse(fromInput) : undefined;
        const toMs = toInput ? Date.parse(toInput) : undefined;
        const result = await queryAuditLogs({
          actor,
          actorType,
          action,
          targetType,
          targetId,
          outcome,
          from: Number.isFinite(fromMs) ? fromMs : undefined,
          to: Number.isFinite(toMs) ? toMs : undefined,
          page: targetPage,
          size
        });
        setData(result);
        setPage(result.page ?? targetPage);
      } catch (err: any) {
        setErrorMsg(err?.message || '查询操作审计流水失败');
      } finally {
        setLoading(false);
      }
    },
    [allowed, actor, actorType, action, targetType, targetId, outcome, fromInput, toInput, size]
  );

  useEffect(() => {
    if (allowed) {
      void loadPage(0);
    }
  }, [allowed]);

  if (!allowed) {
    return (
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>全站操作审计</h1>
          </div>
        </div>
        <section className="box sec-forbidden-card" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tag err">403 权限不足</span>
            <h2>仅系统管理员（ADMIN）可检索全站操作审计日志</h2>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            当前登录身份为「{auth.displayName || auth.username}」（{roleDisplayName(auth.role)}），
            无权查阅跨用户与跨单据的安全审计流水。
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <a className="btn pri sm" href="#/workbench">
              返回搭切工作台
            </a>
            <a className="btn sm" href="#/profile">
              查看个人中心
            </a>
          </div>
        </section>
      </div>
    );
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void loadPage(0);
  };

  const handleReset = () => {
    setTargetId('');
    setTargetType('');
    setActor('');
    setActorType('');
    setAction('');
    setOutcome('');
    setFromInput('');
    setToInput('');
    void queryAuditLogs({ page: 0, size })
      .then((res) => {
        setData(res);
        setPage(0);
        setErrorMsg('');
      })
      .catch((err: any) => setErrorMsg(err?.message || '查询失败'));
  };

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / size));

  return (
    <div className="mp-page-shell">
      <div className="mp-page-head">
        <div className="mp-page-title-block">
          <h1>全站操作审计</h1>
          <span className="mp-page-summary">
            持久化记录登录、改密、用户/Agent 管理、排产方案、质检放行、出入库与越权拦截事件
          </span>
        </div>
        <div className="sp" />
        <span className="tag kind num">总计 {data.total} 条</span>
      </div>

      <form className="box sec-audit-filters" onSubmit={handleSearch}>
        <div className="sec-field-group">
          <label htmlFor="audit-target-id">单据 / 目标 ID</label>
          <input
            id="audit-target-id"
            type="text"
            className="field num"
            placeholder="如 ROLL-001 / TASK-01 / admin"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          />
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-target-type">目标类型</label>
          <input
            id="audit-target-type"
            type="text"
            className="field num"
            placeholder="如 USER / AGENT / DRAFT / ROLL"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
          />
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-actor">操作人账号</label>
          <input
            id="audit-actor"
            type="text"
            className="field num"
            placeholder="如 admin / planner / agent:AGT-..."
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-actor-type">主体类型</label>
          <select
            id="audit-actor-type"
            className="field"
            value={actorType}
            onChange={(e) => setActorType(e.target.value)}
          >
            <option value="">全部主体</option>
            <option value="USER">USER（操作员）</option>
            <option value="AGENT">AGENT（AI Agent）</option>
          </select>
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-action">操作动作</label>
          <input
            id="audit-action"
            type="text"
            className="field num"
            placeholder="如 AUTH_LOGIN / ACCESS_DENIED"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-outcome">执行结果</label>
          <select
            id="audit-outcome"
            className="field"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value="">全部结果</option>
            <option value="SUCCESS">SUCCESS（成功）</option>
            <option value="DENIED">DENIED（越权拦截）</option>
            <option value="FAILED">FAILED（失败）</option>
          </select>
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-from">开始时间</label>
          <input
            id="audit-from"
            type="datetime-local"
            className="field num"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
          />
        </div>

        <div className="sec-field-group">
          <label htmlFor="audit-to">结束时间</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="audit-to"
              type="datetime-local"
              className="field num"
              style={{ flex: 1 }}
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
            />
            <button type="submit" className="btn pri sm" disabled={loading}>
              检索
            </button>
            <button type="button" className="btn sm" onClick={handleReset} disabled={loading}>
              重置
            </button>
          </div>
        </div>
      </form>

      {errorMsg && (
        <div className="sec-feedback is-err" role="alert">
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="box sec-card">
        {loading ? (
          <div className="loading">正在检索操作审计日志…</div>
        ) : data.items.length === 0 ? (
          <div className="empty">未匹配到符合条件的操作审计记录</div>
        ) : (
          <div className="sec-table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>发生时间</th>
                  <th>操作人与主体</th>
                  <th>角色 / Agent</th>
                  <th>操作动作</th>
                  <th>单据 / 目标</th>
                  <th>请求路径</th>
                  <th>结果</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td className="num">{formatTs(item.occurredAt)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CodeBadge>{item.actor || 'ANONYMOUS'}</CodeBadge>
                        <span className={`tag ${item.actorType === 'AGENT' ? 'run' : 'kind'}`}>
                          {item.actorType === 'AGENT' ? 'AGENT' : 'USER'}
                        </span>
                      </div>
                    </td>
                    <td className="num">{item.agentId || item.actorRole || '—'}</td>
                    <td className="num">{item.action}</td>
                    <td>
                      <span className="num">
                        {item.targetType || '—'}
                        {item.targetId ? ` : ${item.targetId}` : ''}
                      </span>
                    </td>
                    <td className="num">
                      {item.httpMethod || '—'} {item.requestPath || ''}
                    </td>
                    <td>
                      <span className={`tag ${outcomeTone(item.outcome)}`}>
                        {item.outcome}
                        {item.httpStatus ? ` (${item.httpStatus})` : ''}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setSelectedRecord(item)}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="pager">
          <span className="num">
            第 {page + 1} / {totalPages} 页 · 共 {data.total} 条
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn sm"
              disabled={loading || page <= 0}
              onClick={() => void loadPage(0)}
            >
              首页
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={loading || page <= 0}
              onClick={() => void loadPage(page - 1)}
            >
              上一页
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={loading || page + 1 >= totalPages}
              onClick={() => void loadPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      <ModalDialog
        open={Boolean(selectedRecord)}
        title={`审计记录详情：${selectedRecord?.action || ''}`}
        maxWidth={580}
        onClose={() => setSelectedRecord(null)}
      >
        {selectedRecord && (
          <div className="sec-dialog-form">
            <div className="sec-kv-grid">
              <span className="sec-kv-label">记录 ID</span>
              <CodeBadge>{selectedRecord.id}</CodeBadge>
              <span className="sec-kv-label">发生时间</span>
              <span className="num">{formatTs(selectedRecord.occurredAt)}</span>
              <span className="sec-kv-label">操作主体</span>
              <span className="num">
                {selectedRecord.actor} ({selectedRecord.actorType}
                {selectedRecord.actorRole ? ` / ${selectedRecord.actorRole}` : ''})
              </span>
              <span className="sec-kv-label">Trace ID</span>
              <span className="num">{selectedRecord.traceId || '—'}</span>
              <span className="sec-kv-label">来源 IP</span>
              <span className="num">{selectedRecord.clientIp || '—'}</span>
              <span className="sec-kv-label">HTTP 请求</span>
              <span className="num">
                {selectedRecord.httpMethod || '—'} {selectedRecord.requestPath || '—'} →{' '}
                {selectedRecord.httpStatus ?? '—'}
              </span>
            </div>
            <div className="sec-field-group">
              <label>脱敏业务上下文（detailJson）</label>
              <pre className="sec-audit-detail-pre">
                {formatDetailJson(selectedRecord.detailJson)}
              </pre>
            </div>
          </div>
        )}
      </ModalDialog>
    </div>
  );
};
