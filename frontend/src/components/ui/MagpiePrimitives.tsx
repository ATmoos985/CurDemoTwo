import React from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  title?: string;
  accent?: 'default' | 'indigo' | 'emerald' | 'amber';
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  fullWidth = false,
  className = ''
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`mp-seg mp-seg-${size} ${fullWidth ? 'mp-seg-full' : ''} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`mp-seg-btn ${active ? 'on' : ''}`}
            aria-pressed={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && (
              <span className={`mp-seg-count num ${opt.accent ? `accent-${opt.accent}` : ''}`}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export const CodeBadge: React.FC<{
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ children, className = '', title }) => (
  <span className={`mp-code-badge num ${className}`.trim()} title={title}>
    {children}
  </span>
);
