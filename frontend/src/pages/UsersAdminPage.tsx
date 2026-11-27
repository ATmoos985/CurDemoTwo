import React, { useState } from 'react';
import { SegmentedControl } from '../components/ui/MagpiePrimitives';
import { AuthSession, roleDisplayName } from '../utils/authClient';
import { canAccessAdminSecurity } from '../utils/securityApi';
import { UserAccountsPanel } from './security/UserAccountsPanel';
import { AgentCredentialsPanel } from './security/AgentCredentialsPanel';

export interface UsersAdminPageProps {
  auth: AuthSession;
}

type AdminTab = 'users' | 'agents';

export const UsersAdminPage: React.FC<UsersAdminPageProps> = ({ auth }) => {
  const [tab, setTab] = useState<AdminTab>('users');
  const [userCount, setUserCount] = useState<number | undefined>(undefined);
  const [agentCount, setAgentCount] = useState<number | undefined>(undefined);

  const allowed = canAccessAdminSecurity(auth);

  if (!allowed) {
    return (
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>用户与 AI Agent 管理</h1>
          </div>
        </div>
        <section className="box sec-forbidden-card" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tag err">403 权限不足</span>
            <h2>仅系统管理员（ADMIN）可访问用户与 Agent 凭证台账</h2>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            当前登录身份为「{auth.displayName || auth.username}」（{roleDisplayName(auth.role)}），
            无权创建账号、重置口令或签发/吊销 AI Agent 凭证。如需变更权限请联系管理员。
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

  return (
    <div className="mp-page-shell">
      <div className="mp-page-head">
        <div className="mp-page-title-block">
          <h1>用户与 AI Agent 管理</h1>
          <span className="mp-page-summary">
            数据库持久化用户口令、启停吊销与受限 AI Agent 作用域凭证管理
          </span>
        </div>
        <div className="sp" />
        <SegmentedControl<AdminTab>
          ariaLabel="安全管理切换"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'users', label: '操作员账户', count: userCount, accent: 'indigo' },
            { value: 'agents', label: 'AI Agent 凭证', count: agentCount, accent: 'emerald' }
          ]}
        />
      </div>

      {!auth.enabled && (
        <div className="sec-feedback is-warn" role="status">
          <strong>当前处于本地免登模式（cutdemo.auth.enabled=false）</strong>
          <span>
            您仍可在此预配置系统用户和 AI Agent 凭证；实际鉴权拦截需在服务端开启企业认证后生效。
          </span>
        </div>
      )}

      {tab === 'users' ? (
        <UserAccountsPanel onCountChange={setUserCount} />
      ) : (
        <AgentCredentialsPanel onCountChange={setAgentCount} />
      )}
    </div>
  );
};
