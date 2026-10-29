import { DEFAULT_LAYOUT, KEYS, LAYOUTS, type LayoutSpec } from "./layouts.js";

/** Bit 8 marks an extended (0xE0) scancode, bit 9 the E1 prefix. */
const EXT = 0x100;

/** Keys that are the same on every layout, by X11 keysym. */
const FIXED: Record<number, number> = {
  0x20: 0x39,
  0xff08: 0x0e,
  0xff09: 0x0f,
  0xff0d: 0x1c,
  0xff1b: 0x01,
  0xffff: EXT | 0x53,
  0xff50: EXT | 0x47,
  0xff51: EXT | 0x4b,
  0xff52: EXT | 0x48,
  0xff53: EXT | 0x4d,
  0xff54: EXT | 0x50,
  0xff55: EXT | 0x49,
  0xff56: EXT | 0x51,
  0xff57: EXT | 0x4f,
  0xff63: EXT | 0x52,
  0xff61: EXT | 0x37,
  0xff14: 0x46,
  0xff7f: 0x45,
  0xffe5: 0x3a,
  0xffe1: 0x2a,
  0xffe2: 0x36,
  0xffe3: 0x1d,
  0xffe4: EXT | 0x1d,
  0xffe9: 0x38,
  0xffea: EXT | 0x38,
  0xfe03: EXT | 0x38,
  0xffe7: EXT | 0x5b,
  0xffe8: EXT | 0x5c,
  0xffeb: EXT | 0x5b,
  0xffec: EXT | 0x5c,
  0xff67: EXT | 0x5d,
  // Keypad, with Num Lock on and off.
  0xffb0: 0x52,
  0xffb1: 0x4f,
  0xffb2: 0x50,
  0xffb3: 0x51,
  0xffb4: 0x4b,
  0xffb5: 0x4c,
  0xffb6: 0x4d,
  0xffb7: 0x47,
  0xffb8: 0x48,
  0xffb9: 0x49,
  0xffae: 0x53,
  0xffac: 0x53,
  0xffab: 0x4e,
  0xffad: 0x4a,
  0xffaa: 0x37,
  0xffaf: EXT | 0x35,
  0xff8d: EXT | 0x1c,
  0xff95: 0x47,
  0xff96: 0x4b,
  0xff97: 0x48,
  0xff98: 0x4d,
  0xff99: 0x50,
  0xff9a: 0x49,
  0xff9b: 0x51,
  0xff9c: 0x4f,
  0xff9d: 0x4c,
  0xff9e: 0x52,
  0xff9f: 0x53,
  // Japanese input keys.
  0xff2a: 0x29,
  0xff22: 0x7b,
  0xff23: 0x79,
  0xff27: 0x70,
  // Korean input keys: Han/Eng (Hangul) and Hanja, which Windows reads as
  // VK_HANGUL and VK_HANJA.
  0xff31: 0x72,
  0xff34: 0x71,
};

// F1 to F24.
const F_KEYS = [
  0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76,
];
F_KEYS.forEach((code, i) => (FIXED[0xffbe + i] = code));

const PAUSE = 0xff13;
const SHIFT_L = 0x2a;
const SHIFT_R = 0x36;
const ALTGR = EXT | 0x38;
const CTRL_L = 0x1d;
const CTRL_R = EXT | 0x1d;
const ALT_L = 0x38;
const WIN_L = EXT | 0x5b;
const WIN_R = EXT | 0x5c;
const CAPS = 0x3a;

type Layer = "base" | "shift" | "altgr" | "altgrShift";

interface Mapping {
  scancode: number;
  layer: Layer;
}

/** The character an X11 keysym types, or null for a function key. */
export function keysymToChar(keysym: number): string | null {
  if (
    (keysym >= 0x20 && keysym <= 0x7e) ||
    (keysym >= 0xa0 && keysym <= 0xff)
  ) {
    return String.fromCodePoint(keysym);
  }
  if (keysym >= 0x01000100 && keysym <= 0x0110ffff) {
    return String.fromCodePoint(keysym - 0x01000000);
  }
  if (keysym === 0x20ac) return "€";
  return null;
}

function indexLayout(spec: LayoutSpec): Map<string, Mapping> {
  const map = new Map<string, Mapping>();
  const add = (chars: string | undefined, layer: Layer, codes: number[]) => {
    if (!chars) return;
    [...chars].forEach((char, i) => {
      if (char !== " " && codes[i] !== undefined && !map.has(char)) {
        map.set(char, { scancode: codes[i], layer });
      }
    });
  };
  add(spec.base, "base", KEYS);
  add(spec.shift, "shift", KEYS);
  add(spec.altgr, "altgr", KEYS);
  add(spec.altgrShift, "altgrShift", KEYS);
  for (const [code, base, shift] of spec.extra ?? []) {
    add(base, "base", [code]);
    add(shift, "shift", [code]);
  }
  return map;
}

export type KeyOutput =
  { scancode: number; down: boolean } | { unicode: number; down: boolean };

/**
 * Turns the keysyms a Guacamole client sends into RDP scancodes for the
 * server's layout, pressing or lifting Shift and AltGr around a key when the
 * character needs it, like guacd. What the layout can't type is sent as
 * Unicode.
 */
export class Keyboard {
  private readonly spec: LayoutSpec;
  private readonly map: Map<string, Mapping>;
  /** Scancodes the server thinks are down. */
  private readonly down = new Set<number>();
  /** What each held keysym pressed, so its release lifts the same thing. */
  private readonly pressedBy = new Map<number, KeyOutput[]>();
  private capsLock = false;

  constructor(layout: string) {
    this.spec = LAYOUTS[layout] ?? LAYOUTS[DEFAULT_LAYOUT];
    this.map = indexLayout(this.spec);
  }

  get layoutId(): number {
    return this.spec.id;
  }

  key(keysym: number, pressed: boolean): KeyOutput[] {
    if (!pressed) return this.release(keysym);
    // Key repeat: a second press without a release.
    if (this.pressedBy.has(keysym) && FIXED[keysym] === undefined) {
      this.release(keysym);
    }
    const out = this.press(keysym);
    return out;
  }

  /** Lifts everything still held, for when the window loses focus. */
  releaseAll(): KeyOutput[] {
    const out: KeyOutput[] = [];
    for (const keysym of [...this.pressedBy.keys()])
      out.push(...this.release(keysym));
    for (const code of [...this.down]) out.push(this.up(code));
    return out;
  }

  private press(keysym: number): KeyOutput[] {
    if (keysym === PAUSE) {
      const out: KeyOutput[] = [this.downKey(0x200 | 0x1d), this.downKey(0x45)];
      this.pressedBy.set(keysym, [
        { scancode: 0x200 | 0x1d, down: false },
        { scancode: 0x45, down: false },
      ]);
      return out;
    }
    const fixed = FIXED[keysym];
    if (fixed !== undefined) {
      if (fixed === CAPS) this.capsLock = !this.capsLock;
      this.pressedBy.set(keysym, [{ scancode: fixed, down: false }]);
      return [this.downKey(fixed)];
    }
    const char = keysymToChar(keysym);
    if (char === null) return [];
    if (this.shortcut()) {
      const mapping =
        this.map.get(char.toLowerCase()) ?? this.map.get(char) ?? null;
      if (mapping) {
        this.pressedBy.set(keysym, [
          { scancode: mapping.scancode, down: false },
        ]);
        return [this.downKey(mapping.scancode)];
      }
    } else if (!this.spec.unicode) {
      const mapping = this.map.get(char);
      if (mapping) return this.typed(keysym, char, mapping);
    }
    return this.unicode(char);
  }

  private release(keysym: number): KeyOutput[] {
    const held = this.pressedBy.get(keysym);
    if (!held) return [];
    this.pressedBy.delete(keysym);
    const out: KeyOutput[] = [];
    for (const item of held) {
      if ("scancode" in item) {
        if (this.down.has(item.scancode)) out.push(this.up(item.scancode));
      } else {
        out.push(item);
      }
    }
    return out;
  }

  /** Ctrl, Alt or the Windows key held: send the key itself, not a character. */
  private shortcut(): boolean {
    const ctrl = this.down.has(CTRL_L) || this.down.has(CTRL_R);
    const altgr = this.down.has(ALTGR);
    // Ctrl with AltGr is how Windows browsers send AltGr.
    if (altgr && !this.down.has(ALT_L)) return false;
    return (
      ctrl ||
      this.down.has(ALT_L) ||
      this.down.has(WIN_L) ||
      this.down.has(WIN_R)
    );
  }

  private typed(keysym: number, char: string, mapping: Mapping): KeyOutput[] {
    let needShift = mapping.layer === "shift" || mapping.layer === "altgrShift";
    const needAltgr =
      mapping.layer === "altgr" || mapping.layer === "altgrShift";
    if (this.capsLock && char.toLowerCase() !== char.toUpperCase()) {
      needShift = !needShift;
    }
    const before: KeyOutput[] = [];
    const after: KeyOutput[] = [];
    const shifts = [SHIFT_L, SHIFT_R].filter((code) => this.down.has(code));
    if (needShift && shifts.length === 0) {
      before.push(this.downKey(SHIFT_L));
      after.push(this.up(SHIFT_L, false));
    } else if (!needShift && shifts.length > 0) {
      for (const code of shifts) {
        before.push(this.up(code));
        after.push(this.downKey(code, false));
      }
    }
    const altgrHeld = this.down.has(ALTGR);
    if (needAltgr && !altgrHeld) {
      before.push(this.downKey(ALTGR));
      after.push(this.up(ALTGR, false));
    } else if (!needAltgr && altgrHeld) {
      before.push(this.up(ALTGR));
      after.push(this.downKey(ALTGR, false));
    }
    // Put the modifiers back as they were once the key is down.
    for (const item of after) {
      if ("scancode" in item) {
        if (item.down) this.down.add(item.scancode);
        else this.down.delete(item.scancode);
      }
    }
    this.pressedBy.set(keysym, [{ scancode: mapping.scancode, down: false }]);
    return [...before, this.downKey(mapping.scancode), ...after];
  }

  private unicode(char: string): KeyOutput[] {
    const out: KeyOutput[] = [];
    for (let i = 0; i < char.length; i++) {
      const unit = char.charCodeAt(i);
      out.push({ unicode: unit, down: true }, { unicode: unit, down: false });
    }
    return out;
  }

  private downKey(scancode: number, track = true): KeyOutput {
    if (track) this.down.add(scancode);
    return { scancode, down: true };
  }

  private up(scancode: number, track = true): KeyOutput {
    if (track) this.down.delete(scancode);
    return { scancode, down: false };
  }
}
