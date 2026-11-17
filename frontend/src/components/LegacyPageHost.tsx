import React, { useEffect, useRef } from 'react';

interface LegacyPageHostProps {
  loader: () => Promise<{ mount: (el: HTMLElement, params?: any[]) => any }>;
  params?: string[];
  routeKey: string;
}

export const LegacyPageHost: React.FC<LegacyPageHostProps> = ({ loader, params = [], routeKey }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '<div class="loading">加载中…</div>';

    loader().then((mod) => {
      if (disposed || !host) return;
      host.innerHTML = '';
      const maybeDispose = mod.mount(host, params);
      Promise.resolve(maybeDispose).then((fn) => {
        if (disposed) {
          if (typeof fn === 'function') fn();
        } else if (typeof fn === 'function') {
          cleanup = fn;
        }
      });
    });

    return () => {
      disposed = true;
      try {
        cleanup?.();
      } catch {}
    };
  }, [routeKey]);

  return <div ref={hostRef} className="main page-host" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} />;
};
