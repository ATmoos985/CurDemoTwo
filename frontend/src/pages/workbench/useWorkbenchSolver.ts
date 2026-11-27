import { useEffect, useRef, useState } from 'react';
import { OptimizationSession } from '../../lib/domain/job-client.js';
import { toast } from '../../lib/core/util.js';
import type { LastConfirmSummary } from './workbenchTypes';
import {
  buildSlittingOptimizationRequest,
  extractSlittingKnifeMetrics,
  hasContourOrHolesShape,
  shouldPersistConfirm2DShape,
  type BuildSlittingOptimizationRequestParams,
  type UseWorkbenchSolverOptions
} from './solverRequestBuilders';
import { executeSolve2D } from './workbenchSolve2D';
import { executeSolve1D } from './workbenchSolve1D';
import { executeConfirmScheme1D, executeConfirmScheme2D } from './workbenchSchemeConfirm';

export type { BuildSlittingOptimizationRequestParams, UseWorkbenchSolverOptions };
export {
  buildSlittingOptimizationRequest,
  hasContourOrHolesShape,
  shouldPersistConfirm2DShape,
  extractSlittingKnifeMetrics
};

export function useWorkbenchSolver(opts: UseWorkbenchSolverOptions) {
  const [runningSolve, setRunningSolve] = useState(false);
  const [solveElapsedMs, setSolveElapsedMs] = useState(0);
  const [confirmingScheme, setConfirmingScheme] = useState(false);
  const [lastConfirmSummary, setLastConfirmSummary] = useState<LastConfirmSummary | null>(null);
  const activeSessionsRef = useRef<OptimizationSession[]>([]);
  const solveStartedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!runningSolve) return;
    solveStartedAtRef.current = performance.now();
    setSolveElapsedMs(0);
    const timer = window.setInterval(() => {
      setSolveElapsedMs(Math.max(0, Math.round(performance.now() - solveStartedAtRef.current)));
    }, 250);
    return () => window.clearInterval(timer);
  }, [runningSolve]);

  useEffect(() => {
    return () => {
      activeSessionsRef.current.forEach((s) => s.cancel());
    };
  }, []);

  const handleRunSolve2D = () =>
    executeSolve2D(opts, activeSessionsRef, { setRunningSolve, setLastConfirmSummary });

  const handleRunSolve1D = () =>
    executeSolve1D(opts, activeSessionsRef, { setRunningSolve, setLastConfirmSummary });

  const handleStopSolve = () => {
    activeSessionsRef.current.forEach((s) => s.cancel());
    setRunningSolve(false);
    toast('已停止');
  };

  const handleConfirmSelectedScheme2D = () =>
    executeConfirmScheme2D(opts, confirmingScheme, {
      setConfirmingScheme,
      setLastConfirmSummary
    });

  const handleConfirmSelectedScheme1D = () =>
    executeConfirmScheme1D(opts, confirmingScheme, {
      setConfirmingScheme,
      setLastConfirmSummary
    });

  return {
    runningSolve,
    solveElapsedMs,
    confirmingScheme,
    lastConfirmSummary,
    setLastConfirmSummary,
    handleRunSolve2D,
    handleRunSolve1D,
    handleStopSolve,
    handleConfirmSelectedScheme2D,
    handleConfirmSelectedScheme1D
  };
}
