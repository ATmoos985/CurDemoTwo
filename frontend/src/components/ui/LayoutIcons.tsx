import React from 'react';

interface IconProps {
  className?: string;
}

/** 收起左侧栏图标：16×16 线性方框 + 左侧细分隔线 + 左向折叠微箭头 */
export const CollapseLeftIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1.75"
      y="2.5"
      width="12.5"
      height="11"
      rx="2.25"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M5.75 2.75v10.5" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M10.75 6.25 8.75 8l2 1.75"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 展开左侧栏图标：16×16 线性方框 + 左侧细分隔线 + 右向展开微箭头 */
export const ExpandLeftIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1.75"
      y="2.5"
      width="12.5"
      height="11"
      rx="2.25"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M5.75 2.75v10.5" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.6 1.6" />
    <path
      d="M8.75 6.25 10.75 8l-2 1.75"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 收起右侧栏图标：16×16 线性方框 + 右侧细分隔线 + 右向折叠微箭头 */
export const CollapseRightIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1.75"
      y="2.5"
      width="12.5"
      height="11"
      rx="2.25"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M10.25 2.75v10.5" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M5.25 6.25 7.25 8l-2 1.75"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 展开右侧栏图标：16×16 线性方框 + 右侧细分隔线 + 左向展开微箭头 */
export const ExpandRightIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1.75"
      y="2.5"
      width="12.5"
      height="11"
      rx="2.25"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M10.25 2.75v10.5" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.6 1.6" />
    <path
      d="M7.25 6.25 5.25 8l2 1.75"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 专注画布 / 恢复面板图标：四角外扩或四角内收极简角标 */
export const FocusCanvasIcon: React.FC<{ active?: boolean; className?: string }> = ({
  active = false,
  className
}) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    aria-hidden="true"
  >
    {active ? (
      <path
        d="M5.75 2.5v3.25H2.5M10.25 2.5v3.25h3.25M5.75 13.5v-3.25H2.5M10.25 13.5v-3.25h3.25"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : (
      <path
        d="M2.5 5.75V2.5h3.25M13.5 5.75V2.5h-3.25M2.5 10.25v3.25h3.25M13.5 10.25v3.25h-3.25"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )}
  </svg>
);

export const ZoomMinusIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 12 12"
    width="12"
    height="12"
    fill="none"
    aria-hidden="true"
  >
    <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
  </svg>
);

export const ZoomPlusIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 12 12"
    width="12"
    height="12"
    fill="none"
    aria-hidden="true"
  >
    <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
  </svg>
);
