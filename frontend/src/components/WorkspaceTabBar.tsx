import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceTabItem } from '../utils/workspaceTabs';

export interface WorkspaceTabBarProps {
  tabs: WorkspaceTabItem[];
  activeTabId: string;
  navCollapsed: boolean;
  onToggleNavCollapsed: () => void;
  onSelectTab: (tab: WorkspaceTabItem) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOthers: (keepId: string) => void;
  onCloseAll: () => void;
  renderIcon: (tabId: string) => React.ReactNode;
}

export const WorkspaceTabBar: React.FC<WorkspaceTabBarProps> = ({
  tabs,
  activeTabId,
  navCollapsed,
  onToggleNavCollapsed,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  renderIcon
}) => {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const closableCount = tabs.filter((t) => !t.pinned).length;

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const activeEl = strip.querySelector<HTMLElement>('.mp-tab-item.is-active');
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
    }
  };

  return (
    <div className="mp-tabs-region">
      <button
        type="button"
        className="mp-topbar-nav-toggle"
        onClick={onToggleNavCollapsed}
        aria-expanded={!navCollapsed}
        aria-controls="nav"
        title={navCollapsed ? '展开左侧功能导航' : '收起左侧功能导航（扩大工作区）'}
        aria-label={navCollapsed ? '展开左侧功能导航' : '收起左侧功能导航'}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1.6" />
          <path d="M5.8 2.5v11" />
          {navCollapsed ? <path d="m8.2 6.2 1.8 1.8-1.8 1.8" /> : <path d="m10 6.2-1.8 1.8L10 9.8" />}
        </svg>
      </button>

      <div
        ref={stripRef}
        className="mp-tabs-strip"
        role="tablist"
        aria-label="已打开工作页签"
        onWheel={handleWheel}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="presentation"
              className={`mp-tab-item ${isActive ? 'is-active' : ''} ${tab.pinned ? 'is-pinned' : ''}`}
              onAuxClick={(e) => {
                if (e.button === 1 && !tab.pinned) {
                  e.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
            >
              <a
                href={tab.href}
                role="tab"
                aria-selected={isActive}
                className="mp-tab-link"
                title={tab.pinned ? `${tab.label}（常驻固定页签）` : `${tab.label}（中键或点 × 关闭）`}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                    e.preventDefault();
                    onSelectTab(tab);
                  }
                }}
              >
                <span className="mp-tab-ico" aria-hidden="true">
                  {renderIcon(tab.id)}
                </span>
                <span className="mp-tab-label">{tab.label}</span>
              </a>

              {!tab.pinned && (
                <button
                  type="button"
                  className="mp-tab-close"
                  aria-label={`关闭 ${tab.label} 页签`}
                  title={`关闭 ${tab.label}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                    <path d="M3 3l6 6M9 3 3 9" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mp-tabs-more-wrap" ref={moreWrapRef}>
        <button
          type="button"
          className={`mp-tabs-more-btn ${moreOpen ? 'is-open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label="页签与视图操作"
          title="页签管理与导航收折"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="12.5" cy="8" r="1.2" />
          </svg>
        </button>

        {moreOpen && (
          <div className="mp-tabs-more-menu" role="menu" aria-label="页签管理操作">
            <button
              type="button"
              role="menuitem"
              className="mp-menu-item"
              disabled={closableCount === 0}
              onClick={() => {
                setMoreOpen(false);
                onCloseOthers(activeTabId);
              }}
            >
              <span>关闭其他页签</span>
              <span className="mp-menu-hint num">{closableCount}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="mp-menu-item"
              disabled={closableCount === 0}
              onClick={() => {
                setMoreOpen(false);
                onCloseAll();
              }}
            >
              <span>关闭全部非固定页签</span>
            </button>
            <div className="mp-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="mp-menu-item"
              onClick={() => {
                setMoreOpen(false);
                onToggleNavCollapsed();
              }}
            >
              <span>{navCollapsed ? '展开左侧菜单' : '收起左侧菜单'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
