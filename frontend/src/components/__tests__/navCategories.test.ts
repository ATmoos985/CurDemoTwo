import { describe, expect, it } from 'vitest';
import { buildNavCategories } from '../navCategories';
import { LOCAL_FALLBACK_SESSION } from '../../utils/authClient';

describe('buildNavCategories 系统安全分组权限过滤', () => {
  it('管理员与免登模式可见个人中心、用户与 Agent、操作审计', () => {
    const localCats = buildNavCategories({
      candidateCount: 0,
      clusterCount: 0,
      auth: LOCAL_FALLBACK_SESSION
    });
    const secLocal = localCats.find((c) => c.id === 'security');
    expect(secLocal?.items.map((i) => i.id)).toEqual(['profile', 'users', 'audit-logs']);

    const adminCats = buildNavCategories({
      candidateCount: 2,
      clusterCount: 3,
      auth: {
        enabled: true,
        authenticated: true,
        username: 'admin',
        displayName: '系统管理员',
        role: 'ADMIN',
        roles: ['ADMIN']
      }
    });
    const secAdmin = adminCats.find((c) => c.id === 'security');
    expect(secAdmin?.items.map((i) => i.id)).toEqual(['profile', 'users', 'audit-logs']);
  });

  it('非管理员角色隐藏用户与 Agent 与操作审计菜单，仅保留个人中心', () => {
    const plannerCats = buildNavCategories({
      candidateCount: 1,
      clusterCount: 1,
      auth: {
        enabled: true,
        authenticated: true,
        username: 'planner',
        displayName: '排产计划员',
        role: 'PLANNER',
        roles: ['PLANNER']
      }
    });
    const secPlanner = plannerCats.find((c) => c.id === 'security');
    expect(secPlanner?.items.map((i) => i.id)).toEqual(['profile']);
  });
});
