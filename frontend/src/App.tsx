import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { CuttingWorkbenchPage } from './pages/CuttingWorkbenchPage';
import { SettingsModal } from './components/SettingsModal';
import { AuthGateModal } from './components/AuthGateModal';
import { SettingsTabId } from './store/studioSettings';
import { requestJSON, toast } from './lib/core/util.js';
import { useWorkspaceNavBadges } from './store/selectors';
import {
  AuthSession,
  LOCAL_FALLBACK_SESSION,
  fetchAuthMe,
  installAuthFetchInterceptor,
  logoutAuth,
  roleDisplayName
} from './utils/authClient';
import { ParsedRoute, WORKBENCH_DEFAULT_ROUTE, parseHashRoute } from './utils/routeUtils';

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
const InventoryPage = lazy(() =>
  import('./pages/InventoryPage').then((m) => ({ default: m.InventoryPage }))
);
const DocumentsPage = lazy(() =>
  import('./pages/DocumentsPage').then((m) => ({ default: m.DocumentsPage }))
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

  const { candidateCount, clusterCount, enabledAlgoCount } = useWorkspaceNavBadges();

  const openSettings = (tab: SettingsTabId = 'general') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  useEffect(() => {
    const syncRoute = () => {
      const next = parseHashRoute(location.hash);
      if (next.redirectTo && location.hash !== next.redirectTo) {
        window.location.replace(next.redirectTo);
      }
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
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('cutplan:open-settings', onOpenEvent);
    if (!location.hash) {
      location.hash = '#/workbench';
    } else {
      const initial = parseHashRoute(location.hash);
      if (initial.redirectTo && location.hash !== initial.redirectTo) {
        window.location.replace(initial.redirectTo);
      }
    }
    return () => {
      window.removeEventListener('hashchange', syncRoute);
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

  const categories: NavCategory[] = useMemo(
    () => [
      {
        id: 'demand',
        label: '订单需求',
        items: [
          {
            id: 'demands',
            label: '新建订单',
            href: '#/demands',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8.5 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V7" />
                <path d="M5 5.6h4M5 8.4h2.6" />
                <path d="M11.5 9.2v4.6M9.2 11.5h4.6" />
              </svg>
            ),
            isActive: (r) => r.page === 'demands'
          },
          {
            id: 'demand-library',
            label: '待排订单',
            href: '#/demand-library',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.6" />
                <path d="M4.8 5.6h6.4M4.8 8.2h4.2" />
                <path d="M4.8 10.8h6.4" opacity="0.32" />
                <path d="M4.8 10.8h3.8" />
              </svg>
            ),
            isActive: (r) => r.page === 'demand-library'
          },
          {
            id: 'clusters',
            label: '纸样模板',
            href: '#/clusters',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.5 5.2h6.3l2 2v6.3H2.5V5.2Z" />
                <path d="M5.4 5.2V3.3a.8.8 0 0 1 .8-.8h5.2l2.1 2.1v5.9a.8.8 0 0 1-.8.8h-1.9" />
              </svg>
            ),
            badge: clusterCount || undefined,
            isActive: (r) => r.page === 'clusters'
          }
        ]
      },
      {
        id: 'solving',
        label: '排料工作台',
        items: [
          {
            id: 'workbench',
            label: '搭切工作台',
            href: '#/workbench',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.4" />
                <path d="M9.4 2.6v10.8M2.2 8.2h7.2M9.4 6.2h4.4" />
              </svg>
            ),
            badge: candidateCount || undefined,
            isActive: (r) => r.page === 'workbench' || r.page === 'slitting'
          }
        ]
      },
      {
        id: 'results',
        label: '产出与核算',
        items: [
          {
            id: 'results-center',
            label: '方案与工单',
            href: '#/results',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8.5 2.6H3.4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9.2a1 1 0 0 0 1-1V7.6" />
                <rect x="4.6" y="7.8" width="3.4" height="3.2" rx="0.5" />
                <path d="M4.6 5.4h2.8M9.5 6.5l4-4M10.4 2.5h3.1v3.1" />
              </svg>
            ),
            isActive: (r) => r.page === 'results'
          },
          {
            id: 'reconciliation',
            label: '复检与对账',
            href: '#/reconciliation',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 2.2 13 4.2v3.7c0 3-2 4.9-5 5.9-3-1-5-2.9-5-5.9V4.2L8 2.2Z" />
                <path d="m5.8 8.1 1.5 1.5 3-3.1" />
              </svg>
            ),
            isActive: (r) => r.page === 'reconciliation'
          },
          {
            id: 'cost-analytics',
            label: '成本与备料',
            href: '#/cost-analytics',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.4 13.2h11.2M4.2 13.2V9.4M7.8 13.2V6.6M11.4 13.2V7.8" />
                <circle cx="11.4" cy="4.1" r="1.4" />
              </svg>
            ),
            isActive: (r) => r.page === 'cost-analytics'
          }
        ]
      },
      {
        id: 'inventory',
        label: '材料库存',
        items: [
          {
            id: 'stock',
            label: '卷料台账',
            href: '#/inventory',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="5.5" cy="6.5" r="3.1" />
                <circle cx="5.5" cy="6.5" r="0.8" />
                <path d="M5.5 3.4h4.8a3.1 3.1 0 0 1 0 6.2" />
                <path d="M5.5 9.6h8l-1.2 3H4.3l1.2-3Z" />
              </svg>
            ),
            isActive: (r) => r.page === 'inventory'
          },
          {
            id: 'inspection',
            label: '验布打标',
            href: '#/inspection',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.2 3.6h11.6M2.2 12.4h11.6" />
                <circle cx="8" cy="8" r="2.3" />
                <path d="M8 4.8V6M8 10v1.2M4.8 8H6M10 8h1.2" />
              </svg>
            ),
            isActive: (r) => r.page === 'inspection'
          },
          {
            id: 'documents',
            label: '出入库单',
            href: '#/documents',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6.8V3.3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3.5M5.5 4.8h5" />
                <path d="M3.2 9.6h9.4m-1.8-1.5 1.8 1.5-1.8 1.5" />
                <path d="M12.6 12.8H3.2M5 11.3l-1.8 1.5L5 14.3" />
              </svg>
            ),
            isActive: (r) => r.page === 'documents'
          }
        ]
      },
      {
        id: 'showcase',
        label: '工艺试验',
        items: [
          {
            id: 'showcase-all',
            label: '示例沙盒',
            href: '#/showcase',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6.2 2.4h3.6M6.8 2.4v3.4L3.4 12a1.2 1.2 0 0 0 1 1.8h7.2a1.2 1.2 0 0 0 1-1.8L9.2 5.8V2.4M4.8 9.8h6.4" />
              </svg>
            ),
            isActive: (r) => r.page === 'showcase'
          },
          {
            id: 'garment',
            label: '服装唛架',
            href: '#/garment',
            icon: (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5.6 2.5 3 4.2l1.2 2.1 1.4-.7v4.5h4.8V5.6l1.4.7L13 4.2l-2.6-1.7a2.4 2.4 0 0 1-4.8 0Z" />
                <path d="M2.6 13h10.8M4.2 11.6 2.6 13l1.6 1.4M11.8 11.6 13.4 13l-1.6 1.4" />
              </svg>
            ),
            isActive: (r) => r.page === 'garment'
          }
        ]
      }
    ],
    [candidateCount, clusterCount]
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
