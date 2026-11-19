import React, { useEffect, useMemo, useState } from 'react';
import { ClusterCenterPage } from './pages/ClusterCenterPage';
import { DemandPoolPage } from './pages/DemandPoolPage';
import { CuttingWorkbenchPage } from './pages/CuttingWorkbenchPage';
import { ResultsCenterPage } from './pages/ResultsCenterPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { ExecutionCenterPage } from './pages/ExecutionCenterPage';
import { TasksPage } from './pages/TasksPage';
import { TaskEditPage } from './pages/TaskEditPage';
import { QualityPage } from './pages/QualityPage';
import { InventoryPage } from './pages/InventoryPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { InspectionPage } from './pages/InspectionPage';
import { GarmentWidthPage } from './pages/GarmentWidthPage';
import { ShowcasePage } from './pages/ShowcasePage';
import { SettingsModal } from './components/SettingsModal';
import { SettingsTabId } from './store/studioSettings';
import { requestJSON } from '@static/app/js/util.js';
import { useStudioStore } from './store/useStudioStore';

interface ParsedRoute {
  page: string;
  params: string[];
  groupQuery: string;
  taskIdQuery: string;
  rawKey: string;
}

function parseHashRoute(hash: string): ParsedRoute {
  const clean = String(hash || '').replace(/^#\/?/, '');
  const [rawPath = '', query = ''] = clean.split('?');
  const [pageRaw = 'workbench', ...rest] = rawPath.split('/').filter(Boolean);
  const params = rest.map(decodeURIComponent);
  const sp = new URLSearchParams(query);
  const intent = sp.get('intent');
  const groupQuery = sp.get('group') || '';
  const taskIdQuery = sp.get('taskId') || '';
  const rollQuery = sp.get('roll') || '';
  if (intent && params.length < 3) {
    while (params.length < 2) params.push('');
    params.push(intent);
  }
  if (pageRaw === 'inventory' && rollQuery && params.length === 0) {
    params.push(rollQuery);
  }
  const known = [
    'demands',
    'clusters',
    'workbench',
    'slitting',
    'results',
    'reconciliation',
    'inventory',
    'inspection',
    'documents',
    'garment',
    'showcase',
    'settings',
    // Legacy compatibility routes
    'execution',
    'tasks',
    'task',
    'quality',
    'analysis'
  ];
  const page = known.includes(pageRaw) ? pageRaw : 'workbench';
  return { page, params, groupQuery, taskIdQuery, rawKey: clean || 'workbench' };
}

interface NavSubItem {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: number;
  isActive: (r: ParsedRoute) => boolean;
}

interface NavCategory {
  id: string;
  label: string;
  items: NavSubItem[];
}

const WORKBENCH_DEFAULT_ROUTE: ParsedRoute = {
  page: 'workbench',
  params: [],
  groupQuery: '',
  taskIdQuery: '',
  rawKey: 'workbench'
};

const VALID_SETTINGS_TABS: SettingsTabId[] = [
  'general',
  'craft',
  'remnant',
  'engines',
  'integration'
];

export const App: React.FC = () => {
  const [route, setRoute] = useState<ParsedRoute>(() => {
    if (!location.hash || location.hash === '#/' || location.hash === '#') {
      return WORKBENCH_DEFAULT_ROUTE;
    }
    return parseHashRoute(location.hash);
  });
  const [lastContentRoute, setLastContentRoute] = useState<ParsedRoute>(() => {
    const initial =
      !location.hash || location.hash === '#/' || location.hash === '#'
        ? WORKBENCH_DEFAULT_ROUTE
        : parseHashRoute(location.hash);
    return initial.page === 'settings' ? WORKBENCH_DEFAULT_ROUTE : initial;
  });
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => {
    const initial = parseHashRoute(location.hash);
    return initial.page === 'settings';
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>(() => {
    const initial = parseHashRoute(location.hash);
    const candidate = initial.params[0] as SettingsTabId | undefined;
    return initial.page === 'settings' && candidate && VALID_SETTINGS_TABS.includes(candidate)
      ? candidate
      : 'general';
  });
  const [health, setHealth] = useState<{ ok: boolean; workers?: number; engineCount?: number }>({
    ok: false
  });
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({
    demand: true,
    solving: true,
    results: true,
    inventory: true,
    showcase: false
  });

  const schemes2D = useStudioStore((s) => s.schemes2D);
  const slitSchemes = useStudioStore((s) => s.slitSchemes);
  const clusters = useStudioStore((s) => s.clusters);

  const openSettings = (tab: SettingsTabId = 'general') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  useEffect(() => {
    const onHash = () => {
      const next = parseHashRoute(location.hash);
      setRoute(next);
      if (next.page === 'settings') {
        const candidate = next.params[0] as SettingsTabId | undefined;
        setSettingsTab(candidate && VALID_SETTINGS_TABS.includes(candidate) ? candidate : 'general');
        setSettingsOpen(true);
      } else {
        setLastContentRoute(next);
        setSettingsOpen(false);
      }
    };
    const onOpenEvent = (ev: Event) => {
      const detailTab = (ev as CustomEvent)?.detail?.tab as SettingsTabId | undefined;
      openSettings(detailTab && VALID_SETTINGS_TABS.includes(detailTab) ? detailTab : 'general');
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('cutplan:open-settings', onOpenEvent);
    if (!location.hash) {
      location.hash = '#/workbench';
    }
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('cutplan:open-settings', onOpenEvent);
    };
  }, []);

  const refreshHealth = () => {
    Promise.all([
      requestJSON('/api/health').catch(() => null),
      requestJSON('/api/v2/capabilities').catch(() => null)
    ]).then(([h, c]) => {
      const availableEngines =
        (c?.engines || []).filter((e: any) => e.available).length +
        (c?.slittingEngine?.available ? 1 : 0);
      setHealth({
        ok: h?.status === 'UP',
        workers: c?.limits?.workers,
        engineCount: availableEngines || undefined
      });
    });
  };

  useEffect(() => {
    refreshHealth();
  }, []);

  const candidateCount = schemes2D.length + slitSchemes.length;

  const categories: NavCategory[] = useMemo(
    () => [
      {
        id: 'demand',
        label: '需求管理',
        items: [
          {
            id: 'demands',
            label: '待排需求池',
            href: '#/demands',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M3 2.5h7.2L13 5.3v8.2H3v-11Zm7 0v3h3M5.2 8.2h5.6M5.2 10.8h3.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'demands' || r.page === 'tasks' || r.page === 'task'
          },
          {
            id: 'clusters',
            label: '需求模板库',
            href: '#/clusters',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <rect
                  x="2.2"
                  y="2.5"
                  width="5"
                  height="5"
                  rx="1.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <rect
                  x="8.8"
                  y="2.5"
                  width="5"
                  height="5"
                  rx="1.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <rect
                  x="2.2"
                  y="8.8"
                  width="5"
                  height="4.7"
                  rx="1.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M11.3 9.2v4M9.3 11.2h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ),
            badge: clusters.length || undefined,
            isActive: (r) => r.page === 'clusters'
          }
        ]
      },
      {
        id: 'solving',
        label: '搭切工作台',
        items: [
          {
            id: 'workbench',
            label: '智能搭切排程',
            href: '#/workbench',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M2.2 2.6h4.8v4.8H2.2V2.6Zm6.8 0h4.8v3.4H9V2.6ZM9 8h4.8v5.4H9V8Zm-6.8 1.5H7v3.9H2.2V9.5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            badge: candidateCount || undefined,
            isActive: (r) => r.page === 'workbench' || r.page === 'slitting'
          }
        ]
      },
      {
        id: 'results',
        label: '结果管理',
        items: [
          {
            id: 'results-center',
            label: '排程方案与导出',
            href: '#/results',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2.2 5.6 1.8 1.8 3.8-3.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'results' || r.page === 'execution'
          },
          {
            id: 'reconciliation',
            label: '复检补排与对账',
            href: '#/reconciliation',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M8 2.2 13 4.3v3.8c0 2.9-2 4.8-5 5.8-3-1-5-2.9-5-5.8V4.3L8 2.2Zm-1.8 6 1.3 1.3 2.6-2.7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) =>
              r.page === 'reconciliation' || r.page === 'quality' || r.page === 'analysis'
          }
        ]
      },
      {
        id: 'inventory',
        label: '库存管理',
        items: [
          {
            id: 'stock',
            label: '母卷与料头台账',
            href: '#/inventory',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M8 2.2 2.2 5.1 8 8l5.8-2.9L8 2.2ZM2.2 8 8 10.9 13.8 8M2.2 10.9 8 13.8l5.8-2.9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'inventory'
          },
          {
            id: 'inspection',
            label: '跑布验疵定位',
            href: '#/inspection',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <circle
                  cx="7.3"
                  cy="7.3"
                  r="4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="m10.8 10.8 2.7 2.7M7.3 5.3v4M5.3 7.3h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'inspection'
          },
          {
            id: 'documents',
            label: '移库与盘点单据',
            href: '#/documents',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M4.5 2.5h7a1 1 0 0 1 1 1v9.5l-2.2-1.4-2.3 1.4-2.3-1.4L3.5 13V3.5a1 1 0 0 1 1-1Zm1.3 3.4h4.4M5.8 8.4h3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'documents'
          }
        ]
      },
      {
        id: 'showcase',
        label: '示例场景',
        items: [
          {
            id: 'garment',
            label: '多门幅工艺对比',
            href: '#/garment',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M2.5 4.2h11M2.5 8h11M2.5 11.8h7.5M12 10.2v3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'garment'
          },
          {
            id: 'showcase-all',
            label: '全部算例总览',
            href: '#/showcase',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M5.2 3.3 12.4 8l-7.2 4.7V3.3Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) =>
              r.page === 'showcase' &&
              !['服装齐套', '卷材 · 薄膜', '__workflow__'].includes(r.groupQuery)
          },
          {
            id: 'showcase-garment',
            label: '服装齐套算例',
            href: `#/showcase?group=${encodeURIComponent('服装齐套')}`,
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M5.5 2.8 8 4.4l2.5-1.6 2.7 1.9-1.2 2.6-1.4-.6V13.2H5.4V6.7l-1.4.6-1.2-2.6 2.7-1.9Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'showcase' && r.groupQuery === '服装齐套'
          },
          {
            id: 'showcase-slit',
            label: '卷材分切算例',
            href: `#/showcase?group=${encodeURIComponent('卷材 · 薄膜')}`,
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M2.5 4h11v8h-11V4Zm3.6 0v8m3.8-8v8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'showcase' && r.groupQuery === '卷材 · 薄膜'
          },
          {
            id: 'showcase-workflow',
            label: '业务流程演练',
            href: '#/showcase?group=__workflow__',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M3 4.5h3.5v3H3v-3Zm6.5 4H13v3H9.5v-3ZM6.5 6h2a1 1 0 0 1 1 1v1.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'showcase' && r.groupQuery === '__workflow__'
          }
        ]
      }
    ],
    [candidateCount, clusters.length]
  );

  // Ensure the category owning the active route automatically unfolds
  useEffect(() => {
    const activeCat = categories.find((cat) => cat.items.some((it) => it.isActive(route)));
    if (activeCat && !expandedCats[activeCat.id]) {
      setExpandedCats((prev) => ({ ...prev, [activeCat.id]: true }));
    }
  }, [route, categories]);

  const activeBreadcrumb = useMemo(() => {
    if (route.page === 'settings') {
      return { cat: '系统设置', sub: '系统与引擎设置' };
    }
    for (const cat of categories) {
      const sub = cat.items.find((it) => it.isActive(route));
      if (sub) return { cat: cat.label, sub: sub.label };
    }
    return { cat: '搭切工作台', sub: '智能搭切排程' };
  }, [categories, route]);

  const toggleCategory = (id: string) => {
    setExpandedCats((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const effectiveRoute = route.page === 'settings' ? lastContentRoute : route;

  const handleSettingsClose = () => {
    setSettingsOpen(false);
    if (route.page === 'settings') {
      location.hash = `#/${lastContentRoute.rawKey || 'workbench'}`;
    }
  };

  const renderMain = () => {
    switch (effectiveRoute.page) {
      case 'demands':
        return <DemandPoolPage />;
      case 'clusters':
        return <ClusterCenterPage />;
      case 'workbench':
        return <CuttingWorkbenchPage taskId={effectiveRoute.params[0] || undefined} />;
      case 'slitting':
        return <CuttingWorkbenchPage forceDimension="1D" />;
      case 'results':
        return (
          <ResultsCenterPage
            schemeId={effectiveRoute.params[0] || undefined}
            taskIdQuery={effectiveRoute.taskIdQuery || undefined}
          />
        );
      case 'reconciliation':
        return <ReconciliationPage />;
      case 'inventory':
        return <InventoryPage params={effectiveRoute.params} />;
      case 'inspection':
        return <InspectionPage params={effectiveRoute.params} />;
      case 'documents':
        return <DocumentsPage />;
      case 'garment':
        return <GarmentWidthPage exampleId={effectiveRoute.params[0] || undefined} />;
      case 'showcase':
        return (
          <ShowcasePage
            params={effectiveRoute.params}
            groupQuery={effectiveRoute.groupQuery}
          />
        );
      // Legacy compatibility routes
      case 'execution':
        return (
          <ExecutionCenterPage
            taskId={effectiveRoute.params[0] || undefined}
            planId={effectiveRoute.params[1] || undefined}
            intent={effectiveRoute.params[2] || undefined}
          />
        );
      case 'tasks':
        return <TasksPage />;
      case 'task':
        return <TaskEditPage params={effectiveRoute.params} />;
      case 'quality':
        return <QualityPage />;
      case 'analysis':
        return <AnalysisPage />;
      default:
        return <CuttingWorkbenchPage />;
    }
  };

  const isSettingsRoute = route.page === 'settings';
  const isModalVisible = settingsOpen || isSettingsRoute;

  return (
    <div className="app app-magpie">
      <nav className="nav" id="nav" aria-label="功能导航">
        <a className="mp-nav-brand" href="#/workbench" title="CutPlan 智能排料与裁切协同系统">
          <span className="mp-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M3 3h4v4H3V3Zm6 0h4v3H9V3ZM9 7.8h4V13H9V7.8ZM3 8.8h4V13H3V8.8Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span>CutPlan</span>
          <span className="mp-brand-ver num">v2</span>
        </a>

        <div className="nav-main">
          {categories.map((cat) => {
            const isOpen = Boolean(expandedCats[cat.id]);
            const subListId = `nav-sub-${cat.id}`;
            return (
              <div key={cat.id} className="nav-group">
                <button
                  type="button"
                  className="nav-group-trigger"
                  aria-expanded={isOpen}
                  aria-controls={subListId}
                  onClick={() => toggleCategory(cat.id)}
                >
                  <span className="nav-group-label">{cat.label}</span>
                </button>
                <ul id={subListId} className="nav-sublist" hidden={!isOpen}>
                  {cat.items.map((item) => {
                    const active = item.isActive(route);
                    return (
                      <li key={item.id}>
                        <a
                          href={item.href}
                          className={active ? 'on' : undefined}
                          aria-current={active ? 'page' : undefined}
                        >
                          <span className="mp-nav-ico">{item.icon}</span>
                          <span>{item.label}</span>
                          {item.badge !== undefined && (
                            <span className="cnt num">{item.badge}</span>
                          )}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="nav-foot">
          <a
            href="#/settings"
            className={`nav-settings-link ${isSettingsRoute || isModalVisible ? 'on' : ''}`}
            aria-current={isSettingsRoute ? 'page' : undefined}
            aria-haspopup="dialog"
            aria-expanded={isModalVisible}
            onClick={(e) => {
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                openSettings('general');
              }
            }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            <span>系统与引擎设置</span>
          </a>

          <button
            type="button"
            id="engine-status"
            className="mp-engine-foot-btn"
            onClick={() => openSettings('engines')}
            title="点击查看求解引擎并发状态与系统配额"
          >
            <span className={`dot ${health.ok ? 'ok' : 'warn'}`} aria-hidden="true" />
            <span className="mp-engine-label num">
              {health.ok ? '引擎就绪' : '引擎连接中'}
              {health.workers ? ` · ${health.workers}并发` : ''}
              {health.engineCount ? ` · ${health.engineCount}核` : ''}
            </span>
          </button>
        </div>
      </nav>

      <header className="topbar">
        <div className="topbar-context" aria-label="当前工作区位置">
          <span>{activeBreadcrumb.cat}</span>
          <span className="topbar-context-sep" aria-hidden="true">/</span>
          <strong>{activeBreadcrumb.sub}</strong>
        </div>

        <span className="topbar-sp" />

        <div className="mp-top-actions">
          <button
            type="button"
            className="mp-icon-btn"
            onClick={refreshHealth}
            title="刷新引擎与服务状态"
            aria-label="刷新引擎与服务状态"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3M13.2 2.8v2.6h-2.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="mp-icon-btn"
            onClick={() => openSettings('craft')}
            title="打开裁切工艺与全局设置"
            aria-label="打开裁切工艺与全局设置"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <circle cx="5.5" cy="4.5" r="1.4" fill="var(--cp-bg)" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="10.5" cy="8" r="1.4" fill="var(--cp-bg)" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="6.5" cy="11.5" r="1.4" fill="var(--cp-bg)" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
      </header>

      <main className="main" id="main">
        {renderMain()}
      </main>

      <SettingsModal
        open={isModalVisible}
        initialTab={settingsTab}
        onClose={handleSettingsClose}
        onCapabilitiesLoaded={(summary) => setHealth(summary)}
      />
    </div>
  );
};
