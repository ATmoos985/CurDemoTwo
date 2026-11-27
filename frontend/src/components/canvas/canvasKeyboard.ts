import type { MutableRefObject } from 'react';
import { mapArrowKeyToRollDelta } from './canvasGeometry';
import type { BoardCanvasLiveProps } from './canvasKonvaHelpers';

export function attachWorkbenchKeyboard(
  propsRef: MutableRefObject<BoardCanvasLiveProps>
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const p = propsRef.current;
    if (!p.interactivePieces) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    const lowerKey = e.key.toLowerCase();

    if (mod && !e.altKey) {
      if (lowerKey === 'z' && !e.shiftKey) {
        e.preventDefault();
        p.onUndo?.();
        return;
      }
      if (lowerKey === 'y' || (lowerKey === 'z' && e.shiftKey)) {
        e.preventDefault();
        p.onRedo?.();
        return;
      }
    }

    const selIdx = p.selectedPieceIndex;
    if (selIdx == null) {
      if (e.key === 'Escape') {
        p.onSelectLeftover?.(null);
      }
      return;
    }

    if (
      !mod &&
      !e.altKey &&
      (e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown')
    ) {
      e.preventDefault();
      const stepMm = e.shiftKey ? 0.1 : 1;
      const { dx, dy } = mapArrowKeyToRollDelta(e.key, stepMm, p.vertical);
      p.onNudgePlacedPiece?.(selIdx, dx, dy);
      return;
    }

    if ((e.key === 'r' || e.key === 'R') && !mod && !e.altKey) {
      e.preventDefault();
      p.onRotatePlacedPiece?.(selIdx);
    } else if (e.key === 'Escape') {
      p.onSelectPiece?.(null);
      p.onSelectLeftover?.(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
      e.preventDefault();
      p.onRemovePlacedPiece?.(selIdx);
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
