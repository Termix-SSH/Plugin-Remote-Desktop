/** X11 keysyms to the bytes a VT100/xterm terminal sends. */

export interface KeyModes {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  applicationCursor: boolean;
  /** guacd's backspace setting: 127 (DEL) or 8 (BS). */
  backspace: number;
}

const CURSOR: Record<number, string> = {
  0xff51: "D",
  0xff52: "A",
  0xff53: "C",
  0xff54: "B",
  0xff50: "H",
  0xff57: "F",
};

const TILDE: Record<number, string> = {
  0xff63: "2",
  0xffff: "3",
  0xff55: "5",
  0xff56: "6",
  0xffc2: "15",
  0xffc3: "17",
  0xffc4: "18",
  0xffc5: "19",
  0xffc6: "20",
  0xffc7: "21",
  0xffc8: "23",
  0xffc9: "24",
};

const SS3: Record<number, string> = {
  0xffbe: "P",
  0xffbf: "Q",
  0xffc0: "R",
  0xffc1: "S",
};

/** The character a keysym types, if it is a printable one. */
export function keysymChar(keysym: number): string | null {
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCharCode(keysym);
  if (keysym >= 0xa0 && keysym <= 0xff) return String.fromCharCode(keysym);
  if ((keysym & 0xff000000) === 0x01000000) {
    return String.fromCodePoint(keysym & 0xffffff);
  }
  // Keypad digits and operators.
  if (keysym >= 0xffb0 && keysym <= 0xffb9) return String(keysym - 0xffb0);
  const keypad: Record<number, string> = {
    0xffaa: "*",
    0xffab: "+",
    0xffad: "-",
    0xffae: ".",
    0xffaf: "/",
    0xff80: " ",
  };
  return keypad[keysym] ?? null;
}

export function isModifier(keysym: number): boolean {
  return keysym >= 0xffe1 && keysym <= 0xffee;
}

/** Bytes for a key press, or null if the key types nothing. */
export function keyBytes(keysym: number, modes: KeyModes): string | null {
  const esc = "\x1b";
  if (CURSOR[keysym]) {
    const code = CURSOR[keysym];
    return modes.applicationCursor ? `${esc}O${code}` : `${esc}[${code}`;
  }
  if (TILDE[keysym]) return `${esc}[${TILDE[keysym]}~`;
  if (SS3[keysym]) return `${esc}O${SS3[keysym]}`;
  switch (keysym) {
    case 0xff08:
      return String.fromCharCode(modes.backspace);
    case 0xff09:
      return modes.shift ? `${esc}[Z` : "\t";
    case 0xff0d:
    case 0xff8d:
      return "\r";
    case 0xff1b:
      return esc;
  }
  const char = keysymChar(keysym);
  if (char === null) return null;
  let out = char;
  if (modes.ctrl) {
    const code = char.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code - 0x40);
    else if (char === " " || char === "2") out = "\0";
    else if (char === "/") out = "\x1f";
    else if (char === "?") out = "\x7f";
  }
  return modes.alt ? esc + out : out;
}
