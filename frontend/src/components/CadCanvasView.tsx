import React, { useEffect, useRef } from 'react';
import { createRollCanvas } from '@static/js/canvas/roll-canvas.js';

interface CadCanvasViewProps {
  scene: any;
  vertical?: boolean;
  showPath?: boolean;
  showDimensions?: boolean;
  tool?: 'pan' | 'measure' | 'defect' | 'move';
  onCursorMove?: (cursor: { u: number; v: number } | null) => void;
  onSelectPiece?: (pieceId: any) => void;
  onContextInspect?: (hit: any) => void;
  canvasRefOut?: React.MutableRefObject<any>;
}

export const CadCanvasView: React.FC<CadCanvasViewProps> = ({
  scene,
  vertical = true,
  showPath = false,
  showDimensions = true,
  tool = 'pan',
  onCursorMove,
  onSelectPiece,
  onContextInspect,
  canvasRefOut
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<any>(null);
  const lastSceneIdRef = useRef<string>('');
  const callbacksRef = useRef({ onCursorMove, onSelectPiece, onContextInspect });
  callbacksRef.current = { onCursorMove, onSelectPiece, onContextInspect };

  useEffect(() => {
    if (!hostRef.current) return;
    const canvas = createRollCanvas(hostRef.current, {
      onCursor: (pt: any) => callbacksRef.current.onCursorMove?.(pt),
      onPieceSelect: (id: any) => callbacksRef.current.onSelectPiece?.(id),
      onContextMenu: (hit: any) => callbacksRef.current.onContextInspect?.(hit)
    });
    canvas.setOptions({ vertical, showPath, showDimensions, tool, view: 'station' });
    instanceRef.current = canvas;
    if (canvasRefOut) canvasRefOut.current = canvas;
    if (scene) {
      canvas.setScene(scene, { refit: true });
      lastSceneIdRef.current = `${scene.roll?.width}x${scene.roll?.total}-${scene.segments?.[0]?.pieces?.length || 0}-${scene.segments?.[0]?.id}`;
    }
    return () => {
      canvas.destroy();
      instanceRef.current = null;
      if (canvasRefOut) canvasRefOut.current = null;
    };
  }, []);

  useEffect(() => {
    if (!instanceRef.current || !scene) return;
    const sig = `${scene.roll?.width}x${scene.roll?.total}-${scene.segments?.[0]?.pieces?.length || 0}-${scene.segments?.[0]?.id}`;
    const shouldRefit = sig !== lastSceneIdRef.current;
    lastSceneIdRef.current = sig;
    instanceRef.current.setScene(scene, { refit: shouldRefit });
  }, [scene]);

  useEffect(() => {
    if (!instanceRef.current) return;
    instanceRef.current.setOptions({ vertical, showPath, showDimensions, tool, view: 'station' });
  }, [vertical, showPath, showDimensions, tool]);

  return (
    <div
      ref={hostRef}
      className="react-cad-host"
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: '420px', background: '#171c24' }}
      tabIndex={0}
      aria-label="二维排料 CAD 画布"
    />
  );
};
