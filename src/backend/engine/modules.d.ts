declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "*.ttf" {
  const bytes: Uint8Array;
  export default bytes;
}

// The parts of opentype.js the terminal renderer uses.
declare module "opentype.js" {
  export interface PathCommand {
    type: "M" | "L" | "Q" | "C" | "Z";
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
    getPath(
      x: number,
      y: number,
      fontSize: number,
    ): { commands: PathCommand[] };
  }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    charToGlyph(char: string): Glyph;
    hasChar(char: string): boolean;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
