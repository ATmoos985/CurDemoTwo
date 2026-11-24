import React, { useEffect, useRef } from 'react';
import {
  BoardContextMenuEvent,
  BoardLeftover,
  BoardPlacedPiece
} from '../../components/WorkbenchBoardCanvas';
import { computeContextMenuPosition } from '../../components/canvas/canvasGeometry';

export interface WorkbenchContextMenuProps {
  menu: BoardContextMenuEvent | null;
  piece: BoardPlacedPiece | null;
  leftover: BoardLeftover | null;
  canUndo: boolean;
  canRedo: boolean;
  canRestoreOriginal: boolean;
  showDimensions: boolean;
  showPath: boolean;
  onClose: () => void;
  onRotatePiece: (pieceIndex: number) => void;
  onFocusPiece: (piece: BoardPlacedPiece) => void;
  onRemovePiece: (pieceIndex: number) => void;
  onDiscardLeftover: (leftoverId: string) => void;
  onFocusLeftover: (leftover: BoardLeftover) => void;
  onUndo: () => void;
  onRedo: () => void;
  onRestoreOriginal: () => void;
  onFitView: () => void;
  onResetRollOffset: () => void;
  onToggleDimensions: () => void;
  onTogglePath: () => void;
}

export const WorkbenchContextMenu: React.FC<WorkbenchContextMenuProps> = ({
  menu,
  piece,
  leftover,
  canUndo,
  canRedo,
  canRestoreOriginal,
  showDimensions,
  showPath,
  onClose,
  onRotatePiece,
  onFocusPiece,
  onRemovePiece,
  onDiscardLeftover,
  onFocusLeftover,
  onUndo,
  onRedo,
  onRestoreOriginal,
  onFitView,
  onResetRollOffset,
  onToggleDimensions,
  onTogglePath
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const estW = 204;
  const estH = menu.kind === 'piece' ? 248 : menu.kind === 'leftover' ? 210 : 228;
  const pos = computeContextMenuPosition(
    menu.clientX,
    menu.clientY,
    estW,
    estH,
    typeof window !== 'undefined' ? window.innerWidth : 1280,
    typeof window !== 'undefined' ? window.innerHeight : 800
  );

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="画布快捷操作菜单"
      className="wb-context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === 'piece' && piece && (
        <>
          <div className="wb-ctx-header">
            <strong>{piece.name}</strong>
            <span className="num">
              {Math.round(piece.width)}×{Math.round(piece.height)} mm
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => onRotatePiece(piece.index))}
          >
            <span>旋转裁片</span>
            <kbd>R</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => onFocusPiece(piece))}>
            <span>居中定位此裁片</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => run(() => onRemovePiece(piece.index))}
          >
            <span>单件移除（退回待排）</span>
            <kbd>Del</kbd>
          </button>
          <div className="wb-ctx-sep" role="separator" />
        </>
      )}

      {menu.kind === 'leftover' && leftover && (
        <>
          <div className="wb-ctx-header">
            <strong>计划余料 #{leftover.id}</strong>
            <span className="num">
              {Math.round(leftover.width)}×{Math.round(leftover.height)} mm ·{' '}
              {((leftover.width * leftover.height) / 1_000_000).toFixed(2)} m²
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => onFocusLeftover(leftover))}
          >
            <span>居中定位余料</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => run(() => onDiscardLeftover(leftover.id))}
          >
            <span>从预览抛弃余料</span>
          </button>
          <div className="wb-ctx-sep" role="separator" />
        </>
      )}

      {menu.kind === 'empty' && (
        <>
          <div className="wb-ctx-header">
            <strong>画布视图</strong>
            <span className="num">
              X {menu.localX} / Y {menu.localY} mm
            </span>
          </div>
          <button type="button" role="menuitem" onClick={() => run(onFitView)}>
            <span>居中适配整卷</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onResetRollOffset)}>
            <span>重置母卷位置</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onToggleDimensions)}>
            <span>{showDimensions ? '隐藏尺寸标尺' : '显示尺寸标尺'}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onTogglePath)}>
            <span>{showPath ? '隐藏切割刀路' : '显示切割刀路'}</span>
          </button>
          <div className="wb-ctx-sep" role="separator" />
        </>
      )}

      <button type="button" role="menuitem" disabled={!canUndo} onClick={() => run(onUndo)}>
        <span>撤销手调</span>
        <kbd>Ctrl+Z</kbd>
      </button>
      <button type="button" role="menuitem" disabled={!canRedo} onClick={() => run(onRedo)}>
        <span>重做手调</span>
        <kbd>Ctrl+Y</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canRestoreOriginal}
        onClick={() => run(onRestoreOriginal)}
      >
        <span>恢复原预览</span>
      </button>
    </div>
  );
};
