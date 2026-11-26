/**
 * 求解作业 SSE / 轮询实时阶段文本格式化工具。
 */

const PHASE_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  PENDING: '等待调度',
  PREPARING: '模型准备',
  INIT: '初始化',
  SOLVING: '求解搜索中',
  RUNNING: '求解中',
  SEARCHING: '布局寻优中',
  COLUMN_GENERATION: '列生成求解',
  MIP: '整数规划求解',
  LNS: '邻域精修中',
  LOCAL_SEARCH: '局部优化中',
  VALIDATING: '几何校验中',
  FINALIZING: '结果归档中',
  COMPLETED: '已完成',
  SUCCEEDED: '已完成',
  STOPPING: '正在停止',
  STOPPED: '已停止',
  CANCEL_REQUESTED: '正在取消',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  FAILED: '求解失败'
};

export interface SolverProgressInput {
  state?: string;
  status?: string;
  phase?: string | null;
  elapsedMs?: number | null;
  transport?: string;
}

export function formatSolverPhaseLabel(phase?: string | null, state?: string | null): string {
  const rawPhase = String(phase || '').trim().toUpperCase();
  if (rawPhase && PHASE_LABELS[rawPhase]) {
    return PHASE_LABELS[rawPhase];
  }
  if (rawPhase) {
    return rawPhase;
  }
  const rawState = String(state || '').trim().toUpperCase();
  return PHASE_LABELS[rawState] || '';
}

export function formatSolverProgressText(input: SolverProgressInput): string {
  const state = input.state || input.status || '';
  const label = formatSolverPhaseLabel(input.phase, state);
  const elapsedMs = typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs)
    ? Math.max(0, input.elapsedMs)
    : null;
  const elapsedPart = elapsedMs !== null && elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
  const streamTag = input.transport === 'sse' ? '实时' : '';

  if (label && elapsedPart) {
    return streamTag ? `${label} · ${elapsedPart} (${streamTag})` : `${label} · ${elapsedPart}`;
  }
  if (label) {
    return streamTag ? `${label} (${streamTag})` : label;
  }
  return elapsedPart;
}
