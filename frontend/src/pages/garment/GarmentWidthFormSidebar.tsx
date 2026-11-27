import React from 'react';
import { NumberInput } from '../../components/ui/NumberInput';
import { GARMENT_TRIAL_STYLES } from '../../lib/nesting/marker-demo.js';
import { EXAMPLES, GarmentExample, QUICK_PILL_STYLES } from './garmentWidthUtils';

interface GarmentWidthFormSidebarProps {
  helpRef: React.MutableRefObject<HTMLDetailsElement | null>;
  sizeInputRefs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  inputWidthsRef: React.MutableRefObject<HTMLInputElement | null>;
  styleId: string;
  currentExampleId: string;
  isBusy: boolean;
  halfTurn: boolean;
  gapFill: boolean;
  orderedSizes: string[];
  sizeCounts: Record<string, number>;
  widthsText: string;
  edgeMm: number;
  gsmText: string;
  isDxfStyleActive: boolean;
  onPillClick: (pillStyleId: string) => void;
  onToggleHalfTurn: (checked: boolean) => void;
  onToggleGapFill: (checked: boolean) => void;
  onSelectExample: (ex: GarmentExample) => void;
  onChangeStyle: (nextStyle: string) => void;
  onChangeSizeCount: (size: string, val: number) => void;
  onChangeWidthsText: (val: string) => void;
  onChangeEdgeMm: (val: number) => void;
  onChangeGsmText: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const GarmentWidthFormSidebar: React.FC<GarmentWidthFormSidebarProps> = ({
  helpRef,
  sizeInputRefs,
  inputWidthsRef,
  styleId,
  currentExampleId,
  isBusy,
  halfTurn,
  gapFill,
  orderedSizes,
  sizeCounts,
  widthsText,
  edgeMm,
  gsmText,
  isDxfStyleActive,
  onPillClick,
  onToggleHalfTurn,
  onToggleGapFill,
  onSelectExample,
  onChangeStyle,
  onChangeSizeCount,
  onChangeWidthsText,
  onChangeEdgeMm,
  onChangeGsmText,
  onSubmit
}) => {
  return (
    <section className="pane mp-float-card mp-garment-left">
      <div className="pane-b">
        <details
          id="garment-help"
          ref={helpRef}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && helpRef.current?.open) {
              e.preventDefault();
              helpRef.current.open = false;
              helpRef.current.querySelector('summary')?.focus();
            }
          }}
        >
          <summary className="pane-h" role="button" aria-label="试算条件帮助">
            试算条件
            <span className="help-mark" aria-hidden="true">
              ?
            </span>
          </summary>
          <div className="garment-help-text">
            <p id="angle-help">
              面料允许倒顺排时，可勾选旋转，比较同幅宽下两种方向的利用率。
            </p>
            <p id="fill-help">
              同款裁片补空在齐套唛架内加排备片，每个已选尺码最多备两件成衣所需的裁片。含补片利用率计入实补面积，每件单耗仍按原配码计算。
            </p>
            <p>
              <a
                href="./examples/garment-shirt-gap-fill.png"
                target="_blank"
                rel="noopener"
              >
                查看 1950 mm 上衣补片前后对照图
              </a>
            </p>
            <p id="width-help">
              每版合计 1–12 件。有效幅宽可填 1–8 个值，范围 1200–2000
              mm，用逗号或空格分隔。
            </p>
            <p id="weight-help">
              每件用布重量按含布边的幅宽、实际唛架长度和克重估算，未计布头、布尾及备损。
            </p>
          </div>
        </details>

        <div
          className="style-pills mp-style-pills"
          id="garment-style-pills"
          aria-label="快捷样板选择"
        >
          {QUICK_PILL_STYLES.map((s: any) => (
            <button
              key={s.id}
              type="button"
              className={`style-pill ${styleId === s.id ? 'on' : ''}`}
              data-style-pill={s.id}
              disabled={isBusy}
              onClick={() => onPillClick(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>

        <form
          id="garment-form"
          className="form mp-garment-form"
          onSubmit={onSubmit}
        >
          <label htmlFor="garment-half-turn">允许 180° 旋转</label>
          <input
            id="garment-half-turn"
            name="halfTurn"
            type="checkbox"
            className="ux-switch"
            aria-describedby="angle-help"
            disabled={isBusy}
            checked={halfTurn}
            onChange={(e) => onToggleHalfTurn(e.target.checked)}
          />
          <label htmlFor="garment-gap-fill">同款裁片补空</label>
          <input
            id="garment-gap-fill"
            name="gapFill"
            type="checkbox"
            className="ux-switch"
            aria-describedby="fill-help"
            disabled={isBusy}
            checked={gapFill}
            onChange={(e) => onToggleGapFill(e.target.checked)}
          />
          <label htmlFor="garment-example">试算示例</label>
          <select
            className="field"
            id="garment-example"
            name="example"
            disabled={isBusy}
            value={currentExampleId}
            onChange={(e) => {
              const ex = EXAMPLES.find((item) => item.id === e.target.value);
              if (ex) onSelectExample(ex);
            }}
          >
            <option value="" disabled>
              自定义参数
            </option>
            {EXAMPLES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <label htmlFor="garment-style">内置样板</label>
          <select
            className="field"
            id="garment-style"
            name="style"
            disabled={isBusy}
            value={styleId}
            onChange={(e) => onChangeStyle(e.target.value)}
          >
            {GARMENT_TRIAL_STYLES.map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <div id="garment-sizes">
            {orderedSizes.map((size) => {
              const inputId = `garment-${size.toLowerCase()}`;
              return (
                <React.Fragment key={size}>
                  <label htmlFor={inputId}>{size} 码（件/版）</label>
                  <NumberInput
                    ref={(el) => {
                      sizeInputRefs.current[size] = el;
                    }}
                    className="field"
                    id={inputId}
                    name={size}
                    min={0}
                    max={12}
                    fallback={0}
                    integer
                    required
                    disabled={isBusy}
                    value={sizeCounts[size] ?? 0}
                    onValueChange={(v) => onChangeSizeCount(size, v)}
                  />
                </React.Fragment>
              );
            })}
          </div>

          <label htmlFor="garment-widths">有效幅宽（mm）</label>
          <input
            ref={inputWidthsRef}
            className="field"
            id="garment-widths"
            name="widths"
            aria-describedby="width-help"
            required
            disabled={isBusy}
            value={widthsText}
            onChange={(e) => onChangeWidthsText(e.target.value)}
          />
          <label htmlFor="garment-edge">两侧布边合计（mm）</label>
          <NumberInput
            className="field"
            id="garment-edge"
            name="edge"
            min={0}
            step="0.1"
            fallback={0}
            required
            disabled={isBusy}
            value={edgeMm}
            onValueChange={onChangeEdgeMm}
          />
          <label htmlFor="garment-gsm">克重（g/m²）</label>
          <input
            className="field"
            id="garment-gsm"
            name="gsm"
            type="number"
            min="0.1"
            step="any"
            aria-describedby="weight-help"
            required={!isDxfStyleActive}
            placeholder={isDxfStyleActive ? '选填（留空不计克重）' : undefined}
            disabled={isBusy}
            value={gsmText}
            onChange={(e) => onChangeGsmText(e.target.value)}
          />
        </form>
      </div>
    </section>
  );
};
