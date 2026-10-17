import { parse, type Font, type PathCommand } from "opentype.js";
import regularTtf from "./fonts/DejaVuSansMono.ttf";
import boldTtf from "./fonts/DejaVuSansMono-Bold.ttf";

let fonts: { regular: Font; bold: Font } | null = null;

function loadFonts() {
  if (fonts) return fonts;
  const toBuffer = (bytes: Uint8Array) =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  fonts = {
    regular: parse(toBuffer(regularTtf) as ArrayBuffer),
    bold: parse(toBuffer(boldTtf) as ArrayBuffer),
  };
  return fonts;
}

export interface CellMetrics {
  width: number;
  height: number;
  /** Baseline offset from the top of the cell. */
  baseline: number;
}

/** A glyph's coverage, one byte per pixel, sized to one or two cells. */
export interface GlyphMask {
  width: number;
  height: number;
  alpha: Uint8Array;
}

/**
 * Rasterizes DejaVu Sans Mono glyphs with anti-aliasing, the way guacd's
 * terminal looks, and caches each one.
 */
export class GlyphCache {
  readonly metrics: CellMetrics;
  private readonly cache = new Map<string, GlyphMask>();
  private readonly fontSize: number;

  /** `points` at 96 DPI, like guacd's font-size. */
  constructor(points: number) {
    const { regular } = loadFonts();
    this.fontSize = Math.max(6, (points * 96) / 72);
    const scale = this.fontSize / regular.unitsPerEm;
    const advance =
      regular.charToGlyph("M").advanceWidth ?? regular.unitsPerEm * 0.6;
    const ascent = Math.ceil(regular.ascender * scale);
    const descent = Math.ceil(-regular.descender * scale);
    this.metrics = {
      width: Math.max(1, Math.round(advance * scale)),
      height: Math.max(1, ascent + descent),
      baseline: ascent,
    };
  }

  get(char: string, bold: boolean, cells: number): GlyphMask {
    const key = `${bold ? "b" : "r"}${cells}${char}`;
    let mask = this.cache.get(key);
    if (!mask) {
      mask = this.render(char, bold, cells);
      if (this.cache.size > 4096) this.cache.clear();
      this.cache.set(key, mask);
    }
    return mask;
  }

  private render(char: string, bold: boolean, cells: number): GlyphMask {
    const { regular, bold: boldFont } = loadFonts();
    const font = bold && boldFont.hasChar(char) ? boldFont : regular;
    const width = this.metrics.width * cells;
    const height = this.metrics.height;
    const path = font
      .charToGlyph(char)
      .getPath(0, this.metrics.baseline, this.fontSize);
    return { width, height, alpha: rasterize(path.commands, width, height) };
  }
}

/** Flattens a path to lines and fills it with exact area coverage. */
export function rasterize(
  commands: PathCommand[],
  width: number,
  height: number,
): Uint8Array {
  const acc = new Float32Array(width * height + 4);
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const line = (x1: number, y1: number) => {
    drawLine(acc, width, height, x, y, x1, y1);
    x = x1;
    y = y1;
  };
  for (const c of commands) {
    switch (c.type) {
      case "M":
        x = startX = c.x!;
        y = startY = c.y!;
        break;
      case "L":
        line(c.x!, c.y!);
        break;
      case "Q": {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          const mt = 1 - t;
          line(
            mt * mt * x0 + 2 * mt * t * c.x1! + t * t * c.x!,
            mt * mt * y0 + 2 * mt * t * c.y1! + t * t * c.y!,
          );
        }
        break;
      }
      case "C": {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= 12; i++) {
          const t = i / 12;
          const mt = 1 - t;
          line(
            mt * mt * mt * x0 +
              3 * mt * mt * t * c.x1! +
              3 * mt * t * t * c.x2! +
              t * t * t * c.x!,
            mt * mt * mt * y0 +
              3 * mt * mt * t * c.y1! +
              3 * mt * t * t * c.y2! +
              t * t * t * c.y!,
          );
        }
        break;
      }
      case "Z":
        line(startX, startY);
        break;
    }
  }
  const out = new Uint8Array(width * height);
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    sum += acc[i];
    out[i] = Math.min(255, Math.round(Math.abs(sum) * 255));
  }
  return out;
}

// Signed area accumulation, after font-rs.
function drawLine(
  acc: Float32Array,
  width: number,
  height: number,
  px0: number,
  py0: number,
  px1: number,
  py1: number,
): void {
  if (Math.abs(py0 - py1) < 1e-9) return;
  // Keep x inside the bitmap; coverage left of 0 lands in column 0.
  const clampX = (v: number) => Math.min(Math.max(v, 0), width - 0.001);
  let x0 = clampX(px0);
  let x1 = clampX(px1);
  let y0 = py0;
  let y1 = py1;
  let dir = 1;
  if (y0 > y1) {
    dir = -1;
    [x0, x1] = [x1, x0];
    [y0, y1] = [y1, y0];
  }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) x -= y0 * dxdy;
  const yEnd = Math.min(height, Math.ceil(y1));
  for (let row = Math.max(0, Math.floor(y0)); row < yEnd; row++) {
    const start = row * width;
    const dy = Math.min(row + 1, y1) - Math.max(row, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    const xa = Math.min(x, xnext);
    const xb = Math.max(x, xnext);
    const xaFloor = Math.floor(xa);
    const xai = xaFloor;
    const xbCeil = Math.ceil(xb);
    const xbi = xbCeil;
    const base = start + xai;
    if (xbi <= xai + 1) {
      const xmf = 0.5 * (x + xnext) - xaFloor;
      acc[base] += d - d * xmf;
      acc[base + 1] += d * xmf;
    } else {
      const s = 1 / (xb - xa);
      const xaf = xa - xaFloor;
      const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
      const xbf = xb - xbCeil + 1;
      const am = 0.5 * s * xbf * xbf;
      acc[base] += d * a0;
      if (xbi === xai + 2) {
        acc[base + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - xaf);
        acc[base + 1] += d * (a1 - a0);
        for (let xi = xai + 2; xi < xbi - 1; xi++) acc[start + xi] += d * s;
        const a2 = a1 + (xbi - xai - 3) * s;
        acc[base + (xbi - xai - 1)] += d * (1 - a2 - am);
      }
      acc[base + (xbi - xai)] += d * am;
    }
    x = xnext;
  }
}
