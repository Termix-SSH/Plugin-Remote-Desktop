import type { ByteReader } from "./reader.js";

/** RFB encoding numbers. */
export const ENC = {
  RAW: 0,
  COPYRECT: 1,
  RRE: 2,
  HEXTILE: 5,
  TIGHT: 7,
  ZRLE: 16,
  CURSOR: -239,
  DESKTOP_SIZE: -223,
  LAST_RECT: -224,
  EXTENDED_DESKTOP_SIZE: -308,
  EXTENDED_CLIPBOARD: 0xc0a1e5ce | 0,
  QUALITY_0: -32,
  COMPRESS_0: -256,
} as const;

/** The guacd names a host's `encodings` setting may list. */
export const ENCODING_NAMES: Record<string, number> = {
  raw: ENC.RAW,
  copyrect: ENC.COPYRECT,
  rre: ENC.RRE,
  hextile: ENC.HEXTILE,
  tight: ENC.TIGHT,
  zrle: ENC.ZRLE,
};

export const DEFAULT_ENCODINGS = [
  "tight",
  "zrle",
  "hextile",
  "copyrect",
  "rre",
  "raw",
];

/** An RGBA framebuffer the decoders draw into. */
export interface Framebuffer {
  readonly width: number;
  readonly height: number;
  /** A fresh view of the pixels; take a new one after anything that may allocate. */
  view(): Uint8Array;
  copy(
    sx: number,
    sy: number,
    w: number,
    h: number,
    dx: number,
    dy: number,
  ): void;
  jpeg(x: number, y: number, data: Uint8Array): boolean;
}

/** zlib streams that live across rectangles. */
export interface InflateStream {
  inflate(input: Uint8Array, expected: number): Uint8Array;
  reset(): void;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How pixels arrive, for the color depth the client asked for. */
export interface PixelFormat {
  /** Bytes per pixel. */
  bytes: number;
  /** Bytes per ZRLE CPIXEL and Tight TPIXEL. */
  compact: number;
  /** 0xRRGGBB of the pixel at `at`, which is `size` bytes long. */
  rgb(data: Uint8Array, at: number, size: number): number;
}

/** 32 bit true color, red in the low byte: the default. */
export const FORMAT_24: PixelFormat = {
  bytes: 4,
  compact: 3,
  rgb: (d, at) => (d[at] << 16) | (d[at + 1] << 8) | d[at + 2],
};

const scale = (v: number, max: number) => ((v * 255) / max) | 0;

/** 16 bit RGB565, little endian. */
export const FORMAT_16: PixelFormat = {
  bytes: 2,
  compact: 2,
  rgb: (d, at) => {
    const v = d[at] | (d[at + 1] << 8);
    return (
      (scale((v >> 11) & 31, 31) << 16) |
      (scale((v >> 5) & 63, 63) << 8) |
      scale(v & 31, 31)
    );
  },
};

/** 8 bit BGR233. */
export const FORMAT_8: PixelFormat = {
  bytes: 1,
  compact: 1,
  rgb: (d, at) => {
    const v = d[at];
    return (
      (scale(v & 7, 7) << 16) |
      (scale((v >> 3) & 7, 7) << 8) |
      scale((v >> 6) & 3, 3)
    );
  },
};

function fillRect(
  fb: Framebuffer,
  r: Rect,
  px: Uint8Array,
  offset: number,
  fmt: PixelFormat,
  size: number,
) {
  const view = fb.view();
  const x2 = Math.min(fb.width, r.x + r.w);
  const y2 = Math.min(fb.height, r.y + r.h);
  const color = fmt.rgb(px, offset, size);
  const red = color >> 16;
  const green = (color >> 8) & 255;
  const blue = color & 255;
  for (let y = Math.max(0, r.y); y < y2; y++) {
    let o = (y * fb.width + Math.max(0, r.x)) * 4;
    for (let x = Math.max(0, r.x); x < x2; x++, o += 4) {
      view[o] = red;
      view[o + 1] = green;
      view[o + 2] = blue;
      view[o + 3] = 255;
    }
  }
}

/** Writes `w*h` pixels of `size` bytes each. */
function putPixels(
  fb: Framebuffer,
  r: Rect,
  data: Uint8Array,
  size: number,
  start = 0,
  fmt: PixelFormat = FORMAT_24,
) {
  const view = fb.view();
  for (let row = 0; row < r.h; row++) {
    const y = r.y + row;
    if (y < 0 || y >= fb.height) continue;
    let s = start + row * r.w * size;
    let o = (y * fb.width + r.x) * 4;
    for (let col = 0; col < r.w; col++, s += size, o += 4) {
      if (r.x + col >= fb.width) break;
      const color = fmt.rgb(data, s, size);
      view[o] = color >> 16;
      view[o + 1] = (color >> 8) & 255;
      view[o + 2] = color & 255;
      view[o + 3] = 255;
    }
  }
}

export async function decodeRaw(
  reader: ByteReader,
  fb: Framebuffer,
  r: Rect,
  fmt: PixelFormat = FORMAT_24,
) {
  const data = await reader.bytes(r.w * r.h * fmt.bytes);
  putPixels(fb, r, data, fmt.bytes, 0, fmt);
}

export async function decodeCopyRect(
  reader: ByteReader,
  fb: Framebuffer,
  r: Rect,
) {
  const sx = await reader.u16();
  const sy = await reader.u16();
  fb.copy(sx, sy, r.w, r.h, r.x, r.y);
  return { sx, sy };
}

export async function decodeRre(
  reader: ByteReader,
  fb: Framebuffer,
  r: Rect,
  fmt: PixelFormat = FORMAT_24,
) {
  const bpp = fmt.bytes;
  const count = await reader.u32();
  fillRect(fb, r, await reader.bytes(bpp), 0, fmt, bpp);
  const data = await reader.bytes(count * (bpp + 8));
  for (let i = 0; i < count; i++) {
    const o = i * (bpp + 8);
    const sub = {
      x: r.x + data.readUInt16BE(o + bpp),
      y: r.y + data.readUInt16BE(o + bpp + 2),
      w: data.readUInt16BE(o + bpp + 4),
      h: data.readUInt16BE(o + bpp + 6),
    };
    fillRect(fb, sub, data, o, fmt, bpp);
  }
}

export async function decodeHextile(
  reader: ByteReader,
  fb: Framebuffer,
  r: Rect,
  fmt: PixelFormat = FORMAT_24,
) {
  const BPP = fmt.bytes;
  let bg = Buffer.alloc(BPP);
  let fg = Buffer.alloc(BPP);
  for (let ty = r.y; ty < r.y + r.h; ty += 16) {
    for (let tx = r.x; tx < r.x + r.w; tx += 16) {
      const tile = {
        x: tx,
        y: ty,
        w: Math.min(16, r.x + r.w - tx),
        h: Math.min(16, r.y + r.h - ty),
      };
      const flags = await reader.u8();
      if (flags & 1) {
        putPixels(
          fb,
          tile,
          await reader.bytes(tile.w * tile.h * BPP),
          BPP,
          0,
          fmt,
        );
        continue;
      }
      if (flags & 2) bg = Buffer.from(await reader.bytes(BPP));
      fillRect(fb, tile, bg, 0, fmt, BPP);
      if (flags & 4) fg = Buffer.from(await reader.bytes(BPP));
      if (!(flags & 8)) continue;
      const count = await reader.u8();
      const coloured = (flags & 16) !== 0;
      const size = coloured ? BPP + 2 : 2;
      const data = await reader.bytes(count * size);
      for (let i = 0; i < count; i++) {
        const o = i * size;
        const color = coloured ? data : fg;
        const offset = coloured ? o : 0;
        const xy = data[o + (coloured ? BPP : 0)];
        const wh = data[o + (coloured ? BPP : 0) + 1];
        fillRect(
          fb,
          {
            x: tx + (xy >> 4),
            y: ty + (xy & 15),
            w: (wh >> 4) + 1,
            h: (wh & 15) + 1,
          },
          color,
          offset,
          fmt,
          BPP,
        );
      }
    }
  }
}

/** Reads from an inflated buffer, failing loudly when it runs short. */
class Cursor {
  pos = 0;
  constructor(readonly data: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.data.length) throw new Error("ZRLE data ended early");
    return this.data[this.pos++];
  }
  take(n: number): number {
    const at = this.pos;
    if (at + n > this.data.length) throw new Error("ZRLE data ended early");
    this.pos += n;
    return at;
  }
}

export async function decodeZrle(
  reader: ByteReader,
  fb: Framebuffer,
  r: Rect,
  stream: InflateStream,
  fmt: PixelFormat = FORMAT_24,
) {
  const CPP = fmt.compact;
  const length = await reader.u32();
  const compressed = await reader.bytes(length);
  const c = new Cursor(stream.inflate(compressed, r.w * r.h * CPP));
  const data = c.data;
  const palette: number[] = [];
  for (let ty = r.y; ty < r.y + r.h; ty += 64) {
    for (let tx = r.x; tx < r.x + r.w; tx += 64) {
      const tile = {
        x: tx,
        y: ty,
        w: Math.min(64, r.x + r.w - tx),
        h: Math.min(64, r.y + r.h - ty),
      };
      const sub = c.u8();
      const pixels = tile.w * tile.h;
      if (sub === 0) {
        putPixels(fb, tile, data, CPP, c.take(pixels * CPP), fmt);
      } else if (sub === 1) {
        fillRect(fb, tile, data, c.take(CPP), fmt, CPP);
      } else if (sub <= 16) {
        palette.length = 0;
        for (let i = 0; i < sub; i++) palette.push(c.take(CPP));
        const bits = sub === 2 ? 1 : sub <= 4 ? 2 : 4;
        const view = fb.view();
        for (let y = 0; y < tile.h; y++) {
          let byte = 0;
          let left = 0;
          for (let x = 0; x < tile.w; x++) {
            if (left === 0) {
              byte = c.u8();
              left = 8;
            }
            left -= bits;
            const index = (byte >> left) & ((1 << bits) - 1);
            writePixel(
              view,
              fb,
              tile.x + x,
              tile.y + y,
              data,
              palette[index] ?? 0,
              fmt,
            );
          }
        }
      } else if (sub === 128 || sub >= 130) {
        palette.length = 0;
        const paletted = sub >= 130;
        if (paletted) {
          for (let i = 0; i < sub - 128; i++) palette.push(c.take(CPP));
        }
        const view = fb.view();
        let done = 0;
        while (done < pixels) {
          let color: number;
          let run = 1;
          if (paletted) {
            const index = c.u8();
            color = palette[index & 127] ?? 0;
            if (index & 128) run = runLength(c);
          } else {
            color = c.take(CPP);
            run = runLength(c);
          }
          for (let i = 0; i < run && done < pixels; i++, done++) {
            const x = tile.x + (done % tile.w);
            const y = tile.y + Math.floor(done / tile.w);
            writePixel(view, fb, x, y, data, color, fmt);
          }
        }
      } else {
        throw new Error(`Unknown ZRLE subencoding ${sub}`);
      }
    }
  }
}

function runLength(c: Cursor): number {
  let run = 1;
  let byte: number;
  do {
    byte = c.u8();
    run += byte;
  } while (byte === 255);
  return run;
}

function writePixel(
  view: Uint8Array,
  fb: Framebuffer,
  x: number,
  y: number,
  data: Uint8Array,
  at: number,
  fmt: PixelFormat,
) {
  if (x >= fb.width || y >= fb.height) return;
  const o = (y * fb.width + x) * 4;
  const color = fmt.rgb(data, at, fmt.compact);
  view[o] = color >> 16;
  view[o + 1] = (color >> 8) & 255;
  view[o + 2] = color & 255;
  view[o + 3] = 255;
}

async function compactLength(reader: ByteReader): Promise<number> {
  let length = 0;
  for (let i = 0; i < 3; i++) {
    const byte = await reader.u8();
    length |= (byte & (i === 2 ? 0xff : 0x7f)) << (7 * i);
    if (i < 2 && !(byte & 0x80)) break;
  }
  return length;
}

export interface TightState {
  streams: InflateStream[];
}

/** Returns true when the rect was JPEG, which the display may forward as is. */
export async function decodeTight(
  reader: ByteReader,
  fb: Framebuffer,
  r: Rect,
  state: TightState,
  fmt: PixelFormat = FORMAT_24,
): Promise<void> {
  const CPP = fmt.compact;
  const control = await reader.u8();
  for (let i = 0; i < 4; i++) {
    if (control & (1 << i)) state.streams[i].reset();
  }
  const kind = control >> 4;
  if (kind === 8) {
    fillRect(fb, r, await reader.bytes(CPP), 0, fmt, CPP);
    return;
  }
  if (kind === 9) {
    const data = await reader.bytes(await compactLength(reader));
    if (!fb.jpeg(r.x, r.y, data)) throw new Error("Bad Tight JPEG");
    return;
  }
  if (kind > 9) throw new Error(`Unsupported Tight compression ${kind}`);

  const streamId = kind & 3;
  let filter = 0;
  if (kind & 4) filter = await reader.u8();
  let palette: Buffer | null = null;
  let rowBytes = r.w * CPP;
  if (filter === 1) {
    const colors = (await reader.u8()) + 1;
    palette = Buffer.from(await reader.bytes(colors * CPP));
    rowBytes = colors === 2 ? Math.ceil(r.w / 8) : r.w;
  } else if (filter > 2) {
    throw new Error(`Unknown Tight filter ${filter}`);
  }
  const size = rowBytes * r.h;
  let data: Uint8Array;
  if (size < 12) {
    data = await reader.bytes(size);
  } else {
    const compressed = await reader.bytes(await compactLength(reader));
    data = state.streams[streamId].inflate(compressed, size);
  }
  if (data.length < size) throw new Error("Tight data ended early");

  if (palette) {
    const view = fb.view();
    const two = palette.length === 2 * CPP;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const index = two
          ? (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
          : data[y * rowBytes + x];
        writePixel(view, fb, r.x + x, r.y + y, palette, index * CPP, fmt);
      }
    }
    return;
  }
  if (filter === 2) {
    if (CPP !== 3) throw new Error("Tight gradient needs 24 bit color");
    // Gradient: each byte is the error against left + above - above-left.
    const out = Buffer.alloc(size);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        for (let ch = 0; ch < 3; ch++) {
          const at = (y * r.w + x) * 3 + ch;
          const left = x > 0 ? out[at - 3] : 0;
          const above = y > 0 ? out[at - r.w * 3] : 0;
          const corner = x > 0 && y > 0 ? out[at - r.w * 3 - 3] : 0;
          const predicted = Math.min(255, Math.max(0, left + above - corner));
          out[at] = (predicted + data[at]) & 0xff;
        }
      }
    }
    putPixels(fb, r, out, CPP, 0, fmt);
    return;
  }
  putPixels(fb, r, data, CPP, 0, fmt);
}

/** A Cursor pseudo-rect: pixels, then a 1 bit mask. */
export async function decodeCursor(
  reader: ByteReader,
  r: Rect,
  fmt: PixelFormat = FORMAT_24,
) {
  const BPP = fmt.bytes;
  const pixels = await reader.bytes(r.w * r.h * BPP);
  const stride = Math.ceil(r.w / 8);
  const mask = await reader.bytes(stride * r.h);
  const rgba = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const i = y * r.w + x;
      const visible = (mask[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
      const color = fmt.rgb(pixels, i * BPP, BPP);
      rgba[i * 4] = color >> 16;
      rgba[i * 4 + 1] = (color >> 8) & 255;
      rgba[i * 4 + 2] = color & 255;
      rgba[i * 4 + 3] = visible ? 255 : 0;
    }
  }
  return rgba;
}
