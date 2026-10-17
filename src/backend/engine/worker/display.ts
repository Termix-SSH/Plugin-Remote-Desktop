import { encode } from "../protocol.js";
import type { Output } from "./output.js";
import { DirtyRegion, clip, type Rect } from "./rects.js";
import { ARROW, BLANK, DOT, type CursorImage } from "./cursor.js";

/** Where pixels come from: the RDP framebuffer or a Surface. */
export interface PixelSource {
  readonly width: number;
  readonly height: number;
  png(x: number, y: number, w: number, h: number): Uint8Array;
  jpeg(x: number, y: number, w: number, h: number, quality: number): Uint8Array;
}

export interface DisplayOptions {
  rgbaPng: (rgba: Uint8Array, width: number, height: number) => Uint8Array;
  now?: () => number;
}

// GUAC_COMP_OVER and GUAC_COMP_SRC channel masks.
const OVER = 0xe;
const SRC = 0xc;
const CELL = 64;
const FRAME_MS = 16;
const MAX_OUTSTANDING = 3;
const STALLED_MS = 4000;
const LOSSY_MIN_AREA = 128 * 128;
const LOSSY_RATE = 4;

interface UserSync {
  lastAck: number;
  outstanding: number[];
}

/**
 * Turns framebuffer damage into Guacamole drawing on layer 0, paced by how
 * fast the clients acknowledge frames. While a client lags, damage keeps
 * merging instead of queueing, so a slow link sees fewer, fresher frames.
 */
export class Display {
  private source: PixelSource | null = null;
  private width = 0;
  private height = 0;
  private readonly dirty = new DirtyRegion();
  private timer: NodeJS.Timeout | null = null;
  private readonly users = new Map<string, UserSync>();
  private cursor: CursorImage = ARROW;
  /** Recent update counts per 64px cell, decayed over time. */
  private heat = new Float32Array(0);
  private heatCols = 0;
  private heatAt = 0;
  private readonly now: () => number;
  /** force-lossless: never JPEG. */
  lossless = false;

  constructor(
    private readonly out: Output,
    private readonly options: DisplayOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setSource(source: PixelSource): void {
    this.source = source;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.heatCols = Math.ceil(width / CELL);
    this.heat = new Float32Array(this.heatCols * Math.ceil(height / CELL));
    this.dirty.take();
    this.out.send("size", 0, width, height);
    this.damage({ x: 0, y: 0, w: width, h: height });
  }

  damage(r: Rect): void {
    const clipped = clip(r, this.width, this.height);
    if (!clipped) return;
    this.dirty.add(clipped);
    this.warm(clipped);
    this.schedule();
  }

  /** CopyRect: move pixels on the client too, then repaint what was stale. */
  copy(src: Rect, dx: number, dy: number): void {
    const stale = this.dirty.intersects(src);
    this.out.send("copy", 0, src.x, src.y, src.w, src.h, SRC, 0, dx, dy);
    if (stale) this.damage({ x: dx, y: dy, w: src.w, h: src.h });
    else this.schedule();
  }

  setCursor(image: CursorImage): void {
    this.cursor = image;
    this.out.raw(this.cursorInstructions(image));
    this.schedule();
  }

  cursorDefault(): void {
    this.setCursor(ARROW);
  }

  cursorHidden(): void {
    this.setCursor(BLANK);
  }

  cursorDot(): void {
    this.setCursor(DOT);
  }

  addUser(user: string): void {
    this.users.set(user, { lastAck: this.now(), outstanding: [] });
  }

  removeUser(user: string): void {
    this.users.delete(user);
    this.schedule();
  }

  /** A client's `sync`, acknowledging every frame up to `timestamp`. */
  ack(user: string, timestamp: number): void {
    const sync = this.users.get(user);
    if (!sync) return;
    sync.lastAck = this.now();
    sync.outstanding = sync.outstanding.filter((ts) => ts > timestamp);
    if (!this.dirty.empty) this.schedule();
  }

  /** Everything a user joining now needs to see the current screen. */
  snapshot(): string {
    let data = encode("size", 0, this.width, this.height);
    if (this.source && this.width > 0 && this.height > 0) {
      data += this.imageInstructions(
        { x: 0, y: 0, w: this.width, h: this.height },
        false,
      );
    }
    data += this.cursorInstructions(this.cursor);
    data += encode("sync", this.now());
    return data;
  }

  /** Sends pending damage now if the clients can take another frame. */
  flush(): void {
    this.timer = null;
    if (!this.source) return;
    if (this.lagging()) {
      this.timer = setTimeout(() => this.flush(), FRAME_MS * 2);
      return;
    }
    const rects = this.dirty.take();
    const quality = this.maxOutstanding() > 1 ? 60 : 80;
    let data = "";
    for (const rect of rects) {
      data += this.imageInstructions(rect, this.isLossy(rect), quality);
    }
    const ts = this.now();
    data += encode("sync", ts);
    for (const sync of this.users.values()) sync.outstanding.push(ts);
    this.out.raw(data);
    this.out.flush();
  }

  /** Ends a frame with nothing drawn, so clients still see time pass. */
  sync(): void {
    if (this.timer) return;
    this.out.send("sync", this.now());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FRAME_MS);
  }

  private maxOutstanding(): number {
    let max = 0;
    for (const sync of this.users.values()) {
      max = Math.max(max, sync.outstanding.length);
    }
    return max;
  }

  /** True while an active client is still behind. A stalled one is ignored. */
  private lagging(): boolean {
    const now = this.now();
    for (const sync of this.users.values()) {
      if (sync.outstanding.length < MAX_OUTSTANDING) continue;
      if (now - sync.lastAck < STALLED_MS) return true;
    }
    return false;
  }

  private warm(r: Rect): void {
    const now = this.now();
    const elapsed = (now - this.heatAt) / 1000;
    if (elapsed > 0.25) {
      const decay = Math.pow(0.5, elapsed);
      for (let i = 0; i < this.heat.length; i++) this.heat[i] *= decay;
      this.heatAt = now;
    }
    const x1 = Math.floor(r.x / CELL);
    const y1 = Math.floor(r.y / CELL);
    const x2 = Math.floor((r.x + r.w - 1) / CELL);
    const y2 = Math.floor((r.y + r.h - 1) / CELL);
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) this.heat[y * this.heatCols + x] += 1;
    }
  }

  /** Large regions that keep changing (video, scrolling photos) go as JPEG. */
  private isLossy(r: Rect): boolean {
    if (this.lossless || r.w * r.h < LOSSY_MIN_AREA) return false;
    const x1 = Math.floor(r.x / CELL);
    const y1 = Math.floor(r.y / CELL);
    const x2 = Math.floor((r.x + r.w - 1) / CELL);
    const y2 = Math.floor((r.y + r.h - 1) / CELL);
    let sum = 0;
    let cells = 0;
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        sum += this.heat[y * this.heatCols + x];
        cells++;
      }
    }
    return cells > 0 && sum / cells >= LOSSY_RATE;
  }

  private imageInstructions(r: Rect, lossy: boolean, quality = 80): string {
    const source = this.source!;
    const bytes = lossy
      ? source.jpeg(r.x, r.y, r.w, r.h, quality)
      : source.png(r.x, r.y, r.w, r.h);
    if (bytes.length === 0) return "";
    return this.streamImage(
      0,
      OVER,
      lossy ? "image/jpeg" : "image/png",
      r.x,
      r.y,
      bytes,
    );
  }

  private streamImage(
    layer: number,
    mask: number,
    mimetype: string,
    x: number,
    y: number,
    bytes: Uint8Array,
  ): string {
    const stream = this.out.openStream();
    let data = encode("img", stream, mask, layer, mimetype, x, y);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let offset = 0; offset < buffer.length; offset += 6048) {
      data += encode(
        "blob",
        stream,
        buffer.subarray(offset, offset + 6048).toString("base64"),
      );
    }
    data += encode("end", stream);
    this.out.closeStream(stream);
    return data;
  }

  private cursorInstructions(image: CursorImage): string {
    let data = encode("size", -1, image.width, image.height);
    const png = this.options.rgbaPng(image.rgba, image.width, image.height);
    if (png.length > 0)
      data += this.streamImage(-1, SRC, "image/png", 0, 0, png);
    data += encode(
      "cursor",
      image.hotspotX,
      image.hotspotY,
      -1,
      0,
      0,
      image.width,
      image.height,
    );
    return data;
  }
}
