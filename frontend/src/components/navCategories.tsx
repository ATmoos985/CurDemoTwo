import React from 'react';
import { AuthSession } from '../utils/authClient';
import { ParsedRoute } from '../utils/routeUtils';
import { canAccessAdminSecurity } from '../utils/securityApi';

export interface NavSubItem {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: number;
  isActive: (r: ParsedRoute) => boolean;
}

export interface NavCategory {
  id: string;
  label: string;
  items: NavSubItem[];
}

export function buildNavCategories(params: {
  candidateCount: number;
  clusterCount: number;
  auth: AuthSession;
}): NavCategory[] {
  const { candidateCount, clusterCount, auth } = params;
  const adminVisible = canAccessAdminSecurity(auth);

  return [
    {
      id: 'demand',
      label: '订单需求',
      items: [
        {
          id: 'demands',
          label: '新建订单',
          href: '#/demands',
          icon: (
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.6 2.5 3 4.2l1.2 2.1 1.4-.7v4.5h4.8V5.6l1.4.7L13 4.2l-2.6-1.7a2.4 2.4 0 0 1-4.8 0Z" />
              <path d="M2.6 13h10.8M4.2 11.6 2.6 13l1.6 1.4M11.8 11.6 13.4 13l-1.6 1.4" />
            </svg>
          ),
          isActive: (r) => r.page === 'garment'
        }
      ]
    },
    {
      id: 'security',
      label: '系统安全',
      items: [
        {
          id: 'profile',
          label: '个人中心',
          href: '#/profile',
          icon: (
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="5.5" r="2.5" />
              <path d="M3.2 13.4c.7-2.2 2.5-3.4 4.8-3.4s4.1 1.2 4.8 3.4" />
            </svg>
          ),
          isActive: (r) => r.page === 'profile'
        },
        ...(adminVisible
          ? [
              {
                id: 'users',
                label: '用户与 Agent',
                href: '#/users',
                icon: (
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 2.1 13 4v3.8c0 3-2 5-5 6.1-3-1.1-5-3.1-5-6.1V4l5-1.9Z" />
                    <circle cx="8" cy="7.2" r="1.4" />
                  </svg>
                ),
                isActive: (r: ParsedRoute) => r.page === 'users'
              },
              {
                id: 'audit-logs',
                label: '操作审计',
                href: '#/audit-logs',
                icon: (
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2.6" y="2.4" width="10.8" height="11.2" rx="1.4" />
                    <path d="M5.2 5.8h5.6M5.2 8.4h5.6M5.2 11h3.6" />
                  </svg>
                ),
                isActive: (r: ParsedRoute) => r.page === 'audit-logs'
              }
            ]
          : [])
      ]
    }
  ];
}
