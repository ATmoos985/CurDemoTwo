import React, { forwardRef, useEffect, useRef, useState } from 'react';

export interface NumericBounds {
  min?: number;
  max?: number;
  fallback?: number;
  integer?: boolean;
}

export function clampNumericValue(num: number, bounds: Pick<NumericBounds, 'min' | 'max' | 'integer'>): number {
  let out = bounds.integer ? Math.round(num) : num;
  if (bounds.min !== undefined && Number.isFinite(bounds.min)) {
    out = Math.max(bounds.min, out);
  }
  if (bounds.max !== undefined && Number.isFinite(bounds.max)) {
    out = Math.min(bounds.max, out);
  }
  return Object.is(out, -0) ? 0 : out;
}

/**
 * 编辑过程中解析草稿：仅当输入是完整合法数字且落在 [min, max] 范围内时返回数值；
 * 空字符串、中间态或暂未达到下限/超过上限时返回 null，避免打断用户输入。
 */
export function parseLiveNumericDraft(raw: string, bounds: Pick<NumericBounds, 'min' | 'max' | 'integer'>): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  if (bounds.min !== undefined && Number.isFinite(bounds.min) && parsed < bounds.min) return null;
  if (bounds.max !== undefined && Number.isFinite(bounds.max) && parsed > bounds.max) return null;
  const normalized = bounds.integer ? Math.round(parsed) : parsed;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/**
 * 失焦或回车时收敛最终数值：空/非法回落到 fallback（或当前值），并按 [min, max] 钳位。
 */
export function finalizeNumericDraft(raw: string, currentValue: number, bounds: NumericBounds): number {
  const trimmed = raw.trim();
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  if (Number.isFinite(parsed)) {
    return clampNumericValue(parsed, bounds);
  }
  const base =
    bounds.fallback !== undefined && Number.isFinite(bounds.fallback)
      ? bounds.fallback
      : Number.isFinite(currentValue)
        ? currentValue
        : bounds.min !== undefined && Number.isFinite(bounds.min)
          ? bounds.min
          : 0;
  return clampNumericValue(base, bounds);
}

export interface NumberInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max'
  > {
  value: number;
  onValueChange: (next: number) => void;
  min?: number;
  max?: number;
  /** 输入清空或非法后失焦时的回退值；省略时回退为当前外部 value */
  fallback?: number;
  /** 是否取整 */
  integer?: boolean;
}

function formatNum(v: number): string {
  return Number.isFinite(v) ? String(v) : '';
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    value,
    onValueChange,
    min,
    max,
    fallback,
    integer,
    step: _step,
    onFocus,
    onBlur,
    onKeyDown,
    ...rest
  },
  ref
) {
  const [text, setText] = useState<string>(() => formatNum(value));
  const focusedRef = useRef(false);
  const lastCommittedRef = useRef<number>(value);

  useEffect(() => {
    if (!focusedRef.current) {
      lastCommittedRef.current = value;
      setText(formatNum(value));
      return;
    }
    if (value !== lastCommittedRef.current) {
      lastCommittedRef.current = value;
      setText(formatNum(value));
    }
  }, [value]);

  const commit = (raw: string) => {
    const finalized = finalizeNumericDraft(raw, value, { min, max, fallback, integer });
    lastCommittedRef.current = finalized;
    setText(formatNum(finalized));
    if (finalized !== value) {
      onValueChange(finalized);
    }
  };

  return (
    <input
      {...rest}
      ref={ref}
      type="number"
      step="any"
      min={min}
      max={max}
      value={text}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const live = parseLiveNumericDraft(raw, { min, max, integer });
        if (live !== null) {
          lastCommittedRef.current = live;
          if (live !== value) {
            onValueChange(live);
          }
        }
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        commit(e.currentTarget.value);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(e.currentTarget.value);
        }
        onKeyDown?.(e);
      }}
    />
  );
});
