import React, { useEffect, useId, useRef } from 'react';

declare module 'react' {
  interface DialogHTMLAttributes<T> extends HTMLAttributes<T> {
    closedby?: 'any' | 'closerequest' | 'none';
  }
  interface HTMLAttributes<T> {
    focusgroup?: string;
  }
}

export interface ModalDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  maxWidth?: number;
  children: React.ReactNode;
}

/**
 * Native modal <dialog> following Google Chrome Modern Web Guidance:
 * - Opens via showModal() for top-layer rendering, inert background, focus containment, and Esc dismissal
 * - Uses declarative closedby="any" with pointer-coordinate fallback where closedBy is unsupported
 * - Resets dialog.returnValue on close so stale return values never leak
 */
export const ModalDialog: React.FC<ModalDialogProps> = ({
  open,
  title,
  onClose,
  maxWidth = 640,
  children
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      onCloseRef.current();
    };
    dialog.addEventListener('close', handleClose);

    // Fallback for browsers without native HTMLDialogElement.prototype.closedBy support
    let cleanupFallback: (() => void) | undefined;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent) => {
        const rect = dialog.getBoundingClientRect();
        return (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        );
      };
      const onPointerDown = (e: PointerEvent) => {
        if (e.target !== dialog) {
          pressedOutside = false;
          return;
        }
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e: PointerEvent) => {
        if (e.target === dialog && pressedOutside && isOutside(e)) {
          dialog.close();
        }
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      cleanupFallback = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      cleanupFallback?.();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby={titleId}
      className="native-modal-dialog"
      style={{ ['--modal-max-w' as string]: `${maxWidth}px` } as React.CSSProperties}
    >
      <div className="native-modal-head">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="btn sm"
          aria-label="关闭对话框"
          onClick={() => dialogRef.current?.close()}
        >
          关闭
        </button>
      </div>
      <div className="native-modal-body">{children}</div>
    </dialog>
  );
};
