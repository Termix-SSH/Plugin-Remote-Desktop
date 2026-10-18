import { Terminal, type IBufferCell } from "@xterm/headless";
import type { Surface } from "../../wasm/engine.js";
import type { PixelSource } from "../display.js";
import type { RemoteHost } from "../remote.js";
import { surfaceView } from "../wasm.js";
import { GlyphCache } from "./glyphs.js";
import { parseColorScheme, type ColorScheme, type Rgb } from "./palette.js";

interface Point {
  col: number;
  row: number;
}

/**
 * A terminal emulator drawn into a Surface, which is what guacd does for
 * Telnet and SSH: the client only ever sees images.
 */
export class TerminalView implements PixelSource {
  readonly term: Terminal;
  private readonly glyphs: GlyphCache;
  private readonly scheme: ColorScheme;
  private surface: Surface;
  private rows: string[] = [];
  private cursorDrawn: Point | null = null;
  private selection: { anchor: Point; head: Point } | null = null;
  private renderQueued = false;
  private disposed = false;
  width = 0;
  height = 0;

  constructor(
    private readonly host: RemoteHost,
    width: number,
    height: number,
  ) {
    const s = host.settings;
    this.glyphs = new GlyphCache(s.int("font-size", 12));
    this.scheme = parseColorScheme(s.get("color-scheme"));
    const { cols, rows } = this.gridFor(width, height);
    this.term = new Terminal({
      cols,
      rows,
      scrollback: Math.max(0, s.int("scrollback", 1000)),
      allowProposedApi: true,
    });
    this.surface = new host.wasm.Surface(width, height);
    this.resizePixels(width, height);
  }

  get cell() {
    return this.glyphs.metrics;
  }

  png(x: number, y: number, w: number, h: number): Uint8Array {
    return this.surface.encode_png(x, y, w, h, false);
  }

  jpeg(x: number, y: number, w: number, h: number, q: number): Uint8Array {
    return this.surface.encode_jpeg(x, y, w, h, q);
  }

  private gridFor(width: number, height: number) {
    const { width: cw, height: ch } = this.glyphs.metrics;
    return {
      cols: Math.max(2, Math.floor(width / cw)),
      rows: Math.max(1, Math.floor(height / ch)),
    };
  }

  /** Resizes to a pixel size. Returns the new grid. */
  resizePixels(width: number, height: number): { cols: number; rows: number } {
    const grid = this.gridFor(width, height);
    this.width = width;
    this.height = height;
    this.surface.resize(width, height);
    if (grid.cols !== this.term.cols || grid.rows !== this.term.rows) {
      this.term.resize(grid.cols, grid.rows);
    }
    this.host.display.resize(width, height);
    const [r, g, b] = this.scheme.background;
    this.surface.fill(
      0,
      0,
      width,
      height,
      ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0,
    );
    this.rows = [];
    this.cursorDrawn = null;
    this.render();
    return grid;
  }

  write(data: Uint8Array | string): void {
    this.term.write(data, () => this.queueRender());
  }

  scroll(lines: number): void {
    this.term.scrollLines(lines);
    this.queueRender();
  }

  scrollToBottom(): void {
    this.term.scrollToBottom();
    this.queueRender();
  }

  get atBottom(): boolean {
    const b = this.term.buffer.active;
    return b.viewportY >= b.baseY;
  }

  // Selection, in screen pixels.

  pointAt(x: number, y: number): Point {
    const { width, height } = this.glyphs.metrics;
    return {
      col: Math.min(this.term.cols - 1, Math.max(0, Math.floor(x / width))),
      row:
        this.term.buffer.active.viewportY +
        Math.min(this.term.rows - 1, Math.max(0, Math.floor(y / height))),
    };
  }

  selectStart(x: number, y: number): void {
    const p = this.pointAt(x, y);
    this.selection = { anchor: p, head: p };
    this.queueRender();
  }

  selectMove(x: number, y: number): void {
    if (!this.selection) return;
    this.selection.head = this.pointAt(x, y);
    this.queueRender();
  }

  /** Ends the selection and returns its text, or null if nothing was selected. */
  selectEnd(): string | null {
    const sel = this.selection;
    this.selection = null;
    this.queueRender();
    if (
      !sel ||
      (sel.anchor.col === sel.head.col && sel.anchor.row === sel.head.row)
    ) {
      return null;
    }
    const [a, b] = this.ordered(sel.anchor, sel.head);
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let row = a.row; row <= b.row; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const start = row === a.row ? a.col : 0;
      const end = row === b.row ? b.col + 1 : this.term.cols;
      lines.push(line.translateToString(true, start, end));
    }
    return lines.join("\n");
  }

  private ordered(a: Point, b: Point): [Point, Point] {
    return a.row < b.row || (a.row === b.row && a.col <= b.col)
      ? [a, b]
      : [b, a];
  }

  private selected(col: number, row: number): boolean {
    if (!this.selection) return false;
    const [a, b] = this.ordered(this.selection.anchor, this.selection.head);
    if (row < a.row || row > b.row) return false;
    if (row === a.row && col < a.col) return false;
    if (row === b.row && col > b.col) return false;
    return true;
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      if (!this.disposed) this.render();
    });
  }

  private cursorVisible(): boolean {
    const core = (
      this.term as unknown as {
        _core?: { coreService?: { isCursorHidden?: boolean } };
      }
    )._core;
    return !core?.coreService?.isCursorHidden && this.atBottom;
  }

  private color(cell: IBufferCell, fg: boolean): Rgb {
    const isDefault = fg ? cell.isFgDefault() : cell.isBgDefault();
    if (isDefault) return fg ? this.scheme.foreground : this.scheme.background;
    const value = fg ? cell.getFgColor() : cell.getBgColor();
    const rgb = fg ? cell.isFgRGB() : cell.isBgRGB();
    if (rgb) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    // Bold brightens the first 8 colors, like guacd.
    const index = fg && cell.isBold() && value < 8 ? value + 8 : value;
    return this.scheme.palette[index] ?? this.scheme.foreground;
  }

  /** Redraws rows whose content, colors or selection changed. */
  render(): void {
    const buffer = this.term.buffer.active;
    const cursor =
      this.cursorVisible() && buffer.cursorY < this.term.rows
        ? { col: buffer.cursorX, row: buffer.baseY + buffer.cursorY }
        : null;
    const { width: cw, height: ch } = this.glyphs.metrics;
    const cell = buffer.getNullCell();
    for (let screenRow = 0; screenRow < this.term.rows; screenRow++) {
      const row = buffer.viewportY + screenRow;
      const line = buffer.getLine(row);
      let signature = line ? "" : "-";
      const cursorHere = cursor && cursor.row === row ? cursor.col : -1;
      if (line) {
        for (let col = 0; col < this.term.cols; col++) {
          line.getCell(col, cell);
          signature += `${cell.getChars()}|${cell.getFgColorMode()}:${cell.getFgColor()}|${cell.getBgColorMode()}:${cell.getBgColor()}|${cell.isBold()}${cell.isInverse()}${cell.isUnderline()}${cell.isInvisible()}${this.selected(col, row) ? 1 : 0};`;
        }
      }
      signature += `#${cursorHere}`;
      if (this.rows[screenRow] === signature) continue;
      this.rows[screenRow] = signature;
      this.drawRow(screenRow, row, cursorHere);
      this.host.display.damage({
        x: 0,
        y: screenRow * ch,
        w: this.term.cols * cw,
        h: ch,
      });
    }
  }

  private drawRow(screenRow: number, row: number, cursorCol: number): void {
    const buffer = this.term.buffer.active;
    const line = buffer.getLine(row);
    const { width: cw, height: ch, baseline } = this.glyphs.metrics;
    const view = surfaceView(this.host.wasm, this.surface);
    const stride = this.width * 4;
    const y0 = screenRow * ch;
    const cell = buffer.getNullCell();
    for (let col = 0; col < this.term.cols; col++) {
      let fg = this.scheme.foreground;
      let bg = this.scheme.background;
      let chars = "";
      let width = 1;
      let underline = false;
      let bold = false;
      if (line) {
        line.getCell(col, cell);
        width = cell.getWidth();
        if (width === 0) continue;
        chars = cell.isInvisible() ? "" : cell.getChars();
        fg = this.color(cell, true);
        bg = this.color(cell, false);
        if (cell.isInverse()) [fg, bg] = [bg, fg];
        underline = !!cell.isUnderline();
        bold = !!cell.isBold();
      }
      if (this.selected(col, row) !== (col === cursorCol)) [fg, bg] = [bg, fg];
      const x0 = col * cw;
      const pxWidth = Math.min(cw * width, this.width - x0);
      if (pxWidth <= 0) continue;
      const glyph =
        chars && chars !== " " ? this.glyphs.get(chars, bold, width) : null;
      for (let y = 0; y < ch && y0 + y < this.height; y++) {
        let o = (y0 + y) * stride + x0 * 4;
        for (let x = 0; x < pxWidth; x++, o += 4) {
          let a = glyph ? glyph.alpha[y * glyph.width + x] : 0;
          if (underline && y === Math.min(ch - 1, baseline + 1)) a = 255;
          if (a === 0) {
            view[o] = bg[0];
            view[o + 1] = bg[1];
            view[o + 2] = bg[2];
          } else if (a === 255) {
            view[o] = fg[0];
            view[o + 1] = fg[1];
            view[o + 2] = fg[2];
          } else {
            const ia = 255 - a;
            view[o] = (fg[0] * a + bg[0] * ia) / 255;
            view[o + 1] = (fg[1] * a + bg[1] * ia) / 255;
            view[o + 2] = (fg[2] * a + bg[2] * ia) / 255;
          }
          view[o + 3] = 255;
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.term.dispose();
    this.surface.free();
  }
}
