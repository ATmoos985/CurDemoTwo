import { describe, expect, it } from 'vitest';
import { buildNavCategories } from '../navCategories';
import { LOCAL_FALLBACK_SESSION } from '../../utils/authClient';

describe('buildNavCategories 系统安全分组权限过滤', () => {
  it('管理员与免登模式可见 6 组 14 项导航（系统安全含用户与 Agent、操作审计，不含个人中心）', () => {
    const localCats = buildNavCategories({
      candidateCount: 0,
      clusterCount: 0,
      auth: LOCAL_FALLBACK_SESSION
    });
    expect(localCats).toHaveLength(6);
    expect(localCats.reduce((sum, c) => sum + c.items.length, 0)).toBe(14);
    const secLocal = localCats.find((c) => c.id === 'security');
    expect(secLocal?.items.map((i) => i.id)).toEqual(['users', 'audit-logs']);

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
    expect(adminCats).toHaveLength(6);
    expect(adminCats.reduce((sum, c) => sum + c.items.length, 0)).toBe(14);
    const secAdmin = adminCats.find((c) => c.id === 'security');
    expect(secAdmin?.items.map((i) => i.id)).toEqual(['users', 'audit-logs']);
  });

  it('非管理员角色隐藏系统安全分组，保留 5 组 12 项导航', () => {
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
    expect(plannerCats).toHaveLength(5);
    expect(plannerCats.reduce((sum, c) => sum + c.items.length, 0)).toBe(12);
    expect(plannerCats.find((c) => c.id === 'security')).toBeUndefined();
  });
});
