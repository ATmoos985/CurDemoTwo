import React, { useEffect, useState } from 'react';
import { ClusterCenterPage } from './pages/ClusterCenterPage';
import { NestingStudio2DPage } from './pages/NestingStudio2DPage';
import { SlittingStudio1DPage } from './pages/SlittingStudio1DPage';
import { ExecutionCenterPage } from './pages/ExecutionCenterPage';
import { SettingsPage } from './pages/SettingsPage';
import { LegacyPageHost } from './components/LegacyPageHost';
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

export const App: React.FC = () => {
  const [route, setRoute] = useState<ParsedRoute>(() => {
    if (!location.hash || location.hash === '#/' || location.hash === '#') {
      return { page: 'workbench', params: [], rawKey: 'workbench' };
    }
    return parseHashRoute(location.hash);
  });
  const [health, setHealth] = useState<{ ok: boolean; workers?: number }>({ ok: false });

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
      setHealth({
        ok: h?.status === 'UP',
        workers: c?.limits?.workers
      });
    });
  }, []);

  const navLink = (key: string, label: string, badge?: string | number, sub = false, matches: string[] = [key]) => {
    const active = matches.includes(route.page);
    return (
      <a
        key={key}
        href={`#/${key}`}
        className={`${active ? 'on' : ''} ${sub ? 'nav-sub' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <span>{label}</span>
        {badge !== undefined && badge !== '' && <span className="cnt">{badge}</span>}
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
        return <ExecutionCenterPage taskId={route.params[0] || undefined} />;
      case 'settings':
        return <SettingsPage />;
      case 'garment':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/garment.js')}
            params={route.params}
          />
        );
      case 'tasks':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/tasks.js')}
            params={route.params}
          />
        );
      case 'task':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/task-edit.js')}
            params={route.params}
          />
        );
      case 'inventory':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/inventory.js')}
            params={route.params}
          />
        );
      case 'inspection':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/inspection.js')}
            params={route.params}
          />
        );
      case 'documents':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/documents.js')}
            params={route.params}
          />
        );
      case 'quality':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/quality.js')}
            params={route.params}
          />
        );
      case 'analysis':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/analysis.js')}
            params={route.params}
          />
        );
      case 'showcase':
        return (
          <LegacyPageHost
            routeKey={route.rawKey}
            loader={() => import('@static/app/js/pages/showcase.js')}
            params={route.params}
          />
        );
      default:
        return <NestingStudio2DPage />;
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/workbench">
          <i />
          搭切 CutPlan · React CAD/CAM 工作台
        </a>
        <span className="topbar-sp" />
        <div className="topbar-meta">
          <span id="engine-status">
            <span className={`dot ${health.ok ? 'ok' : 'warn'}`} />
            服务 <b>{health.ok ? '正常' : '检测中'}</b>
            {health.workers ? ` · ${health.workers}线程求解` : ''}
          </span>
          <a href="#/clusters">纸样簇 ({clusters.length})</a>
          <a href="#/showcase">演示沙盒</a>
          <a href="#/settings">并发设置</a>
          <a href="/workspace.html" title="打开传统多页工作台">
            经典版本 ↗
          </a>
        </div>
      </header>

      <nav className="nav" id="nav" aria-label="功能导航">
        <div className="nav-main">
          <h6>搭切核心区</h6>
          {navLink('workbench', '二维搭切画布', schemes2D.length || undefined)}
          {navLink('slitting', '一维分切组合', slitSchemes.length || undefined)}
          {navLink('clusters', '需求与纸样簇', clusters.length)}
          {navLink('garment', '多门幅工艺对比')}

          <h6>报工与材料 (解耦)</h6>
          {navLink('execution', '方案报工中心', undefined, false, ['execution', 'quality'])}
          {navLink('tasks', '生产任务单据', undefined, true, ['tasks', 'task'])}
          {navLink('inventory', '实物库存台账', undefined, false, ['inventory', 'inspection', 'documents', 'analysis'])}
          {navLink('inspection', '跑布验疵定位', undefined, true)}
          {navLink('analysis', '库存流水对账', undefined, true)}
        </div>
        <div className="nav-foot">
          <h6>沙盒与系统</h6>
          {navLink('showcase', '算法演示沙盒', 'DEMO')}
          {navLink('settings', '并发池与设置')}
        </div>
      </nav>

      <main className="main" id="main">
        {renderMain()}
      </main>

      <footer className="statusbar" id="statusbar">
        <span>React 19 + Vite + Zustand 工作台架构</span>
        <span>需求簇管理 · 二维自由画布 · 一维纯分切 · 多线程竞速求解</span>
        <span className="sp" />
        <span>CutPlan Studio v3 (branch: react)</span>
      </footer>
    </div>
  );
};
