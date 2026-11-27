import React, { useMemo } from 'react';
import { SHOWCASE_CASES } from '../../lib/model/showcase.js';
import { SegmentedControl, SegmentedOption } from '../../components/ui/MagpiePrimitives';
import { GarmentWidthPage } from '../GarmentWidthPage';
import {
  CAP_GROUPS,
  CAP_GROUP_TITLES,
  CapabilityCategory,
  SCENARIO_DOMAINS,
  ShowcaseMainTab,
  getCaseMeta
} from './showcaseCaseMeta';
import {
  CaseInputSummary,
  VerificationRecord,
  matchesShowcaseCase
} from './showcaseEvaluation';
import { CaseThumbSvg } from './ShowcaseThumbnails';

interface ShowcaseOverviewPanelProps {
  mainTab: ShowcaseMainTab;
  onChangeMainTab: (next: ShowcaseMainTab) => void;
  capFilter: CapabilityCategory;
  onChangeCapFilter: (next: CapabilityCategory) => void;
  scenarioFilter: string;
  onChangeScenarioFilter: (next: string) => void;
  activeGroup: string;
  searchQuery: string;
  onChangeSearchQuery: (q: string) => void;
  viewStyle: 'list' | 'card';
  onChangeViewStyle: (next: 'list' | 'card') => void;
  caseInputSummaries: Record<string, CaseInputSummary>;
  verifications: Record<string, VerificationRecord>;
  smokeCases: any[];
  batchRunning: boolean;
  batchProgressText: string;
  onBatchVerify: (targetCases: any[]) => void;
  onCancelBatch: () => void;
}

export const ShowcaseOverviewPanel: React.FC<ShowcaseOverviewPanelProps> = ({
  mainTab,
  onChangeMainTab,
  capFilter,
  onChangeCapFilter,
  scenarioFilter,
  onChangeScenarioFilter,
  activeGroup,
  searchQuery,
  onChangeSearchQuery,
  viewStyle,
  onChangeViewStyle,
  caseInputSummaries,
  verifications,
  smokeCases,
  batchRunning,
  batchProgressText,
  onBatchVerify,
  onCancelBatch
}) => {
  const filterOpts = {
    mainTab,
    capFilter,
    scenarioFilter,
    activeGroup,
    searchQuery
  };

  const visibleCases = useMemo(
    () => SHOWCASE_CASES.filter((c: any) => matchesShowcaseCase(c, filterOpts)),
    [mainTab, capFilter, scenarioFilter, activeGroup, searchQuery]
  );

  const verifiedList = Object.values(verifications);
  const verifiedPassCount = verifiedList.filter((v) => v.pass).length;

  const mainTabOptions: SegmentedOption<ShowcaseMainTab>[] = [
    {
      value: 'lab',
      label: '算法工作台',
      count: SHOWCASE_CASES.length,
      accent: 'indigo'
    },
    {
      value: 'scenario',
      label: '场景空间',
      count: SCENARIO_DOMAINS.length
    },
    {
      value: 'garment',
      label: '多门幅工艺对比'
    }
  ];

  const capFilterOptions: SegmentedOption<CapabilityCategory>[] = useMemo(
    () => [
      { value: 'all', label: '全部算例', count: SHOWCASE_CASES.length },
      {
        value: '2d-guillotine',
        label: '二维套裁与避疵',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '2d-guillotine').length
      },
      {
        value: '2d-contour',
        label: '异形与密排',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '2d-contour').length
      },
      {
        value: '2d-marker',
        label: '服装齐套缩短',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '2d-marker').length
      },
      {
        value: '1d-slitting',
        label: '一维分切搭切',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '1d-slitting').length
      },
      {
        value: 'boundary',
        label: '边界对照',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === 'boundary').length
      }
    ],
    []
  );

  const scenarioFilterOptions: SegmentedOption<string>[] = useMemo(
    () => [
      { value: 'all', label: '全部场景', count: SHOWCASE_CASES.length },
      ...SCENARIO_DOMAINS.map((d) => ({
        value: d.id,
        label: d.title,
        count: SHOWCASE_CASES.filter((c: any) => d.groups.includes(c.group)).length
      }))
    ],
    []
  );

  const viewStyleOptions: SegmentedOption<'list' | 'card'>[] = [
    { value: 'list', label: '列式清单' },
    { value: 'card', label: '简约卡片' }
  ];

  const isSingleGroupFocused =
    (mainTab === 'lab' && capFilter !== 'all') ||
    (mainTab === 'scenario' && scenarioFilter !== 'all');

  const renderCaseItem = (c: any) => {
    const meta = getCaseMeta(c);
    const sum = caseInputSummaries[c.id];
    const ver = verifications[c.id];
    const isHidden = !matchesShowcaseCase(c, filterOpts);

    if (viewStyle === 'list') {
      return (
        <a
          key={c.id}
          className="demo-card mp-case-list-row"
          data-case={c.id}
          href={`#/showcase/${encodeURIComponent(c.id)}`}
          hidden={isHidden}
        >
          <CaseThumbSvg kind={meta.thumb} />
          <div className="mp-clr-main">
            <div className="mp-clr-title-line">
              <b>{c.name}</b>
              <span className="mp-cc3-feature">{meta.featureTag}</span>
            </div>
            <p>{c.note}</p>
          </div>
          <div className="mp-clr-meta num">
            <span className="mp-clr-spec">
              {sum?.specText} · {sum?.pieceSummary}
            </span>
            {ver ? (
              <span className={`mp-lab-ver-badge num ${ver.pass ? 'ok' : 'warn'}`}>
                {ver.badgeText}
              </span>
            ) : (
              <span className="mp-clr-arrow" aria-hidden="true">
                →
              </span>
            )}
          </div>
        </a>
      );
    }

    return (
      <a
        key={c.id}
        className="card demo-card mp-case-card-v4"
        data-case={c.id}
        href={`#/showcase/${encodeURIComponent(c.id)}`}
        hidden={isHidden}
      >
        <CaseThumbSvg kind={meta.thumb} />
        <div className="mp-cc4-body">
          <div className="mp-cc4-head">
            <b>{c.name}</b>
            <span className="mp-cc3-feature">{meta.featureTag}</span>
            {ver && (
              <span className={`mp-lab-ver-badge num ${ver.pass ? 'ok' : 'warn'}`}>
                {ver.badgeText}
              </span>
            )}
          </div>
          <p>{c.note}</p>
          <span className="mp-cc4-spec num">
            {sum?.specText} · {sum?.pieceSummary}
          </span>
        </div>
      </a>
    );
  };

  return (
    <div className="react-page page-host mp-showcase-page">
      <div className="mp-sc-topbar mp-sc-header-v2">
        <div className="mp-sc-brand-title">
          <h1>能力展示</h1>
          <span className="mp-sc-sub num">
            {SHOWCASE_CASES.length} 个标准算例 · 试算不扣库存
          </span>
        </div>

        <SegmentedControl
          options={mainTabOptions}
          value={mainTab}
          onChange={onChangeMainTab}
          ariaLabel="切换算法工作台、场景空间与多门幅工艺对比"
        />

        <span className="sp" />

        {mainTab !== 'garment' && (
          <div className="mp-sc-quick-actions">
            <div className="mp-search-wrap">
              <span className="mp-search-ico" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <circle
                    cx="7.2"
                    cy="7.2"
                    r="4.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="m10.8 10.8 2.8 2.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <input
                className="mp-search-input mp-sc-top-search"
                id="case-search"
                type="search"
                aria-label="查找用例"
                placeholder="搜算例、工艺或行业"
                value={searchQuery}
                onChange={(e) => onChangeSearchQuery(e.target.value)}
              />
            </div>

            {verifiedList.length > 0 && (
              <span className="mp-verify-summary num">
                已检 {verifiedList.length} · 通过 <b>{verifiedPassCount}</b>
              </span>
            )}

            {batchRunning ? (
              <button type="button" className="btn sm" onClick={onCancelBatch}>
                停止快检 ({batchProgressText})
              </button>
            ) : (
              <button
                type="button"
                className="mp-ghost-btn"
                onClick={() => onBatchVerify(smokeCases)}
                title="自动依次检验 10 个核心基准算例并回填实测利用率"
              >
                一键快检 ({smokeCases.length})
              </button>
            )}
          </div>
        )}
      </div>

      {mainTab === 'garment' ? (
        <div className="mp-sc-garment-host">
          <GarmentWidthPage embedded />
        </div>
      ) : (
        <div className="mp-page-shell mp-sc-overview-shell">
          <div className="mp-sc-filter-bar" id="case-tabs">
            {mainTab === 'lab' ? (
              <SegmentedControl
                options={capFilterOptions}
                value={capFilter}
                onChange={onChangeCapFilter}
                ariaLabel="按算法能力筛选"
              />
            ) : (
              <SegmentedControl
                options={scenarioFilterOptions}
                value={scenarioFilter}
                onChange={onChangeScenarioFilter}
                ariaLabel="按行业场景筛选"
              />
            )}

            <div className="mp-sc-filter-right">
              <span className="mp-toolbar-count num">
                显示 {visibleCases.length} / {SHOWCASE_CASES.length}
              </span>
              <SegmentedControl
                options={viewStyleOptions}
                value={viewStyle}
                onChange={onChangeViewStyle}
                ariaLabel="切换列式或卡片视图"
                size="sm"
              />
            </div>
          </div>

          <div
            id="case-catalogue"
            className={`mp-sc-board-v4 ${
              viewStyle === 'list' ? 'is-list-board' : 'is-card-board'
            } ${isSingleGroupFocused ? 'is-single-group' : ''}`}
          >
            {mainTab === 'lab'
              ? CAP_GROUPS.map((cg, gIdx) => {
                  const groupCases = SHOWCASE_CASES.filter(
                    (c: any) => getCaseMeta(c).capGroup === cg
                  );
                  const visibleInGroup = groupCases.filter((c: any) =>
                    matchesShowcaseCase(c, filterOpts)
                  ).length;
                  const [title, tagsText] = CAP_GROUP_TITLES[cg];
                  return (
                    <section
                      key={cg}
                      data-case-group={cg}
                      hidden={visibleInGroup === 0}
                      className="mp-scene-panel"
                    >
                      <div className="mp-scene-panel-head">
                        <span className="mp-scene-index num">0{gIdx + 1}</span>
                        <div className="mp-scene-title-wrap">
                          <h3>{title}</h3>
                          <span className="mp-scene-sub">{tagsText}</span>
                        </div>
                        <span className="mp-scene-count num">{visibleInGroup} 项</span>
                      </div>
                      <div
                        className={
                          viewStyle === 'list' ? 'mp-scene-row-list' : 'mp-case-grid-v4'
                        }
                      >
                        {groupCases.map((c: any) => renderCaseItem(c))}
                      </div>
                    </section>
                  );
                })
              : SCENARIO_DOMAINS.map((dom, gIdx) => {
                  const domCases = SHOWCASE_CASES.filter((c: any) =>
                    dom.groups.includes(c.group)
                  );
                  const visibleInDom = domCases.filter((c: any) =>
                    matchesShowcaseCase(c, filterOpts)
                  ).length;
                  return (
                    <section
                      key={dom.id}
                      data-case-group={dom.id}
                      hidden={visibleInDom === 0}
                      className="mp-scene-panel"
                    >
                      <div className="mp-scene-panel-head">
                        <span className="mp-scene-index num">0{gIdx + 1}</span>
                        <div className="mp-scene-title-wrap">
                          <h3>{dom.title}</h3>
                          <span className="mp-scene-sub">{dom.tags.join(' · ')}</span>
                        </div>
                        <span className="mp-scene-count num">{visibleInDom} 项</span>
                      </div>
                      <div
                        className={
                          viewStyle === 'list' ? 'mp-scene-row-list' : 'mp-case-grid-v4'
                        }
                      >
                        {domCases.map((c: any) => renderCaseItem(c))}
                      </div>
                    </section>
                  );
                })}
          </div>
        </div>
      )}
    </div>
  );
};
