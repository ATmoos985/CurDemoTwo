import React from 'react';
import {
  DEFAULT_STUDIO_SETTINGS,
  SettingsTabId,
  StartCornerType,
  StudioSettings
} from '../../store/studioSettings';
import { NumberInput } from '../ui/NumberInput';

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTabId;
  onClose: () => void;
  onCapabilitiesLoaded?: (summary: { ok: boolean; workers?: number; engineCount?: number }) => void;
}

export interface TabMeta {
  id: SettingsTabId;
  label: string;
  icon: React.ReactNode;
}

export const TABS: TabMeta[] = [
  {
    id: 'general',
    label: '画布与常规',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <rect
          x="2.2"
          y="2.8"
          width="13.6"
          height="12.4"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M2.2 6.8h13.6M6.8 6.8v8.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    )
  },
  {
    id: 'craft',
    label: '裁切工艺与预设',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <circle cx="5" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="13" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6.9 6.3 15.2 13.5M15.2 4.5 6.9 11.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'remnant',
    label: '料头与余料策略',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <rect
          x="2.5"
          y="2.5"
          width="13"
          height="13"
          rx="1.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M9.5 2.5v7h6M2.5 9.5h7v6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    id: 'engines',
    label: '求解引擎与配额',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <rect
          x="4.5"
          y="4.5"
          width="9"
          height="9"
          rx="1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M7.2 2v2.5M10.8 2v2.5M7.2 13.5V16M10.8 13.5V16M2 7.2h2.5M2 10.8h2.5M13.5 7.2H16M13.5 10.8H16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'integration',
    label: '导出与系统接入',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <path
          d="M6.2 5.5 2.8 9l3.4 3.5M11.8 5.5 15.2 9l-3.4 3.5M10.2 4l-2.4 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
];

export const CORNERS: {
  id: StartCornerType;
  short: string;
  sub: string;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
}[] = [
  { id: 'left-top', short: '左上起刀', sub: 'Left-Top · 标准 CAM', cx: 38, cy: 34, dx: 1, dy: 1 },
  { id: 'right-top', short: '右上起刀', sub: 'Right-Top · 右导轨顺流', cx: 242, cy: 34, dx: -1, dy: 1 },
  {
    id: 'left-bottom',
    short: '左下起刀',
    sub: 'Left-Bottom · 落料口左起',
    cx: 38,
    cy: 146,
    dx: 1,
    dy: -1
  },
  {
    id: 'right-bottom',
    short: '右下起刀',
    sub: 'Right-Bottom · 落料口右起',
    cx: 242,
    cy: 146,
    dx: -1,
    dy: -1
  }
];

const ENGINE_DISPLAY_NAMES: Record<string, string> = {
  crosscut: '通幅横切引擎',
  deepnest: '异形轮廓排料引擎',
  javaguillotine: '二维直刀排料引擎',
  javairregular: '异形快速排料引擎',
  packingsolver: '高精度直刀引擎',
  'packingsolver-irregular': '高精度异形引擎',
  'ortools-1d': '一维分切搭切引擎'
};

const ENGINE_MODE_LABELS: Record<string, string> = {
  CROSSCUT: '横切',
  GUILLOTINE: '直刀',
  CONTOUR: '异形',
  SLITTING: '分切',
  RECTANGLE: '矩形',
  POLYGON: '多边形',
  '1D STRIP': '一维分条'
};

export function formatEngineDisplayName(id: string): string {
  return ENGINE_DISPLAY_NAMES[id] || '内置求解引擎';
}

export function formatEngineModeLabel(mode: string): string {
  return ENGINE_MODE_LABELS[mode] || mode;
}

export function countChangedFields(a: StudioSettings, b: StudioSettings): number {
  let diff = 0;
  (Object.keys(DEFAULT_STUDIO_SETTINGS) as (keyof StudioSettings)[]).forEach((k) => {
    const va = a[k];
    const vb = b[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      const same = va.length === vb.length && va.every((item) => vb.includes(item));
      if (!same) diff += 1;
    } else if (va !== vb) {
      diff += 1;
    }
  });
  return diff;
}

export const StepperNumberInput: React.FC<{
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (next: number) => void;
}> = ({ id, value, min, max, step, unit, onChange }) => {
  const bump = (dir: -1 | 1) => {
    const raw = Number((value + dir * step).toFixed(2));
    onChange(Math.min(max, Math.max(min, raw)));
  };
  return (
    <div className="sc-stepper">
      <button
        type="button"
        className="sc-step-btn"
        aria-label="减小数值"
        disabled={value <= min}
        onClick={() => bump(-1)}
      >
        −
      </button>
      <NumberInput
        id={id}
        min={min}
        max={max}
        step={step}
        className="sc-step-input num"
        value={value}
        onValueChange={onChange}
      />
      <button
        type="button"
        className="sc-step-btn"
        aria-label="增大数值"
        disabled={value >= max}
        onClick={() => bump(1)}
      >
        +
      </button>
      <span className="sc-step-unit num">{unit}</span>
    </div>
  );
};
