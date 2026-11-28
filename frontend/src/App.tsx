import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { CuttingWorkbenchPage } from './pages/CuttingWorkbenchPage';
import { SettingsModal } from './components/SettingsModal';
import { SettingsTabId } from './store/studioSettings';
import { requestJSON, toast } from './lib/core/util.js';
import { useWorkspaceNavBadges } from './store/selectors';
import {
  AuthSession,
  LOCAL_FALLBACK_SESSION,
  fetchAuthMe,
  installAuthFetchInterceptor,
  logoutServer,
  roleDisplayName
} from './utils/authClient';
import {
  ParsedRoute,
  WORKBENCH_DEFAULT_ROUTE,
  buildLoginHash,
  parseHashRoute
} from './utils/routeUtils';
import { NavCategory, buildNavCategories, getNavItemIconByPage } from './components/navCategories';
import { WorkspaceTabBar } from './components/WorkspaceTabBar';
import { AccountMenuDrawer } from './components/AccountMenuDrawer';
import { canAccessAdminSecurity } from './utils/securityApi';
import {
  WorkspaceTabItem,
  closeAllClosableTabs,
  closeOtherWorkspaceTabs,
  closeWorkspaceTab,
  loadInitialWorkspaceTabs,
  normalizeTabPageId,
  pruneUnauthorizedTabs,
  saveWorkspaceTabs,
  syncTabsWithRoute
} from './utils/workspaceTabs';

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
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((m) => ({ default: m.LoginPage }))
);
const UsersAdminPage = lazy(() =>
  import('./pages/UsersAdminPage').then((m) => ({ default: m.UsersAdminPage }))
);
const AuditLogsPage = lazy(() =>
  import('./pages/AuditLogsPage').then((m) => ({ default: m.AuditLogsPage }))
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
    return initial.page === 'settings' || initial.page === 'profile'
      ? WORKBENCH_DEFAULT_ROUTE
      : initial;
  });
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => {
    const initial = parseHashRoute(location.hash);
    return initial.page === 'settings';
  });
  const [profileOpen, setProfileOpen] = useState<boolean>(() => {
    const initial = parseHashRoute(location.hash);
    return initial.page === 'profile';
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
  const [authLoaded, setAuthLoaded] = useState<boolean>(false);
  const [authNotice, setAuthNotice] = useState<string>('');
  const [authReloadKey, setAuthReloadKey] = useState<number>(0);
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({
    demand: true,
    solving: true,
    results: true,
    inventory: true,
    showcase: false,
    security: false
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

  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTabItem[]>(() => {
    const initial =
      !location.hash || location.hash === '#/' || location.hash === '#'
        ? WORKBENCH_DEFAULT_ROUTE
        : parseHashRoute(location.hash);
    const contentInitial =
      initial.page === 'settings' || initial.page === 'profile'
        ? WORKBENCH_DEFAULT_ROUTE
        : initial;
    return loadInitialWorkspaceTabs(contentInitial, true, location.hash);
  });

  const openSettings = (tab: SettingsTabId = 'general') => {
    setProfileOpen(false);
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  const openProfileDrawer = () => {
    setSettingsOpen(false);
    setProfileOpen(true);
    if (location.hash !== '#/profile') {
      location.hash = '#/profile';
    }
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
        setProfileOpen(false);
      } else if (next.page === 'profile') {
        setProfileOpen(true);
        setSettingsOpen(false);
      } else {
        setLastContentRoute(next);
        setSettingsOpen(false);
        setProfileOpen(false);
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
      requestJSON('/api/v2/health').catch(() => null),
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
        if (!location.hash.startsWith('#/login')) {
          window.location.replace(buildLoginHash(location.hash));
        }
      }
    });
    fetchAuthMe().then((session) => {
      setAuth(session);
      setAuthLoaded(true);
      if (session.enabled && !session.authenticated) {
        if (!location.hash.startsWith('#/login')) {
          window.location.replace(buildLoginHash(location.hash));
        }
      } else {
        refreshHealth();
      }
    });
    return () => uninstall();
  }, []);

  useEffect(() => {
    if (authLoaded && auth.enabled && !auth.authenticated && route.page !== 'login') {
      window.location.replace(buildLoginHash(location.hash));
    }
  }, [authLoaded, auth.enabled, auth.authenticated, route.page]);

  const handleRefreshAuth = async () => {
    const session = await fetchAuthMe();
    setAuth(session);
  };

  const handleAuthenticated = (session: AuthSession) => {
    setAuth(session);
    setAuthLoaded(true);
    setAuthNotice('');
    setAuthReloadKey((k) => k + 1);
    refreshHealth();
    toast(`欢迎回来，${session.displayName}（${roleDisplayName(session.role)}）`);
  };

  const handleLogout = async () => {
    await logoutServer();
    setAuth((prev) => ({
      ...prev,
      authenticated: false,
      username: '',
      displayName: '未登录',
      actorType: 'USER',
      agentId: null,
      scopes: []
    }));
    setAuthNotice('您已退出当前企业账号，请重新登录');
    if (auth.enabled) {
      window.location.replace('#/login');
    }
  };

  const categories: NavCategory[] = useMemo(
    () => buildNavCategories({ candidateCount, clusterCount, auth }),
    [candidateCount, clusterCount, auth]
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

  const effectiveRoute =
    route.page === 'settings' || route.page === 'profile' ? lastContentRoute : route;
  const adminVisible = canAccessAdminSecurity(auth);
  const activeTabId = normalizeTabPageId(effectiveRoute.page);

  useEffect(() => {
    if (!authLoaded) return;
    setWorkspaceTabs((prev) => {
      const pruned = pruneUnauthorizedTabs(prev, adminVisible);
      const rawHash =
        route.page === 'settings' || route.page === 'profile'
          ? `#/${effectiveRoute.rawKey || effectiveRoute.page}`
          : location.hash || `#/${effectiveRoute.rawKey || effectiveRoute.page}`;
      const next = syncTabsWithRoute(pruned, effectiveRoute, rawHash, adminVisible);
      saveWorkspaceTabs(next);
      return next;
    });
  }, [authLoaded, adminVisible, effectiveRoute, route.page]);

  const handleSelectWorkspaceTab = (tab: WorkspaceTabItem) => {
    if (location.hash !== tab.href) {
      location.hash = tab.href;
    } else if (route.page === 'profile' || route.page === 'settings') {
      setProfileOpen(false);
      setSettingsOpen(false);
      location.hash = tab.href;
    }
  };

  const handleCloseWorkspaceTab = (tabId: string) => {
    setWorkspaceTabs((prev) => {
      const { nextTabs, nextHref } = closeWorkspaceTab(prev, tabId, activeTabId);
      saveWorkspaceTabs(nextTabs);
      if (nextHref) {
        location.hash = nextHref;
      }
      return nextTabs;
    });
  };

  const handleCloseOtherTabs = (keepId: string) => {
    setWorkspaceTabs((prev) => {
      const next = closeOtherWorkspaceTabs(prev, keepId);
      saveWorkspaceTabs(next);
      return next;
    });
  };

  const handleCloseAllTabs = () => {
    setWorkspaceTabs((prev) => {
      const next = closeAllClosableTabs(prev);
      saveWorkspaceTabs(next);
      if (activeTabId !== 'workbench') {
        location.hash = next[0]?.href || '#/workbench';
      }
      return next;
    });
  };

  const handleSettingsClose = () => {
    setSettingsOpen(false);
    if (route.page === 'settings') {
      location.hash = `#/${lastContentRoute.rawKey || 'workbench'}`;
    }
  };

  const handleProfileClose = () => {
    setProfileOpen(false);
    if (route.page === 'profile') {
      location.hash = `#/${lastContentRoute.rawKey || 'workbench'}`;
    }
  };

  const renderMain = () => {
    switch (effectiveRoute.page) {
      case 'demands':
        return <DemandCreatePage appendTaskId={effectiveRoute.appendQuery || undefined} auth={auth} />;
      case 'demand-library':
        return <DemandLibraryPage />;
      case 'clusters':
        return <ClusterCenterPage auth={auth} />;
      case 'workbench':
        return (
          <CuttingWorkbenchPage
            taskId={effectiveRoute.params[0] || effectiveRoute.taskIdQuery || undefined}
            resultId={effectiveRoute.resultIdQuery || undefined}
            draftId={effectiveRoute.draftIdQuery || undefined}
          />
        );
      case 'slitting':
        return <CuttingWorkbenchPage forceDimension="1D" />;
      case 'results':
        return (
          <ResultsCenterPage
            schemeId={effectiveRoute.params[0] || undefined}
            taskIdQuery={effectiveRoute.taskIdQuery || undefined}
            auth={auth}
          />
        );
      case 'reconciliation':
        return <ReconciliationPage auth={auth} />;
      case 'cost-analytics':
        return <CostAnalyticsPage auth={auth} />;
      case 'inventory':
        return <InventoryPage params={effectiveRoute.params} auth={auth} />;
      case 'inspection':
        return <InspectionPage params={effectiveRoute.params} auth={auth} />;
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
      case 'users':
        return <UsersAdminPage auth={auth} />;
      case 'audit-logs':
        return <AuditLogsPage auth={auth} />;
      default:
        return <CuttingWorkbenchPage />;
    }
  };

  const isSettingsRoute = route.page === 'settings';
  const isModalVisible = settingsOpen || isSettingsRoute;
  const isProfileVisible = profileOpen || route.page === 'profile';

  if (!authLoaded) {
    return (
      <div className="sec-login-shell">
        <RouteLoadingFallback />
      </div>
    );
  }

  if ((auth.enabled && !auth.authenticated) || route.page === 'login') {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <LoginPage
          auth={auth}
          sessionNotice={authNotice}
          redirectHash={route.redirectQuery}
          onAuthenticated={handleAuthenticated}
        />
      </Suspense>
    );
  }

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
        <svg
          viewBox="0 0 10 10"
          width="10"
          height="10"
          aria-hidden="true"
          style={{
            transform: navCollapsed ? 'rotate(180deg)' : 'rotate(0deg)'
          }}
        >
          <path
            d="M6.5 2 3.2 5 6.5 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <main className="main" id="main" key={authReloadKey}>
        <header className="mp-global-topbar" aria-label="工作页签与个人中心">
          <WorkspaceTabBar
            tabs={workspaceTabs}
            activeTabId={activeTabId}
            navCollapsed={navCollapsed}
            onToggleNavCollapsed={toggleNavCollapsed}
            onSelectTab={handleSelectWorkspaceTab}
            onCloseTab={handleCloseWorkspaceTab}
            onCloseOthers={handleCloseOtherTabs}
            onCloseAll={handleCloseAllTabs}
            renderIcon={getNavItemIconByPage}
          />
          <AccountMenuDrawer
            auth={auth}
            drawerOpen={isProfileVisible}
            onOpenDrawer={openProfileDrawer}
            onCloseDrawer={handleProfileClose}
            onRefreshAuth={handleRefreshAuth}
            onLogout={handleLogout}
            onOpenSettings={() => openSettings('general')}
          />
        </header>
        <div className="mp-main-viewport">
          <Suspense fallback={<RouteLoadingFallback />}>{renderMain()}</Suspense>
        </div>
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
