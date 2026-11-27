import React, { useCallback, useEffect, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { toast } from '../../lib/core/util.js';
import {
  AGENT_SCOPE_OPTIONS,
  AgentCredentialView,
  IssueAgentResult,
  issueAgent,
  listAgents,
  revokeAgent
} from '../../utils/securityApi';

export interface AgentCredentialsPanelProps {
  onCountChange?: (count: number) => void;
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function resolveAgentStatus(agent: AgentCredentialView): { label: string; tone: 'ok' | 'err' | 'warn' } {
  if (agent.revokedAt || !agent.enabled) {
    return { label: '已吊销', tone: 'err' };
  }
  if (agent.expiresAt && agent.expiresAt <= Date.now()) {
    return { label: '已过期', tone: 'warn' };
  }
  return { label: '有效', tone: 'ok' };
}

export const AgentCredentialsPanel: React.FC<AgentCredentialsPanelProps> = ({ onCountChange }) => {
  const [agents, setAgents] = useState<AgentCredentialView[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [issueOpen, setIssueOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ttlHours, setTtlHours] = useState('720');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([
    'DEMAND_READ',
    'INVENTORY_READ',
    'PLAN_COMPUTE',
    'DRAFT_WRITE'
  ]);
  const [issuedResult, setIssuedResult] = useState<IssueAgentResult | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<AgentCredentialView | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalErr, setModalErr] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const items = await listAgents();
      setAgents(items);
      onCountChange?.(items.length);
    } catch (err: any) {
      setErrorMsg(err?.message || '加载 AI Agent 凭证失败');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]
    );
  };

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setModalErr('');
    if (selectedScopes.length === 0) {
      setModalErr('请至少选择一个 Agent 权限作用域（scopes）');
      return;
    }
    const parsedTtl = Number(ttlHours);
    if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
      setModalErr('有效期小时数必须为正整数');
      return;
    }

    setSubmitting(true);
    try {
      const res = await issueAgent({
        name: name.trim(),
        scopes: selectedScopes,
        description: description.trim() || undefined,
        ttlHours: Math.trunc(parsedTtl)
      });
      setIssuedResult(res);
      setCopiedToken(false);
      setIssueOpen(false);
      setName('');
      setDescription('');
      toast(`已签发 AI Agent 凭证 ${res.agent.agentId}`);
      await reload();
    } catch (err: any) {
      setModalErr(err?.message || '签发 Agent 凭证失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyToken = async () => {
    if (!issuedResult?.token) return;
    try {
      await navigator.clipboard.writeText(issuedResult.token);
      setCopiedToken(true);
      toast('已复制一次性 Agent Bearer 令牌');
    } catch {
      setCopiedToken(false);
      toast('自动复制失败，请手动选中下方明文令牌复制');
    }
  };

  const handleRevoke = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!revokeTarget || submitting) return;
    setModalErr('');
    setSubmitting(true);
    try {
      await revokeAgent(revokeTarget.agentId, revokeReason.trim() || undefined);
      toast(`已吊销 Agent 凭证 ${revokeTarget.agentId}`);
      setRevokeTarget(null);
      setRevokeReason('');
      await reload();
    } catch (err: any) {
      setModalErr(err?.message || '吊销 Agent 凭证失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="box sec-card">
      <div className="sec-card-head">
        <div>
          <h2>AI Agent 受限凭证台账</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            Agent 仅可执行所选 Scopes 内的只读/试排/草案协同；服务端硬拦截所有确认落库、出入库与质检操作（403）
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => void reload()} disabled={loading}>
            刷新
          </button>
          <button
            type="button"
            className="btn pri sm"
            onClick={() => {
              setModalErr('');
              setIssueOpen(true);
            }}
          >
            + 签发 Agent 凭证
          </button>
        </div>
      </div>

      {issuedResult && (
        <div className="sec-token-reveal" role="status">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <strong>
              新签发一次性令牌：{issuedResult.agent.name}（<span className="num">{issuedResult.agent.agentId}</span>）
            </strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn pri sm" onClick={() => void handleCopyToken()}>
                {copiedToken ? '已复制令牌' : '复制 Bearer 令牌'}
              </button>
              <button type="button" className="btn sm" onClick={() => setIssuedResult(null)}>
                我已保存并关闭
              </button>
            </div>
          </div>
          <div className="sec-token-code" data-testid="agent-once-token">
            {issuedResult.token}
          </div>
          <span style={{ fontSize: 11.5 }}>
            安全提示：服务端不保存明文令牌，关闭此提示后将无法再次查看完整令牌；请立即注入 MCP `CUTTING_AGENT_TOKEN` 或请求头 `X-Cutting-Agent-Token`。
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="sec-feedback is-err" role="alert">
          <span>{errorMsg}</span>
        </div>
      )}

      {loading ? (
        <div className="loading">正在读取 Agent 凭证台账…</div>
      ) : agents.length === 0 ? (
        <div className="empty">暂无已签发的 AI Agent 凭证</div>
      ) : (
        <div className="sec-table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Agent ID</th>
                <th>名称与用途</th>
                <th>允许作用域 (Scopes)</th>
                <th>签发人</th>
                <th>状态</th>
                <th>到期时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const st = resolveAgentStatus(a);
                const revoked = Boolean(a.revokedAt) || !a.enabled;
                return (
                  <tr key={a.agentId}>
                    <td>
                      <CodeBadge>{a.agentId}</CodeBadge>
                    </td>
                    <td className="wrap">
                      <div style={{ fontWeight: 600 }}>{a.name}</div>
                      {a.description && (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {a.description}
                        </div>
                      )}
                    </td>
                    <td className="wrap">
                      <div className="sec-scope-badges">
                        {a.scopes.map((s) => (
                          <CodeBadge key={s}>{s}</CodeBadge>
                        ))}
                      </div>
                    </td>
                    <td className="num">{a.ownerUsername}</td>
                    <td>
                      <span className={`tag ${st.tone}`}>{st.label}</span>
                    </td>
                    <td className="num">{formatTs(a.expiresAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={revoked}
                        onClick={() => {
                          setModalErr('');
                          setRevokeReason('');
                          setRevokeTarget(a);
                        }}
                      >
                        {revoked ? '已吊销' : '吊销'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ModalDialog
        open={issueOpen}
        title="签发 AI Agent 受限凭证"
        maxWidth={540}
        onClose={() => setIssueOpen(false)}
      >
        <form className="sec-dialog-form" onSubmit={handleIssue}>
          {modalErr && (
            <div className="sec-feedback is-err" role="alert">
              <span>{modalErr}</span>
            </div>
          )}
          <div className="sec-field-group">
            <label htmlFor="agent-name">Agent 名称</label>
            <input
              id="agent-name"
              type="text"
              className="field"
              required
              placeholder="如 MCP-排产副驾驶"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="sec-field-group">
            <label htmlFor="agent-desc">用途备注（可选）</label>
            <input
              id="agent-desc"
              type="text"
              className="field"
              placeholder="如 仅允许读取待排订单与生成草案"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="sec-field-group">
            <label htmlFor="agent-ttl">有效期（小时）</label>
            <input
              id="agent-ttl"
              type="number"
              className="field num"
              min={1}
              max={8760}
              required
              value={ttlHours}
              onChange={(e) => setTtlHours(e.target.value)}
            />
          </div>
          <div className="sec-field-group">
            <label>授权作用域（Scopes 多选）</label>
            <div className="sec-scope-grid">
              {AGENT_SCOPE_OPTIONS.map((opt) => (
                <label key={opt.value} className="sec-scope-option">
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(opt.value)}
                    onChange={() => toggleScope(opt.value)}
                  />
                  <div>
                    <strong className="num">{opt.label}</strong>
                    <small>{opt.description}</small>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="sec-dialog-foot">
            <button type="button" className="btn sm" onClick={() => setIssueOpen(false)}>
              取消
            </button>
            <button type="submit" className="btn pri sm" disabled={submitting}>
              {submitting ? '正在签发…' : '签发并展示一次性令牌'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(revokeTarget)}
        title={`吊销 Agent 凭证：${revokeTarget?.agentId || ''}`}
        maxWidth={440}
        onClose={() => setRevokeTarget(null)}
      >
        <form className="sec-dialog-form" onSubmit={handleRevoke}>
          {modalErr && (
            <div className="sec-feedback is-err" role="alert">
              <span>{modalErr}</span>
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            吊销后，使用该凭证发起的所有 MCP 与 REST 请求将立即被拒绝并返回 401。
          </p>
          <div className="sec-field-group">
            <label htmlFor="agent-revoke-reason">吊销原因（写入操作审计）</label>
            <input
              id="agent-revoke-reason"
              type="text"
              className="field"
              placeholder="如 权限轮换或异常终止"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
            />
          </div>
          <div className="sec-dialog-foot">
            <button type="button" className="btn sm" onClick={() => setRevokeTarget(null)}>
              取消
            </button>
            <button type="submit" className="btn pri sm" disabled={submitting}>
              {submitting ? '正在吊销…' : '确认立即吊销'}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
};
