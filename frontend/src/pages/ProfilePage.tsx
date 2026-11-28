import React from 'react';
import { AuthSession } from '../utils/authClient';
import { AccountProfilePanel } from '../components/AccountProfilePanel';

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

      <AccountProfilePanel auth={auth} onLogout={onLogout} layout="grid" />
    </div>
  );
};
