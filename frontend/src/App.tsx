import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { CuttingWorkbenchPage } from './pages/CuttingWorkbenchPage';
import { SettingsModal } from './components/SettingsModal';
import { AuthGateModal } from './components/AuthGateModal';
import { SettingsTabId } from './store/studioSettings';
import { requestJSON, toast } from '@static/app/js/util.js';
import { useStudioStore } from './store/useStudioStore';
import {
  AuthSession,
  LOCAL_FALLBACK_SESSION,
  fetchAuthMe,
  installAuthFetchInterceptor,
  logoutAuth,
  roleDisplayName
} from './utils/authClient';

// 非首屏业务页面采用路由级 React.lazy 拆包，显著削减首屏入口包体积
const ClusterCenterPage = lazy(() =>
  import('./pages/ClusterCenterPage').then((m) => ({ default: m.ClusterCenterPage }))
);
const DemandCreatePage = lazy(() =>
  import('./pages/DemandCreatePage').then((m) => ({ default: m.DemandCreatePage }))
);
const DemandLibraryPage = lazy(() =>
  import('./pages/DemandLibraryPage').then((m) => ({ default: m.DemandLibraryPage }))
);
const ResultsCenterPage = lazy(() =>
  import('./pages/ResultsCenterPage').then((m) => ({ default: m.ResultsCenterPage }))
);
const ReconciliationPage = lazy(() =>
  import('./pages/ReconciliationPage').then((m) => ({ default: m.ReconciliationPage }))
);
const ExecutionCenterPage = lazy(() =>
  import('./pages/ExecutionCenterPage').then((m) => ({ default: m.ExecutionCenterPage }))
);
const TasksPage = lazy(() =>
  import('./pages/TasksPage').then((m) => ({ default: m.TasksPage }))
);
const TaskEditPage = lazy(() =>
  import('./pages/TaskEditPage').then((m) => ({ default: m.TaskEditPage }))
);
const QualityPage = lazy(() =>
  import('./pages/QualityPage').then((m) => ({ default: m.QualityPage }))
);
const InventoryPage = lazy(() =>
  import('./pages/InventoryPage').then((m) => ({ default: m.InventoryPage }))
);
const DocumentsPage = lazy(() =>
  import('./pages/DocumentsPage').then((m) => ({ default: m.DocumentsPage }))
);
const AnalysisPage = lazy(() =>
  import('./pages/AnalysisPage').then((m) => ({ default: m.AnalysisPage }))
);
const InspectionPage = lazy(() =>
  import('./pages/InspectionPage').then((m) => ({ default: m.InspectionPage }))
);
const GarmentWidthPage = lazy(() =>
  import('./pages/GarmentWidthPage').then((m) => ({ default: m.GarmentWidthPage }))
);
const ShowcasePage = lazy(() =>
  import('./pages/ShowcasePage').then((m) => ({ default: m.ShowcasePage }))
);
const GlobalPlanningPage = lazy(() =>
  import('./pages/GlobalPlanningPage').then((m) => ({ default: m.GlobalPlanningPage }))
);
const CostAnalyticsPage = lazy(() =>
  import('./pages/CostAnalyticsPage').then((m) => ({ default: m.CostAnalyticsPage }))
);

const RouteLoadingFallback: React.FC = () => (
  <div
    className="react-page"
    role="status"
    aria-live="polite"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 260,
      padding: 24
    }}
  >
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderRadius: 6,
        border: '1px solid var(--line-2, #cbd5e1)',
        background: 'var(--panel, #ffffff)',
        fontSize: 12.5,
        color: 'var(--cp-ink-2, #475569)'
      }}
    >
      <span className="dot ok" aria-hidden="true" />
      <span>正在按需加载业务模块…</span>
    </div>
  </div>
);

interface ParsedRoute {
  page: string;
  params: string[];
  groupQuery: string;
  taskIdQuery: string;
  appendQuery: string;
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
  const appendQuery = sp.get('append') || '';
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
    'demand-library',
    'clusters',
    'workbench',
    'slitting',
    'planning',
    'results',
    'reconciliation',
    'cost-analytics',
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
  return { page, params, groupQuery, taskIdQuery, appendQuery, rawKey: clean || 'workbench' };
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
  appendQuery: '',
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
  const [refreshingHealth, setRefreshingHealth] = useState(false);
  const [auth, setAuth] = useState<AuthSession>(LOCAL_FALLBACK_SESSION);
  const [authNotice, setAuthNotice] = useState<string>('');
  const [authReloadKey, setAuthReloadKey] = useState<number>(0);
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({
    demand: true,
    solving: true,
    results: true,
    inventory: true,
    showcase: false
  });
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cutplan.nav.collapsed') === '1';
    } catch {
      return false;
    }
  });

  const toggleNavCollapsed = () => {
    setNavCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('cutplan.nav.collapsed', next ? '1' : '0');
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
    window.setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 200);
  };

  const schemes2D = useStudioStore((s) => s.schemes2D);
  const slitSchemes = useStudioStore((s) => s.slitSchemes);
  const clusters = useStudioStore((s) => s.clusters);
  const enabledAlgoCount = useStudioStore((s) => s.settings.enabledStrategies2D.length);

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
    setRefreshingHealth(true);
    Promise.all([
      requestJSON('/api/health').catch(() => null),
      requestJSON('/api/v2/capabilities').catch(() => null)
    ])
      .then(([h, c]) => {
        const availableEngines =
          (c?.engines || []).filter((e: any) => e.available).length +
          (c?.slittingEngine?.available ? 1 : 0);
        setHealth({
          ok: h?.status === 'UP',
          workers: c?.limits?.workers,
          engineCount: availableEngines || undefined
        });
      })
      .finally(() => {
        window.setTimeout(() => setRefreshingHealth(false), 320);
      });
  };

  useEffect(() => {
    const uninstall = installAuthFetchInterceptor({
      onUnauthorized: () => {
        setAuth((prev) =>
          prev.enabled ? { ...prev, authenticated: false } : { ...prev, enabled: true, authenticated: false }
        );
        setAuthNotice('会话令牌已失效或已过期，请重新登录');
      }
    });
    fetchAuthMe().then((session) => {
      setAuth(session);
      if (!session.enabled || session.authenticated) {
        refreshHealth();
      }
    });
    return () => uninstall();
  }, []);

  const handleAuthenticated = (session: AuthSession) => {
    setAuth(session);
    setAuthNotice('');
    setAuthReloadKey((k) => k + 1);
    refreshHealth();
    toast(`欢迎回来，${session.displayName}（${roleDisplayName(session.role)}）`);
  };

  const handleLogout = () => {
    logoutAuth();
    setAuth((prev) => ({
      ...prev,
      authenticated: false,
      username: '',
      displayName: '未登录'
    }));
    setAuthNotice('您已退出当前企业账号，请重新登录');
  };

  const candidateCount = schemes2D.length + slitSchemes.length;

  const categories: NavCategory[] = useMemo(
    () => [
      {
        id: 'demand',
        label: '需求管理',
        items: [
          {
            id: 'demands',
            label: '新建需求',
            href: '#/demands',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M8 3.2v9.6M3.2 8h9.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'demands' || r.page === 'task'
          },
          {
            id: 'demand-library',
            label: '需求库',
            href: '#/demand-library',
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
            isActive: (r) => r.page === 'demand-library' || r.page === 'tasks'
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
          },
          {
            id: 'planning',
            label: '联合排产与自动分床',
            href: '#/planning',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M2.5 3.5h11M2.5 8h7.5M2.5 12.5h5.5M11.8 7v5.5M9.5 9.8h4.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'planning'
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
          },
          {
            id: 'cost-analytics',
            label: '成本与备料分析',
            href: '#/cost-analytics',
            icon: (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M2.5 13h11M4.2 13V8.2M8 13V5.2M11.8 13V3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ),
            isActive: (r) => r.page === 'cost-analytics'
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
            id: 'showcase-all',
            label: '算法工作台与场景',
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
            isActive: (r) => r.page === 'showcase'
          },
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
        return <DemandCreatePage appendTaskId={effectiveRoute.appendQuery || undefined} />;
      case 'demand-library':
        return <DemandLibraryPage />;
      case 'clusters':
        return <ClusterCenterPage />;
      case 'workbench':
        return <CuttingWorkbenchPage taskId={effectiveRoute.params[0] || undefined} />;
      case 'slitting':
        return <CuttingWorkbenchPage forceDimension="1D" />;
      case 'planning':
        return <GlobalPlanningPage />;
      case 'results':
        return (
          <ResultsCenterPage
            schemeId={effectiveRoute.params[0] || undefined}
            taskIdQuery={effectiveRoute.taskIdQuery || undefined}
          />
        );
      case 'reconciliation':
        return <ReconciliationPage />;
      case 'cost-analytics':
        return <CostAnalyticsPage />;
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
    <div className={`app app-magpie ${navCollapsed ? 'nav-collapsed' : ''}`}>
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
          <span className="mp-nav-label">CutPlan</span>
          <span className="mp-brand-ver num">v2</span>
        </a>

        <div className="nav-main">
          {categories.map((cat) => {
            const isOpen = navCollapsed || Boolean(expandedCats[cat.id]);
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
                    const tip =
                      item.badge !== undefined ? `${item.label} (${item.badge})` : item.label;
                    return (
                      <li key={item.id}>
                        <a
                          href={item.href}
                          className={active ? 'on' : undefined}
                          aria-current={active ? 'page' : undefined}
                          title={navCollapsed ? tip : undefined}
                        >
                          <span className="mp-nav-ico">{item.icon}</span>
                          <span className="mp-nav-label">{item.label}</span>
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
          {auth.enabled && (
            <div
              className="mp-auth-foot-card"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: navCollapsed ? 'center' : 'space-between',
                gap: 6,
                padding: navCollapsed ? '6px 4px' : '6px 8px',
                marginBottom: 6,
                borderRadius: 6,
                border: '1px solid var(--line-2, rgba(148,163,184,0.28))',
                background: 'var(--panel-2, rgba(15,23,42,0.04))',
                fontSize: 11.5
              }}
              title={
                auth.authenticated
                  ? `当前操作员：${auth.displayName} (${auth.username}) · ${roleDisplayName(auth.role)}`
                  : '企业认证已开启，等待登录'
              }
            >
              {navCollapsed ? (
                <button
                  type="button"
                  className="mp-foot-action"
                  style={{ width: '100%', padding: 2 }}
                  onClick={handleLogout}
                  aria-label="退出登录"
                  title={`${auth.displayName} (${roleDisplayName(auth.role)}) · 点击登出`}
                >
                  <span className="num" style={{ fontWeight: 700 }}>
                    {(auth.displayName || auth.username || 'U').slice(0, 1).toUpperCase()}
                  </span>
                </button>
              ) : (
                <>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {auth.authenticated ? auth.displayName || auth.username : '未登录'}
                    </div>
                    <div style={{ fontSize: 10.5, opacity: 0.75 }}>
                      {auth.authenticated ? roleDisplayName(auth.role) : '等待身份认证'}
                    </div>
                  </div>
                  {auth.authenticated && (
                    <button
                      type="button"
                      className="btn sm"
                      style={{ padding: '2px 7px', fontSize: 11, flex: 'none' }}
                      onClick={handleLogout}
                    >
                      登出
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          <div className="mp-nav-foot-actions">
            <a
              href="#/settings"
              className={`nav-settings-link mp-foot-action ${
                isSettingsRoute || isModalVisible ? 'on' : ''
              }`}
              aria-current={isSettingsRoute ? 'page' : undefined}
              aria-haspopup="dialog"
              aria-expanded={isModalVisible}
              title="系统与引擎设置"
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  openSettings('general');
                }
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M8 2.1 13.1 5v6L8 13.9 2.9 11V5L8 2.1Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
                <circle
                  cx="8"
                  cy="8"
                  r="2.1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.35"
                />
              </svg>
              <span className="mp-nav-label">设置</span>
            </a>

            <button
              type="button"
              className={`mp-foot-action mp-foot-refresh ${refreshingHealth ? 'is-spinning' : ''}`}
              onClick={refreshHealth}
              title="刷新引擎与服务状态"
              aria-label="刷新引擎与服务状态"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3M13.2 2.8v2.6h-2.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="mp-nav-label">刷新</span>
            </button>
          </div>

          <button
            type="button"
            id="engine-status"
            className="mp-engine-foot-btn"
            onClick={() => openSettings('engines')}
            title={`${health.ok ? '引擎就绪' : '引擎连接中'} · ${enabledAlgoCount}算法${
              health.workers ? ` · ${health.workers}并发` : ''
            }（点击管理并行排版算法与系统配额）`}
          >
            <span className={`dot ${health.ok ? 'ok' : 'warn'}`} aria-hidden="true" />
            <span className="mp-engine-label mp-nav-label num">
              {health.ok ? '引擎就绪' : '引擎连接中'}
              {` · ${enabledAlgoCount}算法`}
              {health.workers ? ` · ${health.workers}并发` : ''}
            </span>
          </button>
        </div>
      </nav>

      <button
        type="button"
        className="mp-nav-edge-toggle"
        onClick={toggleNavCollapsed}
        aria-expanded={!navCollapsed}
        aria-controls="nav"
        aria-label={navCollapsed ? '展开左侧导航' : '收起左侧导航'}
        title={navCollapsed ? '展开左侧导航' : '收起左侧导航'}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          {navCollapsed ? (
            <path
              d="M3.5 2 6.8 5 3.5 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.45"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <path
              d="M6.5 2 3.2 5 6.5 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.45"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </button>

      <main className="main" id="main" key={authReloadKey}>
        <Suspense fallback={<RouteLoadingFallback />}>{renderMain()}</Suspense>
      </main>

      <SettingsModal
        open={isModalVisible}
        initialTab={settingsTab}
        onClose={handleSettingsClose}
        onCapabilitiesLoaded={(summary) => setHealth(summary)}
      />

      <AuthGateModal
        open={auth.enabled && !auth.authenticated}
        sessionNotice={authNotice}
        onAuthenticated={handleAuthenticated}
      />
    </div>
  );
};
