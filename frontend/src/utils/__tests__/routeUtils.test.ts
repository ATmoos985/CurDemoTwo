import { describe, expect, it } from 'vitest';
import { parseHashRoute, resolveLegacyHashRedirect } from '../routeUtils';

describe('现代路由解析与已下线旧兼容路由自动重定向', () => {
  it('将 5 个已下线旧路由收敛重定向至对应现代主路由', () => {
    expect(resolveLegacyHashRedirect('#/tasks')).toBe('#/demand-library');
    expect(resolveLegacyHashRedirect('#/task')).toBe('#/demands');
    expect(resolveLegacyHashRedirect('#/task/new')).toBe('#/demands');
    expect(resolveLegacyHashRedirect('#/task/TASK-01')).toBe('#/demands');
    expect(resolveLegacyHashRedirect('#/execution')).toBe('#/results');
    expect(resolveLegacyHashRedirect('#/execution/TASK-01/PLAN-02')).toBe(
      '#/results?taskId=TASK-01'
    );
    expect(resolveLegacyHashRedirect('#/quality')).toBe('#/reconciliation');
    expect(resolveLegacyHashRedirect('#/analysis')).toBe('#/cost-analytics');
  });

  it('parseHashRoute 对旧路由首帧即解析为目标现代页并携带 redirectTo', () => {
    expect(parseHashRoute('#/tasks')).toMatchObject({
      page: 'demand-library',
      redirectTo: '#/demand-library'
    });
    expect(parseHashRoute('#/task/new')).toMatchObject({
      page: 'demands',
      redirectTo: '#/demands'
    });
    expect(parseHashRoute('#/execution/T-99')).toMatchObject({
      page: 'results',
      taskIdQuery: 'T-99',
      redirectTo: '#/results?taskId=T-99'
    });
    expect(parseHashRoute('#/quality')).toMatchObject({
      page: 'reconciliation',
      redirectTo: '#/reconciliation'
    });
    expect(parseHashRoute('#/analysis')).toMatchObject({
      page: 'cost-analytics',
      redirectTo: '#/cost-analytics'
    });
  });

  it('现代主路由不触发重定向并保留原有查询与路径参数', () => {
    expect(resolveLegacyHashRedirect('#/workbench/T-1')).toBeNull();
    expect(resolveLegacyHashRedirect('#/reconciliation')).toBeNull();
    expect(parseHashRoute('#/inventory?roll=ROLL-1')).toMatchObject({
      page: 'inventory',
      params: ['ROLL-1']
    });
    expect(parseHashRoute('#/inventory?roll=ROLL-1').redirectTo).toBeUndefined();
    expect(parseHashRoute('#/unknown-route')).toMatchObject({ page: 'workbench' });
  });
});
