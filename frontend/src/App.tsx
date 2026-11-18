import React, { useEffect, useMemo, useState } from 'react';
import { ClusterCenterPage } from './pages/ClusterCenterPage';
import { NestingStudio2DPage } from './pages/NestingStudio2DPage';
import { SlittingStudio1DPage } from './pages/SlittingStudio1DPage';
import { ExecutionCenterPage } from './pages/ExecutionCenterPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { TaskEditPage } from './pages/TaskEditPage';
import { QualityPage } from './pages/QualityPage';
import { InventoryPage } from './pages/InventoryPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { InspectionPage } from './pages/InspectionPage';
import { GarmentWidthPage } from './pages/GarmentWidthPage';
import { ShowcasePage } from './pages/ShowcasePage';
import { requestJSON } from '@static/app/js/util.js';
import { useStudioStore } from './store/useStudioStore';

interface ParsedRoute {
  page: string;
  params: string[];
  groupQuery: string;
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
  if (intent && params.length < 3) {
    while (params.length < 2) params.push('');
    params.push(intent);
  }
  const known = [
    'workbench',
    'slitting',
    'clusters',
    'garment',
    'execution',
    'tasks',
    'task',
    'inventory',
    'inspection',
    'documents',
    'quality',
    'analysis',
    'showcase',
    'settings'
  ];
  const page = known.includes(pageRaw) ? pageRaw : 'workbench';
  return { page, params, groupQuery, rawKey: clean || 'workbench' };
}

interface NavSubItem {
  id: string;
  label: string;
  href: string;
  badge?: number;
  isActive: (r: ParsedRoute) => boolean;
}

interface NavCategory {
  id: string;
  label: string;
  icon: React.ReactNode;
  items: NavSubItem[];
}

export const App: React.FC = () => {
  const [route, setRoute] = useState<ParsedRoute>(() => {
    if (!location.hash || location.hash === '#/' || location.hash === '#') {
      return { page: 'workbench', params: [], groupQuery: '', rawKey: 'workbench' };
    }
    return parseHashRoute(location.hash);
  });
  const [health, setHealth] = useState<{ ok: boolean; workers?: number; engineCount?: number }>({
    ok: false
  });
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({
    solving: true,
    execution: true,
    inventory: true,
    showcase: true
  });

  const schemes2D = useStudioStore((s) => s.schemes2D);
  const slitSchemes = useStudioStore((s) => s.slitSchemes);
  const clusters = useStudioStore((s) => s.clusters);

  useEffect(() => {
    const onHash = () => setRoute(parseHashRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    if (!location.hash) {
      location.hash = '#/workbench';
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
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
  }, []);

  const categories: NavCategory[] = useMemo(
    () => [
      {
        id: 'solving',
        label: '求解场景',
        icon: (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M2 2.5h5v5H2v-5Zm7 0h5v3.5H9V2.5ZM9 8h5v5.5H9V8Zm-7 1.5h5v4H2v-4Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        ),
        items: [
          {
            id: 'workbench',
            label: '二维异形排料',
            href: '#/workbench',
            badge: schemes2D.length || undefined,
            isActive: (r) => r.page === 'workbench'
          },
          {
            id: 'slitting',
            label: '一维定长分切',
            href: '#/slitting',
            badge: slitSchemes.length || undefined,
            isActive: (r) => r.page === 'slitting'
          },
          {
            id: 'garment',
            label: '多门幅工艺对比',
            href: '#/garment',
            isActive: (r) => r.page === 'garment'
          },
          {
            id: 'clusters',
            label: '需求与纸样簇',
            href: '#/clusters',
            badge: clusters.length || undefined,
            isActive: (r) => r.page === 'clusters'
          }
        ]
      },
      {
        id: 'execution',
        label: '生产执行',
        icon: (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2.2 5.7 1.8 1.8 3.8-3.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
        items: [
          {
            id: 'tasks',
            label: '生产任务队列',
            href: '#/tasks',
            isActive: (r) => r.page === 'tasks' || r.page === 'task'
          },
          {
            id: 'execution-center',
            label: '执行与报工',
            href: '#/execution',
            isActive: (r) => r.page === 'execution'
          },
          {
            id: 'quality',
            label: '复检处置',
            href: '#/quality',
            isActive: (r) => r.page === 'quality'
          }
        ]
      },
      {
        id: 'inventory',
        label: '库存管理',
        icon: (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M8 2 2 5l6 3 6-3-6-3ZM2 8l6 3 6-3M2 11l6 3 6-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
        items: [
          {
            id: 'stock',
            label: '母卷与余料库存',
            href: '#/inventory',
            isActive: (r) => r.page === 'inventory'
          },
          {
            id: 'inspection',
            label: '跑布验疵定位',
            href: '#/inspection',
            isActive: (r) => r.page === 'inspection'
          },
          {
            id: 'documents',
            label: '移库与盘点单据',
            href: '#/documents',
            isActive: (r) => r.page === 'documents'
          },
          {
            id: 'analysis',
            label: '产出与用料对账',
            href: '#/analysis',
            isActive: (r) => r.page === 'analysis'
          }
        ]
      },
      {
        id: 'showcase',
        label: '示例场景',
        icon: (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M5.5 3.5 12.5 8l-7 4.5v-9Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        ),
        items: [
          {
            id: 'showcase-all',
            label: '全部算例总览',
            href: '#/showcase',
            isActive: (r) =>
              r.page === 'showcase' &&
              !['服装齐套', '卷材 · 薄膜', '__workflow__'].includes(r.groupQuery)
          },
          {
            id: 'showcase-garment',
            label: '服装齐套算例',
            href: `#/showcase?group=${encodeURIComponent('服装齐套')}`,
            isActive: (r) => r.page === 'showcase' && r.groupQuery === '服装齐套'
          },
          {
            id: 'showcase-slit',
            label: '卷材分切算例',
            href: `#/showcase?group=${encodeURIComponent('卷材 · 薄膜')}`,
            isActive: (r) => r.page === 'showcase' && r.groupQuery === '卷材 · 薄膜'
          },
          {
            id: 'showcase-workflow',
            label: '业务流程演练',
            href: '#/showcase?group=__workflow__',
            isActive: (r) => r.page === 'showcase' && r.groupQuery === '__workflow__'
          }
        ]
      }
    ],
    [schemes2D.length, slitSchemes.length, clusters.length]
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
    return { cat: '求解场景', sub: '二维异形排料' };
  }, [categories, route]);

  const toggleCategory = (id: string) => {
    setExpandedCats((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderMain = () => {
    switch (route.page) {
      case 'clusters':
        return <ClusterCenterPage />;
      case 'workbench':
        return <NestingStudio2DPage taskId={route.params[0] || undefined} />;
      case 'slitting':
        return <SlittingStudio1DPage />;
      case 'execution':
        return (
          <ExecutionCenterPage
            taskId={route.params[0] || undefined}
            planId={route.params[1] || undefined}
            intent={route.params[2] || undefined}
          />
        );
      case 'settings':
        return <SettingsPage />;
      case 'garment':
        return <GarmentWidthPage exampleId={route.params[0] || undefined} />;
      case 'tasks':
        return <TasksPage />;
      case 'task':
        return <TaskEditPage params={route.params} />;
      case 'inventory':
        return <InventoryPage params={route.params} />;
      case 'inspection':
        return <InspectionPage params={route.params} />;
      case 'documents':
        return <DocumentsPage />;
      case 'quality':
        return <QualityPage />;
      case 'analysis':
        return <AnalysisPage />;
      case 'showcase':
        return <ShowcasePage params={route.params} groupQuery={route.groupQuery} />;
      default:
        return <NestingStudio2DPage />;
    }
  };

  const isSettingsActive = route.page === 'settings';

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/workbench">
          <i aria-hidden="true" />
          <span>CutPlan 智能排料与裁切协同系统</span>
        </a>

        <div className="topbar-context" aria-label="当前工作区位置">
          <span>{activeBreadcrumb.cat}</span>
          <span className="topbar-context-sep" aria-hidden="true">/</span>
          <strong>{activeBreadcrumb.sub}</strong>
        </div>

        <span className="topbar-sp" />

        <div className="topbar-meta">
          <span id="engine-status" className="engine-pill">
            <span className={`dot ${health.ok ? 'ok' : 'warn'}`} aria-hidden="true" />
            <span>求解引擎</span>
            <b>{health.ok ? '就绪' : '连接中'}</b>
            {health.workers ? <span className="num">· {health.workers} 并发</span> : null}
            {health.engineCount ? <span className="num">· {health.engineCount} 内核</span> : null}
          </span>
        </div>
      </header>

      <nav className="nav" id="nav" aria-label="功能导航">
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
                  <span className="nav-group-icon">{cat.icon}</span>
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
            className={`nav-settings-link ${isSettingsActive ? 'on' : ''}`}
            aria-current={isSettingsActive ? 'page' : undefined}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
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
        </div>
      </nav>

      <main className="main" id="main">
        {renderMain()}
      </main>

      <footer className="statusbar" id="statusbar">
        <span>计量基准 mm / m² · 排料试算零扣库 · 实切报工与复检独立记账</span>
        <span className="sp" />
        <span>独立几何防碰撞核验 · 支持 CAD DXF / CNC G-Code / Excel 导出</span>
      </footer>
    </div>
  );
};
