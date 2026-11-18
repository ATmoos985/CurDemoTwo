import React, { useEffect, useState } from 'react';
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
  rawKey: string;
}

function parseHashRoute(hash: string): ParsedRoute {
  const clean = String(hash || '').replace(/^#\/?/, '');
  const [rawPath = '', query = ''] = clean.split('?');
  const [pageRaw = 'workbench', ...rest] = rawPath.split('/').filter(Boolean);
  const params = rest.map(decodeURIComponent);
  const intent = new URLSearchParams(query).get('intent');
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
  return { page, params, rawKey: clean || 'workbench' };
}

const WORKFLOW_STAGES: { id: string; step: string; label: string; href: string; pages: string[] }[] = [
  {
    id: 'demand',
    step: '01',
    label: '需求与纸样簇',
    href: '#/clusters',
    pages: ['clusters']
  },
  {
    id: 'solve',
    step: '02',
    label: '智能排料 / 分切',
    href: '#/workbench',
    pages: ['workbench', 'slitting', 'garment', 'showcase']
  },
  {
    id: 'execute',
    step: '03',
    label: '任务下达与报工',
    href: '#/execution',
    pages: ['tasks', 'task', 'execution', 'quality']
  },
  {
    id: 'ledger',
    step: '04',
    label: '余料台账与对账',
    href: '#/inventory',
    pages: ['inventory', 'inspection', 'documents', 'analysis']
  }
];

export const App: React.FC = () => {
  const [route, setRoute] = useState<ParsedRoute>(() => {
    if (!location.hash || location.hash === '#/' || location.hash === '#') {
      return { page: 'workbench', params: [], rawKey: 'workbench' };
    }
    return parseHashRoute(location.hash);
  });
  const [health, setHealth] = useState<{ ok: boolean; workers?: number; engineCount?: number }>({
    ok: false
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

  const navLink = (
    key: string,
    label: string,
    badge?: string | number,
    matches: string[] = [key]
  ) => {
    const active = matches.includes(route.page);
    return (
      <a
        key={key}
        href={`#/${key}`}
        className={active ? 'on' : undefined}
        aria-current={active ? 'page' : undefined}
      >
        <span>{label}</span>
        {badge !== undefined && badge !== '' && <span className="cnt num">{badge}</span>}
      </a>
    );
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
        return <ShowcasePage params={route.params} />;
      default:
        return <NestingStudio2DPage />;
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/workbench">
          <i aria-hidden="true" />
          <span>CutPlan 智能排料与裁切协同系统</span>
        </a>

        <div className="topbar-flow" aria-label="核心业务闭环">
          {WORKFLOW_STAGES.map((stage, idx) => {
            const isCurrent = stage.pages.includes(route.page);
            return (
              <React.Fragment key={stage.id}>
                {idx > 0 && <span className="topbar-flow-sep" aria-hidden="true">›</span>}
                <a
                  href={stage.href}
                  className={`topbar-flow-step ${isCurrent ? 'active' : ''}`}
                >
                  <em className="num">{stage.step}</em>
                  <span>{stage.label}</span>
                </a>
              </React.Fragment>
            );
          })}
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
          <h6>智能排料设计</h6>
          {navLink('workbench', '二维异形排料', schemes2D.length || undefined)}
          {navLink('slitting', '一维定长分切', slitSchemes.length || undefined)}
          {navLink('garment', '多门幅工艺对比')}
          {navLink('clusters', '需求与纸样簇', clusters.length)}

          <h6>生产执行与库存</h6>
          {navLink('tasks', '生产任务队列', undefined, ['tasks', 'task'])}
          {navLink('execution', '执行与报工', undefined, ['execution', 'quality'])}
          {navLink('inventory', '母卷与余料库存', undefined, ['inventory', 'inspection', 'documents'])}
          {navLink('analysis', '产出与用料对账')}
        </div>
        <div className="nav-foot">
          <h6>算例与设置</h6>
          {navLink('showcase', '行业算例演示')}
          {navLink('settings', '系统与引擎设置')}
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
