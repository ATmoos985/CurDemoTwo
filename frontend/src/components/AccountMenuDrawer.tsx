import React, { useEffect, useRef, useState } from 'react';
import { toast } from '../lib/core/util.js';
import { AuthSession, roleDisplayName } from '../utils/authClient';
import { canAccessAdminSecurity } from '../utils/securityApi';
import { AccountProfilePanel } from './AccountProfilePanel';

export interface AccountMenuDrawerProps {
  auth: AuthSession;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  onRefreshAuth: () => Promise<void>;
  onLogout: () => Promise<void> | void;
  onOpenSettings: () => void;
}

function resolveRoleTone(auth: AuthSession): string {
  if (String(auth.actorType || 'USER').toUpperCase() === 'AGENT') return 'agent';
  const role = String(auth.role || 'ADMIN').toUpperCase();
  switch (role) {
    case 'ADMIN':
      return 'admin';
    case 'PLANNER':
      return 'planner';
    case 'OPERATOR':
      return 'operator';
    case 'INSPECTOR':
      return 'inspector';
    case 'WAREHOUSE':
      return 'warehouse';
    default:
      return 'admin';
  }
}

export const AccountMenuDrawer: React.FC<AccountMenuDrawerProps> = ({
  auth,
  drawerOpen,
  onOpenDrawer,
  onCloseDrawer,
  onRefreshAuth,
  onLogout,
  onOpenSettings
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const isAgent = String(auth.actorType || 'USER').toUpperCase() === 'AGENT';
  const adminVisible = canAccessAdminSecurity(auth);
  const roleTone = resolveRoleTone(auth);
  const displayName = !auth.enabled
    ? '本地免登'
    : auth.authenticated
    ? auth.displayName || auth.username || '操作员'
    : '未登录';
  const avatarChar = (auth.displayName || auth.username || 'L').slice(0, 1).toUpperCase();
  const roleText = roleDisplayName(auth.role);
  const formattedExpiry = auth.expiresAt
    ? new Date(auth.expiresAt).toLocaleString('zh-CN', { hour12: false })
    : '无过期限制';

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseDrawer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, onCloseDrawer]);

  const handleRefreshSession = async () => {
    setRefreshing(true);
    try {
      await onRefreshAuth();
      toast('会话与权限状态已同步');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="mp-account-wrap" ref={wrapRef}>
        <button
          type="button"
          className={`mp-account-trigger ${menuOpen || drawerOpen ? 'is-open' : ''}`}
          data-testid="account-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="个人中心与账号菜单"
          title={`${displayName} (${roleText}) · 点击打开个人中心菜单`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className={`mp-account-avatar tone-${roleTone}`} aria-hidden="true">
            <span className="num">{avatarChar}</span>
            <span
              className={`mp-account-status-dot ${
                !auth.enabled || auth.authenticated ? 'is-online' : 'is-offline'
              }`}
            />
          </span>

          <span className="mp-account-name">{displayName}</span>
          <span className="mp-account-role-pill">{roleText}</span>

          <svg
            className="mp-account-caret"
            viewBox="0 0 12 12"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 4.5 6 7.5l3-3" />
          </svg>
        </button>

        {menuOpen && (
          <div className="mp-account-popover" role="menu" aria-label="账号与安全菜单">
            <div className="mp-account-popover-head">
              <span className={`mp-account-avatar lg tone-${roleTone}`} aria-hidden="true">
                <span className="num">{avatarChar}</span>
              </span>
              <div className="mp-account-popover-meta">
                <div className="mp-account-popover-title">
                  <strong>{displayName}</strong>
                  <span className={`tag ${auth.authenticated || !auth.enabled ? 'ok' : 'warn'}`}>
                    {!auth.enabled ? '免登本地' : auth.authenticated ? '在线' : '未认证'}
                  </span>
                </div>
                <div className="mp-account-popover-sub num">
                  @{auth.username || 'LOCAL'} · {roleText}
                  {isAgent ? ' · AI AGENT' : ''}
                </div>
                {auth.enabled && auth.authenticated && (
                  <div className="mp-account-popover-exp num">令牌有效至 {formattedExpiry}</div>
                )}
              </div>
            </div>

            <div className="mp-account-popover-list">
              <button
                type="button"
                role="menuitem"
                className="mp-menu-item"
                data-testid="account-open-profile"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenDrawer();
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="8" cy="5.5" r="2.5" />
                  <path d="M3.2 13.4c.7-2.2 2.5-3.4 4.8-3.4s4.1 1.2 4.8 3.4" />
                </svg>
                <span>个人中心与修改密码</span>
                <span className="mp-menu-hint">▸</span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="mp-menu-item"
                disabled={refreshing}
                onClick={() => {
                  setMenuOpen(false);
                  void handleRefreshSession();
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3M13.2 2.8v2.6h-2.6" />
                </svg>
                <span>{refreshing ? '正在刷新会话…' : '刷新会话状态'}</span>
              </button>

              {adminVisible && (
                <>
                  <div className="mp-menu-divider" role="separator" />
                  <a
                    href="#/users"
                    role="menuitem"
                    className="mp-menu-item"
                    onClick={() => setMenuOpen(false)}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 2.1 13 4v3.8c0 3-2 5-5 6.1-3-1.1-5-3.1-5-6.1V4l5-1.9Z" />
                      <circle cx="8" cy="7.2" r="1.4" />
                    </svg>
                    <span>用户与 Agent 管理</span>
                  </a>
                  <a
                    href="#/audit-logs"
                    role="menuitem"
                    className="mp-menu-item"
                    onClick={() => setMenuOpen(false)}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2.6" y="2.4" width="10.8" height="11.2" rx="1.4" />
                      <path d="M5.2 5.8h5.6M5.2 8.4h5.6M5.2 11h3.6" />
                    </svg>
                    <span>全站操作审计</span>
                  </a>
                </>
              )}

              <div className="mp-menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="mp-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 2.1 13.1 5v6L8 13.9 2.9 11V5L8 2.1Z" />
                  <circle cx="8" cy="8" r="2.1" />
                </svg>
                <span>系统与引擎设置</span>
              </button>
            </div>

            {auth.enabled && auth.authenticated ? (
              <div className="mp-account-popover-foot">
                <button
                  type="button"
                  role="menuitem"
                  className="mp-menu-item is-danger"
                  data-testid="account-logout-btn"
                  onClick={() => {
                    setMenuOpen(false);
                    void onLogout();
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6.5 13.5H3.8a1.3 1.3 0 0 1-1.3-1.3V3.8a1.3 1.3 0 0 1 1.3-1.3h2.7M10.5 11l3-3-3-3M13.5 8H6.2" />
                  </svg>
                  <span>退出登录并吊销令牌</span>
                </button>
              </div>
            ) : (
              <div className="mp-account-popover-note">
                当前处于本地免登模式（未开启企业 RBAC 令牌认证）
              </div>
            )}
          </div>
        )}
      </div>

      {drawerOpen && (
        <div
          className="mp-account-drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onCloseDrawer();
            }
          }}
        >
          <aside
            className="mp-account-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-drawer-title"
          >
            <header className="mp-account-drawer-head">
              <div className="mp-account-drawer-title-wrap">
                <span className={`mp-account-avatar lg tone-${roleTone}`} aria-hidden="true">
                  <span className="num">{avatarChar}</span>
                </span>
                <div>
                  <h1 id="profile-drawer-title">个人中心</h1>
                  <p>当前登录主体信息、有效权限范围、自助改密与会话吊销</p>
                </div>
              </div>
              <button
                type="button"
                className="mp-icon-btn"
                aria-label="关闭个人中心"
                title="关闭（Esc）"
                onClick={onCloseDrawer}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </header>

            <div className="mp-account-drawer-body">
              <AccountProfilePanel auth={auth} onLogout={onLogout} layout="stack" />
            </div>

            <footer className="mp-account-drawer-foot">
              <button
                type="button"
                className="btn sm"
                disabled={refreshing}
                onClick={() => void handleRefreshSession()}
              >
                {refreshing ? '刷新中…' : '刷新会话状态'}
              </button>
              <div className="sp" />
              {auth.enabled && auth.authenticated && (
                <button
                  type="button"
                  className="btn sm mp-btn-danger"
                  onClick={() => {
                    onCloseDrawer();
                    void onLogout();
                  }}
                >
                  主动登出并吊销令牌
                </button>
              )}
              <button type="button" className="btn sm" onClick={onCloseDrawer}>
                关闭
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
};
