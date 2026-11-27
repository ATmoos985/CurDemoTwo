import React, { useState } from 'react';
import {
  AuthSession,
  loginWithCredentials,
  roleDisplayName
} from '../utils/authClient';
import { sanitizeRedirectHash } from '../utils/routeUtils';
import { ROLE_OPTIONS } from '../utils/securityApi';

export interface LoginPageProps {
  auth: AuthSession;
  sessionNotice?: string;
  redirectHash?: string;
  onAuthenticated: (session: AuthSession) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  auth,
  sessionNotice,
  redirectHash,
  onAuthenticated
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const targetHash = sanitizeRedirectHash(redirectHash);

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
        actorType: 'USER',
        agentId: null,
        scopes: [],
        expiresAt: res.expiresAt
      });
      window.location.replace(targetHash);
    } catch (err: any) {
      setErrorMsg(err?.message || '登录验证未通过，请核对账号与密码后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sec-login-shell">
      <div className="sec-login-frame">
        <aside className="sec-login-aside" aria-label="系统角色与安全说明">
          <div className="sec-login-brand">
            <span className="mp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path
                  d="M3 3h4v4H3V3Zm6 0h4v3H9V3ZM9 7.8h4V13H9V7.8ZM3 8.8h4V13H3V8.8Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <div>
              <h1>CutPlan 工业排产与裁切工作台</h1>
              <span className="muted" style={{ fontSize: 11.5 }}>
                多角色权限隔离 · AI Agent 作用域受控 · 全站操作审计
              </span>
            </div>
          </div>

          <p className="sec-login-lead">
            企业认证模式下，所有排料确认、车间报工、质检放行与库存单据均绑定操作员身份与操作审计流水。
            AI Agent 使用独立受限凭证运行，严禁越权执行确认落库与出库扣减。
          </p>

          <ul className="sec-role-list">
            {ROLE_OPTIONS.map((item) => (
              <li key={item.value} className="sec-role-item">
                <strong className="num">{item.value}</strong>
                <span>{item.summary}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="sec-login-main" aria-labelledby="login-page-title">
          <div className="sec-login-head">
            <h2 id="login-page-title">企业认证登录</h2>
            <span className="tag kind">
              {auth.enabled ? 'RBAC 受控模式' : '本机免登模式'}
            </span>
          </div>

          {!auth.enabled ? (
            <div className="sec-feedback is-ok" role="status">
              <strong>当前节点未启用强制认证（cutdemo.auth.enabled=false）</strong>
              <span>当前处于本地免登沙盒模式，无需输入密码即可直接进入排产与库存工作台。</span>
              <div className="sec-feedback-actions">
                <button
                  type="button"
                  className="btn pri sm"
                  onClick={() => window.location.replace(targetHash)}
                >
                  进入工作台
                </button>
              </div>
            </div>
          ) : auth.authenticated ? (
            <div className="sec-feedback is-ok" role="status">
              <strong>
                当前已登录：{auth.displayName}（<span className="num">{auth.username}</span> ·{' '}
                {roleDisplayName(auth.role)}）
              </strong>
              <span>您可以直接返回目标工作台页面，或前往个人中心管理密码与登出。</span>
              <div className="sec-feedback-actions">
                <button
                  type="button"
                  className="btn pri sm"
                  onClick={() => window.location.replace(targetHash)}
                >
                  前往目标页面
                </button>
                <a className="btn sm" href="#/profile">
                  个人中心
                </a>
              </div>
            </div>
          ) : (
            <form className="sec-login-form" onSubmit={handleSubmit}>
              {(errorMsg || sessionNotice) && (
                <div
                  className={`sec-feedback ${errorMsg ? 'is-err' : 'is-warn'}`}
                  role="alert"
                >
                  <strong>{errorMsg ? '身份验证失败' : '会话状态提示'}</strong>
                  <span>{errorMsg || sessionNotice}</span>
                </div>
              )}

              <div className="sec-field-group">
                <label htmlFor="login-username">操作员账号</label>
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  className="field num"
                  autoComplete="username"
                  required
                  autoFocus
                  placeholder="请输入工号/用户名，如 admin / planner / operator"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>

              <div className="sec-field-group">
                <label htmlFor="login-password">登录密码</label>
                <input
                  id="login-password"
                  name="password"
                  type="password"
                  className="field"
                  autoComplete="current-password"
                  required
                  placeholder="请输入登录密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div className="muted" style={{ fontSize: 11.5 }}>
                登录成功后将自动跳转：<span className="num">{targetHash}</span>
              </div>

              <button
                type="submit"
                className="btn pri"
                disabled={submitting}
                style={{ width: '100%', height: 36 }}
              >
                {submitting ? '正在验证身份…' : '登录并进入系统'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
};
