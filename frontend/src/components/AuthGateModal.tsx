import React, { useEffect, useRef, useState } from 'react';
import { AuthSession, loginWithCredentials, roleDisplayName } from '../utils/authClient';

export interface AuthGateModalProps {
  open: boolean;
  sessionNotice?: string;
  onAuthenticated: (session: AuthSession) => void;
}

/**
 * 非侵入式企业认证登录弹窗：
 * - 仅在后端返回 `enabled=true && !authenticated` 或接口 401 令牌过期时阻断弹出
 * - 采用原生 `<dialog>` 顶层渲染，禁用未认证状态下的 Esc 误关闭
 */
export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  open,
  sessionNotice,
  onAuthenticated
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const preventCancel = (e: Event) => {
      if (open) e.preventDefault();
    };
    dialog.addEventListener('cancel', preventCancel);
    return () => dialog.removeEventListener('cancel', preventCancel);
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErrorMsg('');
    setSubmitting(true);
    try {
      const res = await loginWithCredentials(username, password);
      setPassword('');
      onAuthenticated({
        enabled: true,
        authenticated: true,
        username: res.username,
        displayName: res.displayName,
        role: res.role,
        roles: [res.role],
        expiresAt: res.expiresAt
      });
    } catch (err: any) {
      setErrorMsg(err?.message || '登录验证未通过，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="none"
      aria-labelledby="auth-gate-title"
      className="native-modal-dialog"
      style={{ ['--modal-max-w' as string]: '420px' } as React.CSSProperties}
    >
      <div className="native-modal-head">
        <h2 id="auth-gate-title">CutPlan 企业认证登录</h2>
        <span className="tag kind">RBAC 受控模式</span>
      </div>
      <div className="native-modal-body">
        <form onSubmit={handleSubmit}>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.55 }}>
            当前工厂节点已启用企业身份认证与操作审计。请使用您的工号/账号登录以继续排产、仓储或质检作业。
          </p>

          {(sessionNotice || errorMsg) && (
            <div
              role="alert"
              style={{
                borderLeft: `3px solid ${errorMsg ? '#dc2626' : '#d97706'}`,
                background: errorMsg ? 'rgba(220,38,38,0.08)' : 'rgba(217,119,6,0.08)',
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                color: errorMsg ? '#b91c1c' : '#92400e',
                marginBottom: 12
              }}
            >
              {errorMsg || sessionNotice}
            </div>
          )}

          <div className="form" style={{ gridTemplateColumns: '76px 1fr', padding: '2px 0 12px' }}>
            <label htmlFor="auth-username">操作员账号</label>
            <input
              id="auth-username"
              type="text"
              autoComplete="username"
              required
              autoFocus={open}
              className="field num"
              placeholder="如 admin / planner / operator"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <label htmlFor="auth-password">登录密码</label>
            <input
              id="auth-password"
              type="password"
              autoComplete="current-password"
              required
              className="field"
              placeholder="请输入账号密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div
            style={{
              fontSize: 11.5,
              color: 'var(--cp-ink-3, #64748b)',
              marginBottom: 14,
              lineHeight: 1.5
            }}
          >
            角色权限：{(['ADMIN', 'PLANNER', 'OPERATOR', 'INSPECTOR', 'WAREHOUSE'] as const)
              .map((r) => roleDisplayName(r))
              .join(' / ')}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="submit" className="btn pri" disabled={submitting} style={{ width: '100%' }}>
              {submitting ? '正在验证身份…' : '登录工作台'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
