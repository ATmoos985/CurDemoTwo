import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtN } from '../lib/core/util.js';
import { OptimizationSession } from '../lib/domain/job-client.js';
import {
  SHOWCASE_CASES,
  showcaseRequest,
  showcaseScene
} from '../lib/model/showcase.js';
import {
  CapabilityCategory,
  DetailSideTab,
  SCENARIO_DOMAINS,
  ShowcaseMainTab,
  getCaseMeta
} from './showcase/showcaseCaseMeta';
import {
  CaseInputSummary,
  VerificationRecord,
  evaluateCaseResult,
  summarizeCaseInput
} from './showcase/showcaseEvaluation';
import {
  ShowcaseSlitDraft,
  applySlitDraftToRequest,
  buildSlitDraftFromRequest,
  validateShowcaseSlitDraft
} from './showcase/showcaseSlitDraft';
import { ShowcaseOverviewPanel } from './showcase/ShowcaseOverviewPanel';
import { ShowcaseDetailPanel } from './showcase/ShowcaseDetailPanel';

export type {
  ShowcaseMainTab,
  CapabilityCategory,
  DetailSideTab,
  ThumbKind,
  CaseMeta
} from './showcase/showcaseCaseMeta';
export type { ShowcaseSlitDraft } from './showcase/showcaseSlitDraft';
export type { CaseInputSummary, VerificationRecord } from './showcase/showcaseEvaluation';
export {
  buildSlitDraftFromRequest,
  applySlitDraftToRequest,
  validateShowcaseSlitDraft
} from './showcase/showcaseSlitDraft';
export { getCaseMeta } from './showcase/showcaseCaseMeta';
export {
  summarizeCaseInput,
  evaluateCaseResult,
  matchesShowcaseCase,
  buildSlittingCompareRows
} from './showcase/showcaseEvaluation';

export const ShowcasePage: React.FC<{ params?: string[]; groupQuery?: string }> = ({
  params = [],
  groupQuery = ''
}) => {
  const [caseId] = params;
  const selected = useMemo(
    () => SHOWCASE_CASES.find((c: any) => c.id === caseId) || null,
    [caseId]
  );

  // Stage 1 Overview state
  const [mainTab, setMainTab] = useState<ShowcaseMainTab>('lab');
  const [capFilter, setCapFilter] = useState<CapabilityCategory>('all');
  const [activeGroup, setActiveGroup] = useState<string>(
    groupQuery && groupQuery !== '__workflow__' ? groupQuery : 'all'
  );
  const [scenarioFilter, setScenarioFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewStyle, setViewStyle] = useState<'list' | 'card'>('list');

  // Stage 2 Detail side-panel tab: 'data' (数据与结果, default) | 'about' (示例说明)
  const [detailTab, setDetailTab] = useState<DetailSideTab>('data');

  useEffect(() => {
    if (groupQuery && groupQuery !== '__workflow__') {
      setActiveGroup(groupQuery);
      setMainTab('scenario');
      const matched = SCENARIO_DOMAINS.find((d) => d.groups.includes(groupQuery));
      if (matched) setScenarioFilter(matched.id);
    } else {
      setActiveGroup('all');
    }
  }, [groupQuery]);

  const caseInputSummaries = useMemo(() => {
    const map: Record<string, CaseInputSummary> = {};
    for (const c of SHOWCASE_CASES) {
      map[c.id] = summarizeCaseInput(c);
    }
    return map;
  }, []);

  // Detail solver state
  const [request, setRequest] = useState<any>(() =>
    selected ? showcaseRequest(selected.id) : null
  );
  const [result, setResult] = useState<any>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [cancelledHint, setCancelledHint] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [stateText, setStateText] = useState<string>('待计算');
  const [patternIndex, setPatternIndex] = useState<number>(0);
  const [vertical, setVertical] = useState<boolean>(true);
  const [showPath, setShowPath] = useState<boolean>(false);
  const [selectionText, setSelectionText] = useState<string>(
    '滚轮缩放，拖动平移；右键查看裁片尺寸。'
  );
  const [slitRuns, setSlitRuns] = useState<Record<string, any>>({});
  const [slitDraft, setSlitDraft] = useState<ShowcaseSlitDraft | null>(() =>
    selected?.kind === 'slitting' ? buildSlitDraftFromRequest(showcaseRequest(selected.id)) : null
  );

  // Cached verification records across cases
  const [verifications, setVerifications] = useState<
    Record<string, VerificationRecord>
  >({});
  const [batchRunning, setBatchRunning] = useState<boolean>(false);
  const [batchProgressText, setBatchProgressText] = useState<string>('');
  const batchAbortRef = useRef<number>(0);

  const canvasRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const tokenRef = useRef<number>(0);
  const stateRef = useRef({ request, result, patternIndex });
  stateRef.current = { request, result, patternIndex };

  useEffect(() => {
    if (!selected) {
      tokenRef.current++;
      sessionRef.current?.cancel();
      return;
    }

    const cached = verifications[selected.id];
    const initReq = cached?.request || showcaseRequest(selected.id);
    const initRes = cached?.result || null;

    setRequest(initReq);
    setResult(initRes);
    setErrorText(null);
    setCancelledHint(false);
    setBusy(false);
    setStateText(
      initRes
        ? `${
            initRes.fulfillmentStatus === 'COMPLETE'
              ? '计算完成 · 齐套'
              : '计算结束 · 未齐套'
          }`
        : '待计算'
    );
    setPatternIndex(0);
    setVertical(true);
    setShowPath(false);
    setSlitRuns(initRes && selected.kind === 'slitting' ? { FAST: initRes } : {});
    setSlitDraft(selected.kind === 'slitting' ? buildSlitDraftFromRequest(initReq) : null);
    setSelectionText('滚轮缩放，拖动平移；右键查看裁片尺寸。');

    let disposed = false;
    sessionRef.current = new (OptimizationSession as any)(
      undefined,
      150,
      (err?: any) => {
        if (!disposed) setStateText('未确认停止：' + (err?.message || ''));
      }
    );

    return () => {
      disposed = true;
      tokenRef.current++;
      sessionRef.current?.cancel();
    };
  }, [selected?.id]);

  const activeScene = useMemo(() => {
    if (!selected || !request) return null;
    return showcaseScene(request, result, patternIndex);
  }, [selected, request, result, patternIndex]);

  const patchSlitDraft = (patch: Partial<ShowcaseSlitDraft>) => {
    setSlitDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (selected?.kind === 'slitting' && request) {
        setRequest(applySlitDraftToRequest(request, next, request.problem?.profile || 'FAST'));
      }
      return next;
    });
  };

  const handleResetSlitDraft = () => {
    if (!selected || selected.kind !== 'slitting') return;
    const base = showcaseRequest(selected.id, 'FAST');
    const fresh = buildSlitDraftFromRequest(base);
    setSlitDraft(fresh);
    setRequest(applySlitDraftToRequest(base, fresh, 'FAST'));
    setErrorText(null);
  };

  const handleRun = async (profile = 'FAST') => {
    if (!selected || busy) return;
    const mine = ++tokenRef.current;
    const baseReq = showcaseRequest(selected.id, profile);
    let nextReq = baseReq;
    if (selected.kind === 'slitting' && slitDraft) {
      const errMsg = validateShowcaseSlitDraft(slitDraft, (baseReq as any).problem?.orders || []);
      if (errMsg) {
        setErrorText(errMsg);
        return;
      }
      nextReq = applySlitDraftToRequest(baseReq, slitDraft, profile);
    }
    setRequest(nextReq);
    setResult(null);
    setErrorText(null);
    setCancelledHint(false);
    setPatternIndex(0);
    setBusy(true);
    setStateText('排队中');
    const t0 = performance.now();
    try {
      const response = await sessionRef.current.solve(nextReq, {
        onProgress: (j: any) => {
          if (mine === tokenRef.current) {
            setStateText(j.state === 'QUEUED' ? '排队中' : '计算中');
          }
        }
      });
      if (mine !== tokenRef.current) return;
      const res = response.result;
      const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
      setResult(res);
      if (selected.kind === 'slitting') {
        setSlitRuns((prev) => ({ ...prev, [profile]: res }));
      }
      const record = evaluateCaseResult(selected, nextReq, res, elapsedMs);
      setVerifications((prev) => ({ ...prev, [selected.id]: record }));
      setStateText(
        `${res.fulfillmentStatus === 'COMPLETE' ? '齐套' : '未齐套'}${
          response.job.state !== 'SUCCEEDED' ? ' · 提前结束' : ''
        }`
      );
    } catch (e: any) {
      if (mine !== tokenRef.current) return;
      if (e.name === 'AbortError') {
        setStateText('已停止');
      } else {
        setStateText('未完成');
        setErrorText(e.message);
      }
    } finally {
      if (mine === tokenRef.current) {
        setBusy(false);
      }
    }
  };

  const handleCancel = () => {
    tokenRef.current++;
    sessionRef.current?.cancel();
    if (batchRunning) {
      batchAbortRef.current++;
      setBatchRunning(false);
      setBatchProgressText('已停止');
    }
    setBusy(false);
    setStateText('已停止');
    setResult(null);
    setErrorText(null);
    setCancelledHint(true);
  };

  const handleBatchVerify = async (targetCases: any[]) => {
    if (!targetCases.length || batchRunning || busy) return;
    const batchToken = ++batchAbortRef.current;
    setBatchRunning(true);
    for (let i = 0; i < targetCases.length; i++) {
      if (batchToken !== batchAbortRef.current) break;
      const c = targetCases[i];
      setBatchProgressText(`${i + 1}/${targetCases.length} ${c.name}`);
      const req = showcaseRequest(c.id, 'FAST');
      const t0 = performance.now();
      try {
        const tempSession = new (OptimizationSession as any)(undefined, 120);
        const response = await tempSession.solve(req, {});
        if (batchToken !== batchAbortRef.current) break;
        const res = response.result;
        const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
        const record = evaluateCaseResult(c, req, res, elapsedMs);
        setVerifications((prev) => ({ ...prev, [c.id]: record }));
      } catch {
        if (batchToken !== batchAbortRef.current) break;
      }
    }
    if (batchToken === batchAbortRef.current) {
      setBatchRunning(false);
      setBatchProgressText('');
    }
  };

  const handleDownloadJson = (suffix: string, value: any) => {
    if (!selected || !value) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.id}-${suffix}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const smokeCases = useMemo(
    () => SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).smoke),
    []
  );

  if (!selected) {
    return (
      <ShowcaseOverviewPanel
        mainTab={mainTab}
        onChangeMainTab={(next) => {
          setMainTab(next);
          setActiveGroup('all');
        }}
        capFilter={capFilter}
        onChangeCapFilter={(next) => {
          setCapFilter(next);
          setActiveGroup('all');
        }}
        scenarioFilter={scenarioFilter}
        onChangeScenarioFilter={(next) => {
          setScenarioFilter(next);
          setActiveGroup('all');
        }}
        activeGroup={activeGroup}
        searchQuery={searchQuery}
        onChangeSearchQuery={setSearchQuery}
        viewStyle={viewStyle}
        onChangeViewStyle={setViewStyle}
        caseInputSummaries={caseInputSummaries}
        verifications={verifications}
        smokeCases={smokeCases}
        batchRunning={batchRunning}
        batchProgressText={batchProgressText}
        onBatchVerify={handleBatchVerify}
        onCancelBatch={handleCancel}
      />
    );
  }

  return (
    <ShowcaseDetailPanel
      selected={selected}
      request={request}
      result={result}
      errorText={errorText}
      cancelledHint={cancelledHint}
      busy={busy}
      stateText={stateText}
      patternIndex={patternIndex}
      onChangePatternIndex={setPatternIndex}
      vertical={vertical}
      onToggleVertical={() => {
        const next = !vertical;
        setVertical(next);
        canvasRef.current?.setOptions({ vertical: next });
      }}
      showPath={showPath}
      onToggleShowPath={() => {
        const next = !showPath;
        setShowPath(next);
        canvasRef.current?.setOptions({ showPath: next });
      }}
      selectionText={selectionText}
      detailTab={detailTab}
      onChangeDetailTab={setDetailTab}
      activeScene={activeScene}
      canvasRef={canvasRef}
      onContextInspect={(hit) => {
        const st = stateRef.current;
        if (!st.request) return;
        const sc = showcaseScene(st.request, st.result, st.patternIndex);
        const piece = sc.segments[0]?.pieces?.find((pt: any) => pt.id === hit?.entityId);
        setSelectionText(
          piece
            ? `${piece.label} · X ${fmtN(piece.v, 1)} / Y ${fmtN(piece.u, 1)} mm · ${fmtN(
                piece.dv,
                1
              )} × ${fmtN(piece.du, 1)} mm`
            : '右键查看裁片尺寸。'
        );
      }}
      slitRuns={slitRuns}
      slitDraft={slitDraft}
      onPatchSlitDraft={patchSlitDraft}
      onResetSlitDraft={handleResetSlitDraft}
      caseInputSummaries={caseInputSummaries}
      verifications={verifications}
      onDownloadJson={handleDownloadJson}
      onCancel={handleCancel}
      onRun={handleRun}
    />
  );
};
