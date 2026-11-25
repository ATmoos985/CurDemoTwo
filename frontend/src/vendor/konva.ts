import KonvaModule from './konva.min.js';

const Konva: any =
  (KonvaModule as any)?.Stage
    ? KonvaModule
    : (KonvaModule as any)?.default?.Stage
      ? (KonvaModule as any).default
      : (globalThis as any).Konva;

if (Konva) {
  (globalThis as any).Konva = Konva;
}

export default Konva;
