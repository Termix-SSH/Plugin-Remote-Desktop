import type { KeyTarget } from "./messages.js";

/** RustDesk ControlKey values. */
export const CK = {
  Alt: 1,
  Backspace: 2,
  CapsLock: 3,
  Control: 4,
  Delete: 5,
  DownArrow: 6,
  End: 7,
  Escape: 8,
  F1: 9,
  F10: 10,
  F11: 11,
  F12: 12,
  F2: 13,
  Home: 21,
  LeftArrow: 22,
  Meta: 23,
  PageDown: 25,
  PageUp: 26,
  Return: 27,
  RightArrow: 28,
  Shift: 29,
  Space: 30,
  Tab: 31,
  UpArrow: 32,
  Numpad0: 33,
  Pause: 46,
  Snapshot: 57,
  Insert: 58,
  Scroll: 62,
  NumLock: 63,
  RWin: 64,
  Apps: 65,
  Multiply: 66,
  Add: 67,
  Subtract: 68,
  Decimal: 69,
  Divide: 70,
  Equals: 71,
  NumpadEnter: 72,
  RShift: 73,
  RControl: 74,
  RAlt: 75,
  CtrlAltDel: 100,
  LockScreen: 101,
} as const;

// F1 is 9, F2 to F9 are 13 to 20, F10 to F12 are 10 to 12.
const F_KEYS = [9, 13, 14, 15, 16, 17, 18, 19, 20, 10, 11, 12];

/** X11 keysyms that are a RustDesk control key. */
const CONTROL: Record<number, number> = {
  0xffe9: CK.Alt,
  0xffea: CK.RAlt,
  0xfe03: CK.RAlt,
  0xff08: CK.Backspace,
  0xffe5: CK.CapsLock,
  0xffe3: CK.Control,
  0xffe4: CK.RControl,
  0xffff: CK.Delete,
  0xff54: CK.DownArrow,
  0xff57: CK.End,
  0xff1b: CK.Escape,
  0xff50: CK.Home,
  0xff51: CK.LeftArrow,
  0xffe7: CK.Meta,
  0xffeb: CK.Meta,
  0xffe8: CK.RWin,
  0xffec: CK.RWin,
  0xff56: CK.PageDown,
  0xff55: CK.PageUp,
  0xff0d: CK.Return,
  0xff53: CK.RightArrow,
  0xffe1: CK.Shift,
  0xffe2: CK.RShift,
  0x20: CK.Space,
  0xff09: CK.Tab,
  0xfe20: CK.Tab,
  0xff52: CK.UpArrow,
  0xff13: CK.Pause,
  0xff61: CK.Snapshot,
  0xff63: CK.Insert,
  0xff14: CK.Scroll,
  0xff7f: CK.NumLock,
  0xff67: CK.Apps,
  0xffaa: CK.Multiply,
  0xffab: CK.Add,
  0xffad: CK.Subtract,
  0xffae: CK.Decimal,
  0xffac: CK.Decimal,
  0xffaf: CK.Divide,
  0xffbd: CK.Equals,
  0xff8d: CK.NumpadEnter,
  // Keypad with Num Lock off.
  0xff95: CK.Home,
  0xff96: CK.LeftArrow,
  0xff97: CK.UpArrow,
  0xff98: CK.RightArrow,
  0xff99: CK.DownArrow,
  0xff9a: CK.PageUp,
  0xff9b: CK.PageDown,
  0xff9c: CK.End,
  0xff9e: CK.Insert,
  0xff9f: CK.Delete,
};

for (let i = 0; i < 12; i++) CONTROL[0xffbe + i] = F_KEYS[i];
for (let i = 0; i < 10; i++) CONTROL[0xffb0 + i] = CK.Numpad0 + i;

const MODIFIERS = new Set<number>([
  CK.Alt,
  CK.RAlt,
  CK.Control,
  CK.RControl,
  CK.Shift,
  CK.RShift,
  CK.Meta,
  CK.RWin,
]);

/** The character a keysym types, if it is a printable one. */
export function keysymToChar(keysym: number): number | null {
  if (keysym >= 0x21 && keysym <= 0x7e) return keysym;
  if (keysym >= 0xa0 && keysym <= 0xff) return keysym;
  if (keysym >= 0x01000100 && keysym <= 0x0110ffff) return keysym - 0x01000000;
  return null;
}

export function keysymTarget(keysym: number): KeyTarget | null {
  const control = CONTROL[keysym];
  if (control !== undefined) return { controlKey: control };
  const chr = keysymToChar(keysym);
  return chr === null ? null : { chr };
}

/** Held modifier keys, sent with every key and mouse event as RustDesk wants. */
export class Modifiers {
  private readonly held = new Set<number>();

  update(target: KeyTarget, down: boolean): void {
    if (!("controlKey" in target) || !MODIFIERS.has(target.controlKey)) return;
    if (down) this.held.add(target.controlKey);
    else this.held.delete(target.controlKey);
  }

  list(): number[] {
    return [...this.held];
  }

  /** Every held key, to release when the session ends or loses focus. */
  clear(): number[] {
    const keys = [...this.held];
    this.held.clear();
    return keys;
  }
}

// RustDesk mouse event types and buttons: mask = button << 3 | type.
export const MOUSE_MOVE = 0;
export const MOUSE_DOWN = 1;
export const MOUSE_UP = 2;
export const MOUSE_WHEEL = 3;

const BUTTONS: Array<[number, number]> = [
  [1, 0x01], // left
  [2, 0x04], // middle
  [4, 0x02], // right
];

export interface MouseAction {
  mask: number;
  x: number;
  y: number;
}

/** Guacamole mouse state to RustDesk events, as button changes and moves. */
export function mouseActions(
  previous: number,
  mask: number,
  x: number,
  y: number,
  moved: boolean,
): MouseAction[] {
  const out: MouseAction[] = [];
  if (moved) out.push({ mask: MOUSE_MOVE, x, y });
  for (const [guac, button] of BUTTONS) {
    const was = (previous & guac) !== 0;
    const now = (mask & guac) !== 0;
    if (was === now) continue;
    out.push({ mask: (button << 3) | (now ? MOUSE_DOWN : MOUSE_UP), x, y });
  }
  // Guacamole presses 8 or 16 for one wheel step.
  if (mask & 8 && !(previous & 8)) out.push({ mask: MOUSE_WHEEL, x: 0, y: 1 });
  if (mask & 16 && !(previous & 16)) {
    out.push({ mask: MOUSE_WHEEL, x: 0, y: -1 });
  }
  return out;
}
