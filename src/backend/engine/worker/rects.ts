export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.w &&
    b.x - margin < a.x + a.w &&
    a.y - margin < b.y + b.h &&
    b.y - margin < a.y + a.h
  );
}

export function clip(r: Rect, width: number, height: number): Rect | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const w = Math.min(width, r.x + r.w) - x;
  const h = Math.min(height, r.y + r.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

const area = (r: Rect) => r.w * r.h;

/**
 * Changed regions of one frame. Close or overlapping rects merge when the
 * merged rect wastes little area, since one image costs less than many tiny
 * ones; far apart updates stay separate.
 */
export class DirtyRegion {
  private rects: Rect[] = [];

  constructor(private readonly maxRects = 48) {}

  add(r: Rect): void {
    if (r.w <= 0 || r.h <= 0) return;
    let current = r;
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < this.rects.length; i++) {
        const other = this.rects[i];
        if (!intersects(current, other, 16)) continue;
        const joined = union(current, other);
        if (
          intersects(current, other) ||
          area(joined) <= (area(current) + area(other)) * 1.3
        ) {
          this.rects.splice(i, 1);
          current = joined;
          merged = true;
          break;
        }
      }
    }
    this.rects.push(current);
    if (this.rects.length > this.maxRects) {
      this.rects = [this.rects.reduce(union)];
    }
  }

  get empty(): boolean {
    return this.rects.length === 0;
  }

  intersects(r: Rect): boolean {
    return this.rects.some((other) => intersects(r, other));
  }

  take(): Rect[] {
    const out = this.rects;
    this.rects = [];
    return out;
  }
}
