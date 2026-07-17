/**
 * Minimal ambient types for gifenc (mattdesl) — the package ships no .d.ts.
 * Covers only the surface recording.ts uses.
 */
declare module 'gifenc' {
  export interface GifEncoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        delay?: number;
        repeat?: number;
        [key: string]: unknown;
      }
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }
  export function GIFEncoder(opts?: Record<string, unknown>): GifEncoder;
  export function quantize(
    rgba: Uint8Array,
    maxColors: number,
    opts?: { format?: string; [key: string]: unknown }
  ): number[][];
  export function applyPalette(rgba: Uint8Array, palette: number[][], format?: string): Uint8Array;
}
