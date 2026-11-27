import React, { useCallback, useEffect, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { toast } from '../../lib/core/util.js';
import { roleDisplayName } from '../../utils/authClient';
import {
  ROLE_OPTIONS,
  UserAccountView,
  createUser,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserStatus
} from '../../utils/securityApi';

export interface UserAccountsPanelProps {
  onCountChange?: (count: number) => void;
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export const UserAccountsPanel: React.FC<UserAccountsPanelProps> = ({ onCountChange }) => {
  const [users, setUsers] = useState<UserAccountView[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState('PLANNER');
  const [newPassword, setNewPassword] = useState('');

  const [editTarget, setEditTarget] = useState<UserAccountView | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState('PLANNER');

  const [resetTarget, setResetTarget] = useState<UserAccountView | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalErr, setModalErr] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const items = await listUsers();
      setUsers(items);
      onCountChange?.(items.length);
    } catch (err: any) {
      setErrorMsg(err?.message || '加载用户台账失败');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setModalErr('');
    setSubmitting(true);
    try {
      await createUser({
        username: newUsername.trim(),
        displayName: newDisplayName.trim() || newUsername.trim(),
        role: newRole,
        password: newPassword
      });
      toast(`已创建操作员账号 ${newUsername.trim()}`);
      setCreateOpen(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      await reload();
    } catch (err: any) {
      setModalErr(err?.message || '创建用户失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget || submitting) return;
    setModalErr('');
    setSubmitting(true);
    try {
      await updateUser(editTarget.username, {
        displayName: editDisplayName.trim() || editTarget.username,
        role: editRole
      });
      toast(`已更新 ${editTarget.username} 的角色与显示名称`);
      setEditTarget(null);
      await reload();
    } catch (err: any) {
      setModalErr(err?.message || '更新用户失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget || submitting) return;
    setModalErr('');
    setSubmitting(true);
    try {
      const res = await resetUserPassword(resetTarget.username, resetPwd);
      toast(`已重置 ${resetTarget.username} 密码（令牌版本升至 v${res.tokenVersion}）`);
      setResetTarget(null);
      setResetPwd('');
      await reload();
    } catch (err: any) {
      setModalErr(err?.message || '重置密码失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (user: UserAccountView) => {
    try {
      const updated = await updateUserStatus(user.username, !user.enabled);
      toast(
        updated.enabled
          ? `已启用账号 ${updated.username}`
          : `已禁用账号 ${updated.username}，其存量令牌已立即吊销`
      );
      await reload();
    } catch (err: any) {
      setErrorMsg(err?.message || '切换账号状态失败');
    }
  };

  return (
    <div className="box sec-card">
      <div className="sec-card-head">
        <div>
          <h2>操作员账户台账</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            禁用账号或重置密码将立即递增令牌版本并使历史 Bearer 令牌失效
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
              setCreateOpen(true);
            }}
          >
            + 新建操作员
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="sec-feedback is-err" role="alert">
          <span>{errorMsg}</span>
        </div>
      )}

      {loading ? (
        <div className="loading">正在读取用户台账…</div>
      ) : users.length === 0 ? (
        <div className="empty">暂无账户记录</div>
      ) : (
        <div className="sec-table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>账号</th>
                <th>显示名称</th>
                <th>角色</th>
                <th>状态</th>
                <th>令牌版本</th>
                <th>最近登录</th>
                <th>改密时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td>
                    <CodeBadge>{u.username}</CodeBadge>
                  </td>
                  <td>{u.displayName}</td>
                  <td>
                    <span className="tag kind">
                      {roleDisplayName(u.role)} ({u.role})
                    </span>
                  </td>
                  <td>
                    <span className={`tag ${u.enabled ? 'ok' : 'err'}`}>
                      {u.enabled ? '启用中' : '已禁用'}
                    </span>
                  </td>
                  <td className="num">v{u.tokenVersion}</td>
                  <td className="num">{formatTs(u.lastLoginAt)}</td>
                  <td className="num">{formatTs(u.passwordUpdatedAt)}</td>
                  <td>
                    <div className="sec-table-actions">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          setModalErr('');
                          setEditTarget(u);
                          setEditDisplayName(u.displayName);
                          setEditRole(u.role);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          setModalErr('');
                          setResetPwd('');
                          setResetTarget(u);
                        }}
                      >
                        重置密码
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void handleToggleStatus(u)}
                      >
                        {u.enabled ? '禁用' : '启用'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ModalDialog
        open={createOpen}
        title="新建操作员账户"
        maxWidth={460}
        onClose={() => setCreateOpen(false)}
      >
        <form className="sec-dialog-form" onSubmit={handleCreate}>
          {modalErr && (
            <div className="sec-feedback is-err" role="alert">
              <span>{modalErr}</span>
            </div>
          )}
          <div className="sec-field-group">
            <label htmlFor="create-user-name">用户名（2-64 位字母数字及 . _ -）</label>
            <input
              id="create-user-name"
              type="text"
              className="field num"
              required
              pattern="^[A-Za-z0-9._-]{2,64}$"
              placeholder="如 operator_02"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
          </div>
          <div className="sec-field-group">
            <label htmlFor="create-user-display">显示名称</label>
            <input
              id="create-user-display"
              type="text"
              className="field"
              placeholder="如 裁床二班张工"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
          </div>
          <div className="sec-field-group">
            <label htmlFor="create-user-role">角色权限</label>
            <select
              id="create-user-role"
              className="field"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sec-field-group">
            <label htmlFor="create-user-pwd">初始密码（至少 6 位）</label>
            <input
              id="create-user-pwd"
              type="password"
              className="field"
              required
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="sec-dialog-foot">
            <button type="button" className="btn sm" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button type="submit" className="btn pri sm" disabled={submitting}>
              {submitting ? '正在创建…' : '创建用户'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(editTarget)}
        title={`编辑账户：${editTarget?.username || ''}`}
        maxWidth={440}
        onClose={() => setEditTarget(null)}
      >
        <form className="sec-dialog-form" onSubmit={handleEdit}>
          {modalErr && (
            <div className="sec-feedback is-err" role="alert">
              <span>{modalErr}</span>
            </div>
          )}
          <div className="sec-field-group">
            <label htmlFor="edit-user-display">显示名称</label>
            <input
              id="edit-user-display"
              type="text"
              className="field"
              required
              value={editDisplayName}
              onChange={(e) => setEditDisplayName(e.target.value)}
            />
          </div>
          <div className="sec-field-group">
            <label htmlFor="edit-user-role">角色权限</label>
            <select
              id="edit-user-role"
              className="field"
              value={editRole}
              onChange={(e) => setEditRole(e.target.value)}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sec-dialog-foot">
            <button type="button" className="btn sm" onClick={() => setEditTarget(null)}>
              取消
            </button>
            <button type="submit" className="btn pri sm" disabled={submitting}>
              {submitting ? '正在保存…' : '保存变更'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(resetTarget)}
        title={`重置密码：${resetTarget?.username || ''}`}
        maxWidth={420}
        onClose={() => setResetTarget(null)}
      >
        <form className="sec-dialog-form" onSubmit={handleResetPassword}>
          {modalErr && (
            <div className="sec-feedback is-err" role="alert">
              <span>{modalErr}</span>
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            重置密码会立即使该账号所有既有的登录令牌失效。
          </p>
          <div className="sec-field-group">
            <label htmlFor="reset-user-pwd">新密码（至少 6 位）</label>
            <input
              id="reset-user-pwd"
              type="password"
              className="field"
              required
              minLength={6}
              value={resetPwd}
              onChange={(e) => setResetPwd(e.target.value)}
            />
          </div>
          <div className="sec-dialog-foot">
            <button type="button" className="btn sm" onClick={() => setResetTarget(null)}>
              取消
            </button>
            <button type="submit" className="btn pri sm" disabled={submitting}>
              {submitting ? '正在提交…' : '确认重置密码'}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
};
