import { describe, expect, it } from "vitest";
import {
  Keyboard,
  keysymToChar,
  type KeyOutput,
} from "../../../../../src/backend/engine/worker/rdp/keyboard.js";
import {
  KEYS,
  LAYOUTS,
} from "../../../../../src/backend/engine/worker/rdp/layouts.js";

const EXT = 0x100;
const SHIFT = 0x2a;
const ALTGR = EXT | 0x38;

const down = (scancode: number): KeyOutput => ({ scancode, down: true });
const up = (scancode: number): KeyOutput => ({ scancode, down: false });

function tap(kb: Keyboard, keysym: number) {
  return [...kb.key(keysym, true), ...kb.key(keysym, false)];
}

describe("layouts", () => {
  it.each(Object.entries(LAYOUTS))("%s lists every key", (_name, spec) => {
    for (const layer of [spec.base, spec.shift, spec.altgr, spec.altgrShift]) {
      if (layer) expect([...layer]).toHaveLength(KEYS.length);
    }
  });
});

describe("keysymToChar", () => {
  it("reads Latin-1 and Unicode keysyms", () => {
    expect(keysymToChar(0x61)).toBe("a");
    expect(keysymToChar(0xe9)).toBe("é");
    expect(keysymToChar(0x01000142)).toBe("ł");
    expect(keysymToChar(0xff0d)).toBeNull();
  });
});

describe("Keyboard", () => {
  it("types plain and shifted US characters", () => {
    const kb = new Keyboard("en-us-qwerty");
    expect(tap(kb, 0x61)).toEqual([down(0x1e), up(0x1e)]);
    expect(tap(kb, 0x41)).toEqual([
      down(SHIFT),
      down(0x1e),
      up(SHIFT),
      up(0x1e),
    ]);
    expect(tap(kb, 0x40)).toEqual([
      down(SHIFT),
      down(0x03),
      up(SHIFT),
      up(0x03),
    ]);
  });

  it("uses the shift the user is already holding", () => {
    const kb = new Keyboard("en-us-qwerty");
    expect(kb.key(0xffe1, true)).toEqual([down(SHIFT)]);
    expect(tap(kb, 0x41)).toEqual([down(0x1e), up(0x1e)]);
    // A character without shift lifts it around the key.
    expect(tap(kb, 0x31)).toEqual([
      up(SHIFT),
      down(0x02),
      down(SHIFT),
      up(0x02),
    ]);
  });

  it("presses AltGr for German characters", () => {
    const kb = new Keyboard("de-de-qwertz");
    expect(kb.layoutId).toBe(0x407);
    expect(tap(kb, 0x40)).toEqual([
      down(ALTGR),
      down(0x10),
      up(ALTGR),
      up(0x10),
    ]);
    expect(tap(kb, 0x7a)).toEqual([down(0x15), up(0x15)]);
    expect(tap(kb, 0xfc)).toEqual([down(0x1a), up(0x1a)]);
  });

  it("follows Caps Lock for letters", () => {
    const kb = new Keyboard("en-us-qwerty");
    tap(kb, 0xffe5);
    expect(tap(kb, 0x41)).toEqual([down(0x1e), up(0x1e)]);
    expect(tap(kb, 0x61)).toEqual([
      down(SHIFT),
      down(0x1e),
      up(SHIFT),
      up(0x1e),
    ]);
  });

  it("sends the key itself for shortcuts", () => {
    const kb = new Keyboard("fr-fr-azerty");
    kb.key(0xffe3, true);
    // Ctrl+A on AZERTY is the key labelled A.
    expect(tap(kb, 0x61)).toEqual([down(0x10), up(0x10)]);
    expect(tap(kb, 0x41)).toEqual([down(0x10), up(0x10)]);
  });

  it("falls back to Unicode for what the layout can't type", () => {
    const kb = new Keyboard("en-us-qwerty");
    expect(tap(kb, 0x01000416)).toEqual([
      { unicode: 0x416, down: true },
      { unicode: 0x416, down: false },
    ]);
    expect(tap(kb, 0x0101f600)).toHaveLength(4);
  });

  it("sends every character as Unicode on failsafe", () => {
    const kb = new Keyboard("failsafe");
    expect(tap(kb, 0x61)).toEqual([
      { unicode: 0x61, down: true },
      { unicode: 0x61, down: false },
    ]);
    expect(tap(kb, 0xff0d)).toEqual([down(0x1c), up(0x1c)]);
  });

  it("maps function, navigation and keypad keys", () => {
    const kb = new Keyboard("unknown-layout");
    expect(kb.layoutId).toBe(0x409);
    expect(tap(kb, 0xffbe)).toEqual([down(0x3b), up(0x3b)]);
    expect(tap(kb, 0xffc9)).toEqual([down(0x58), up(0x58)]);
    expect(tap(kb, 0xff52)).toEqual([down(EXT | 0x48), up(EXT | 0x48)]);
    expect(tap(kb, 0xff8d)).toEqual([down(EXT | 0x1c), up(EXT | 0x1c)]);
    expect(tap(kb, 0xff13)).toEqual([
      down(0x21d),
      down(0x45),
      up(0x21d),
      up(0x45),
    ]);
  });

  it("releases what a key pressed even if modifiers changed", () => {
    const kb = new Keyboard("en-us-qwerty");
    kb.key(0x41, true);
    kb.key(0xffe1, true);
    expect(kb.key(0x41, false)).toEqual([up(0x1e)]);
    expect(kb.releaseAll()).toEqual([up(SHIFT)]);
  });
});

describe("Korean input keys", () => {
  it("sends the Han/Eng and Hanja scancodes", () => {
    const kb = new Keyboard("ko-kr-qwerty");
    expect(tap(kb, 0xff31)).toEqual([down(0x72), up(0x72)]);
    expect(tap(kb, 0xff34)).toEqual([down(0x71), up(0x71)]);
  });
});
