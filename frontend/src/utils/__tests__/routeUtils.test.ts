import { describe, expect, it } from 'vitest';
import { parseHashRoute, resolveLegacyHashRedirect } from '../routeUtils';

describe('现代路由解析与已下线旧兼容路由自动重定向', () => {
  it('将 6 个已下线旧路由收敛重定向至对应现代主路由并保留可用上下文', () => {
    expect(resolveLegacyHashRedirect('#/tasks')).toBe('#/demand-library');
    expect(resolveLegacyHashRedirect('#/task')).toBe('#/demands');
    expect(resolveLegacyHashRedirect('#/task/new')).toBe('#/demands');
    expect(resolveLegacyHashRedirect('#/task/TASK-01')).toBe('#/demands?append=TASK-01');
    expect(resolveLegacyHashRedirect('#/task/TASK%2001')).toBe('#/demands?append=TASK%2001');
    expect(resolveLegacyHashRedirect('#/planning')).toBe('#/workbench');
    expect(resolveLegacyHashRedirect('#/planning?tab=cutplan')).toBe('#/workbench');
    expect(resolveLegacyHashRedirect('#/execution')).toBe('#/results');
    // 旧 planId 与新版 SchedulingScheme.id 聚合模型不同，非 quality 意图按 taskId 过滤方案列表
    expect(resolveLegacyHashRedirect('#/execution/TASK-01/PLAN-02')).toBe(
      '#/results?taskId=TASK-01'
    );
    expect(resolveLegacyHashRedirect('#/execution/TASK-01')).toBe('#/results?taskId=TASK-01');
    expect(resolveLegacyHashRedirect('#/quality')).toBe('#/reconciliation');
    expect(resolveLegacyHashRedirect('#/analysis')).toBe('#/cost-analytics');
  });

  it('旧执行路由携带 quality 复检意图时精准重定向至复检对账页', () => {
    // ReconciliationPage 当前不支持 URL 查询过滤，保留复检意图直接定向至 #/reconciliation
    expect(resolveLegacyHashRedirect('#/execution/TASK-01/PLAN-02?intent=quality')).toBe(
      '#/reconciliation'
    );
    expect(resolveLegacyHashRedirect('#/execution/TASK-01/PLAN-02/quality')).toBe(
      '#/reconciliation'
    );
    expect(resolveLegacyHashRedirect('#/execution?intent=quality')).toBe('#/reconciliation');
    expect(resolveLegacyHashRedirect('#/execution/TASK-01?foo=1&intent=quality')).toBe(
      '#/reconciliation'
    );
    // 非 quality 的 intent 不误跳复检页，仍按 taskId 过滤结果页
    expect(resolveLegacyHashRedirect('#/execution/TASK-01/PLAN-02?intent=report')).toBe(
      '#/results?taskId=TASK-01'
    );
  });

  it('parseHashRoute 对旧路由首帧即解析为目标现代页并携带 redirectTo 与上下文参数', () => {
    expect(parseHashRoute('#/tasks')).toMatchObject({
      page: 'demand-library',
      redirectTo: '#/demand-library'
    });
    expect(parseHashRoute('#/task/new')).toMatchObject({
      page: 'demands',
      appendQuery: '',
      redirectTo: '#/demands'
    });
    expect(parseHashRoute('#/task/TASK-01')).toMatchObject({
      page: 'demands',
      appendQuery: 'TASK-01',
      redirectTo: '#/demands?append=TASK-01'
    });
    expect(parseHashRoute('#/planning')).toMatchObject({
      page: 'workbench',
      redirectTo: '#/workbench'
    });
    expect(parseHashRoute('#/execution/T-99')).toMatchObject({
      page: 'results',
      taskIdQuery: 'T-99',
      redirectTo: '#/results?taskId=T-99'
    });
    expect(parseHashRoute('#/execution/TASK-01/PLAN-02')).toMatchObject({
      page: 'results',
      taskIdQuery: 'TASK-01',
      redirectTo: '#/results?taskId=TASK-01'
    });
    expect(parseHashRoute('#/execution/TASK-01/PLAN-02?intent=quality')).toMatchObject({
      page: 'reconciliation',
      taskIdQuery: '',
      redirectTo: '#/reconciliation'
    });
    expect(parseHashRoute('#/execution/TASK-01/PLAN-02/quality')).toMatchObject({
      page: 'reconciliation',
      taskIdQuery: '',
      redirectTo: '#/reconciliation'
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
    expect(resolveLegacyHashRedirect('#/demands?append=TASK-01')).toBeNull();
    expect(resolveLegacyHashRedirect('#/results?taskId=TASK-01')).toBeNull();
    expect(resolveLegacyHashRedirect('#/reconciliation')).toBeNull();
    expect(parseHashRoute('#/inventory?roll=ROLL-1')).toMatchObject({
      page: 'inventory',
      params: ['ROLL-1']
    });
    expect(parseHashRoute('#/inventory?roll=ROLL-1').redirectTo).toBeUndefined();
    expect(parseHashRoute('#/unknown-route')).toMatchObject({ page: 'workbench' });
  });

  it('正确解析工作台深链中的 taskId / resultId / draftId 查询参数并保持路径参数兼容', () => {
    expect(
      parseHashRoute('#/workbench?taskId=TASK-100&resultId=JOB-200&draftId=DRAFT-300')
    ).toMatchObject({
      page: 'workbench',
      params: [],
      taskIdQuery: 'TASK-100',
      resultIdQuery: 'JOB-200',
      draftIdQuery: 'DRAFT-300'
    });
    expect(parseHashRoute('#/workbench?taskId=TASK%201&resultId=RES-01')).toMatchObject({
      page: 'workbench',
      taskIdQuery: 'TASK 1',
      resultIdQuery: 'RES-01',
      draftIdQuery: ''
    });
    expect(parseHashRoute('#/workbench?draftId=DRAFT-ONLY')).toMatchObject({
      page: 'workbench',
      taskIdQuery: '',
      resultIdQuery: '',
      draftIdQuery: 'DRAFT-ONLY'
    });
    expect(parseHashRoute('#/workbench/TASK-PATH?resultId=RES-PATH')).toMatchObject({
      page: 'workbench',
      params: ['TASK-PATH'],
      taskIdQuery: '',
      resultIdQuery: 'RES-PATH',
      draftIdQuery: ''
    });
    expect(resolveLegacyHashRedirect('#/workbench?taskId=T-1&resultId=R-1')).toBeNull();
  });
});
