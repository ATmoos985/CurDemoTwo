import React, { useState } from 'react';
import { toast } from '../lib/core/util.js';
import { CodeBadge } from '../components/ui/MagpiePrimitives';
import {
  AuthSession,
  clearAuthToken,
  roleDisplayName
} from '../utils/authClient';
import { changeOwnPassword } from '../utils/securityApi';

export interface ProfilePageProps {
  auth: AuthSession;
  onRefreshAuth: () => Promise<void>;
  onLogout: () => Promise<void> | void;
}

export const ProfilePage: React.FC<ProfilePageProps> = ({
  auth,
  onRefreshAuth,
  onLogout
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);

  const isAgent = String(auth.actorType || 'USER').toUpperCase() === 'AGENT';
  const canChangePassword = auth.enabled && auth.authenticated && !isAgent;

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !canChangePassword) return;
    setFeedback(null);

    if (!currentPassword) {
      setFeedback({ kind: 'err', text: '请输入当前密码' });
      return;
    }
    if (newPassword.length < 6) {
      setFeedback({ kind: 'err', text: '新密码长度不能少于 6 位' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setFeedback({ kind: 'err', text: '两次输入的新密码不一致，请核对' });
      return;
    }
    if (newPassword === currentPassword) {
      setFeedback({ kind: 'err', text: '新密码不能与当前密码相同' });
      return;
    }

    setSubmitting(true);
    try {
      await changeOwnPassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      clearAuthToken();
      toast('密码修改成功，旧令牌已吊销，请使用新密码重新登录');
      await onLogout();
    } catch (err: any) {
      setFeedback({
        kind: 'err',
        text: err?.message || '修改密码失败，请核对当前密码'
      });
    } finally {
      setSubmitting(false);
    }
  };

  const formattedExpiry = auth.expiresAt
    ? new Date(auth.expiresAt).toLocaleString('zh-CN', { hour12: false })
    : '无过期限制';

  return (
    <div className="mp-page-shell">
      <div className="mp-page-head">
        <div className="mp-page-title-block">
          <h1>个人中心</h1>
          <span className="mp-page-summary">
            当前登录主体信息、有效权限范围、自助改密与会话吊销
          </span>
        </div>
        <div className="sp" />
        <button type="button" className="btn sm" onClick={() => void onRefreshAuth()}>
          刷新会话状态
        </button>
        {auth.enabled && auth.authenticated && (
          <button type="button" className="btn sm" onClick={() => void onLogout()}>
            主动登出并吊销令牌
          </button>
        )}
      </div>

      <div className="sec-profile-grid">
        <section className="box sec-card" aria-labelledby="profile-info-title">
          <div className="sec-card-head">
            <h2 id="profile-info-title">身份与授权概览</h2>
            <span className={`tag ${auth.authenticated || !auth.enabled ? 'ok' : 'warn'}`}>
              {!auth.enabled ? '免登本地模式' : auth.authenticated ? '已认证在线' : '未认证'}
            </span>
          </div>

          <div className="sec-kv-grid">
            <span className="sec-kv-label">账号标识</span>
            <div>
              <CodeBadge>{auth.username || 'LOCAL'}</CodeBadge>
            </div>

            <span className="sec-kv-label">显示名称</span>
            <div>{auth.displayName || '—'}</div>

            <span className="sec-kv-label">主体类型</span>
            <div>
              <span className={`tag ${isAgent ? 'run' : 'kind'}`}>
                {isAgent ? 'AI AGENT（受限自动化主体）' : 'USER（人工操作员）'}
              </span>
            </div>

            <span className="sec-kv-label">所属角色</span>
            <div>
              <span className="tag ok">{roleDisplayName(auth.role)}</span>{' '}
              <span className="muted num" style={{ fontSize: 11.5 }}>
                ({auth.role || 'NONE'})
              </span>
            </div>

            {auth.agentId && (
              <>
                <span className="sec-kv-label">Agent ID</span>
                <div>
                  <CodeBadge>{auth.agentId}</CodeBadge>
                </div>
              </>
            )}

            <span className="sec-kv-label">令牌过期时间</span>
            <div className="num">{formattedExpiry}</div>

            <span className="sec-kv-label">有效 Scopes</span>
            <div className="sec-scope-badges">
              {auth.scopes && auth.scopes.length > 0 ? (
                auth.scopes.map((s) => <CodeBadge key={s}>{s}</CodeBadge>)
              ) : (
                <span className="muted">
                  {isAgent ? '未分配作用域' : `由角色 ${auth.role || 'ADMIN'} RBAC 策略控制`}
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="box sec-card" aria-labelledby="profile-pwd-title">
          <div className="sec-card-head">
            <h2 id="profile-pwd-title">修改登录密码</h2>
            <span className="tag kind">PBKDF2-SHA256</span>
          </div>

          {!auth.enabled ? (
            <div className="sec-feedback is-warn">
              <strong>本地免登模式不支持自助改密</strong>
              <span>
                当前服务端未启用企业认证（cutdemo.auth.enabled=false）。如需管理持久化账户与口令，请开启企业认证配置。
              </span>
            </div>
          ) : isAgent ? (
            <div className="sec-feedback is-warn">
              <strong>AI Agent 主体不支持密码修改</strong>
              <span>Agent 凭证由系统管理员在「用户与 Agent」页面统一签发或吊销。</span>
            </div>
          ) : (
            <form className="sec-login-form" onSubmit={handlePasswordSubmit}>
              <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}>
                修改密码后将立即递增账户令牌版本号并吊销当前 Bearer 令牌，系统会自动引导您使用新密码重新登录。
              </p>

              {feedback && (
                <div
                  className={`sec-feedback ${feedback.kind === 'err' ? 'is-err' : 'is-ok'}`}
                  role="alert"
                >
                  <span>{feedback.text}</span>
                </div>
              )}

              <div className="sec-field-group">
                <label htmlFor="profile-cur-pwd">当前密码</label>
                <input
                  id="profile-cur-pwd"
                  type="password"
                  className="field"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>

              <div className="sec-field-group">
                <label htmlFor="profile-new-pwd">新密码（至少 6 位）</label>
                <input
                  id="profile-new-pwd"
                  type="password"
                  className="field"
                  autoComplete="new-password"
                  minLength={6}
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>

              <div className="sec-field-group">
                <label htmlFor="profile-confirm-pwd">确认新密码</label>
                <input
                  id="profile-confirm-pwd"
                  type="password"
                  className="field"
                  autoComplete="new-password"
                  minLength={6}
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="submit" className="btn pri" disabled={submitting}>
                  {submitting ? '正在保存…' : '确认修改密码并重登'}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
};
