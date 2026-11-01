import { describe, expect, it } from "vitest";
import {
  detectMetaKeyFamily,
  metaKeyLabels,
  remoteKeysym,
  shouldSendKey,
  watchRightAlt,
} from "../../src/frontend/guacamole-meta-key.js";

describe("guacamole toolbar meta key labels", () => {
  it("keeps Windows labels for RDP regardless of the local device", () => {
    expect(
      detectMetaKeyFamily("rdp", {
        platform: "MacIntel",
        userAgent: "Macintosh; Intel Mac OS X",
        userAgentDataPlatform: "macOS",
      }),
    ).toBe("win");
  });

  it("labels VNC with the local device's modifier instead of Windows", () => {
    expect(
      detectMetaKeyFamily("vnc", {
        platform: "MacIntel",
        userAgent: "Macintosh; Intel Mac OS X",
        userAgentDataPlatform: "macOS",
      }),
    ).toBe("cmd");
    expect(
      detectMetaKeyFamily("vnc", {
        platform: "Linux x86_64",
        userAgent: "X11; Linux x86_64",
        userAgentDataPlatform: "Linux",
      }),
    ).toBe("super");
    expect(
      detectMetaKeyFamily("vnc", {
        platform: "Win32",
        userAgent: "Windows NT 10.0",
        userAgentDataPlatform: "Windows",
      }),
    ).toBe("win");
  });

  it("labels ARD with Cmd whatever the browser runs on", () => {
    expect(
      detectMetaKeyFamily("ard", {
        platform: "Win32",
        userAgent: "Windows NT 10.0",
        userAgentDataPlatform: "Windows",
      }),
    ).toBe("cmd");
  });

  it("exposes Super/Cmd button copy for non-Windows VNC sessions", () => {
    expect(metaKeyLabels("super").short).toBe("Super");
    expect(metaKeyLabels("super").lock).toBe("Super+L");
    expect(metaKeyLabels("cmd").short).toBe("Cmd");
    expect(metaKeyLabels("cmd").lock).toBe("Cmd+L");
  });
});

describe("remoteKeysym", () => {
  it("sends a Mac the Super key where the browser pressed Meta", () => {
    expect(remoteKeysym("ard", 0xffe7)).toBe(0xffeb);
    expect(remoteKeysym("ard", 0xffe8)).toBe(0xffec);
    expect(remoteKeysym("ard", 0x63)).toBe(0x63);
    expect(remoteKeysym("ard", 0xffe9)).toBe(0xffe9);
  });

  it("leaves every other protocol alone", () => {
    for (const protocol of ["rdp", "vnc", "telnet", undefined] as const) {
      expect(remoteKeysym(protocol, 0xffe7)).toBe(0xffe7);
      expect(remoteKeysym(protocol, 0xffe8)).toBe(0xffe8);
    }
  });
});

describe("right Alt", () => {
  const press = (target: HTMLElement, type: string, key: string) =>
    target.dispatchEvent(
      new KeyboardEvent(type, { code: "AltRight", key, bubbles: true }),
    );

  it("goes out as Alt_R when the browser sees a plain Alt", () => {
    const el = document.createElement("div");
    const stop = watchRightAlt(el);
    press(el, "keydown", "Alt");
    expect(remoteKeysym("rdp", 0xfe03, true)).toBe(0xffea);
    press(el, "keyup", "Alt");
    expect(remoteKeysym("rdp", 0xfe03, false)).toBe(0xffea);
    stop();
  });

  it("stays AltGr when the browser sees AltGraph", () => {
    const el = document.createElement("div");
    const stop = watchRightAlt(el);
    press(el, "keydown", "AltGraph");
    expect(remoteKeysym("rdp", 0xfe03, true)).toBe(0xfe03);
    expect(remoteKeysym("rdp", 0xfe03, false)).toBe(0xfe03);
    stop();
  });

  it("leaves other sessions alone", () => {
    const el = document.createElement("div");
    const stop = watchRightAlt(el);
    press(el, "keydown", "Alt");
    expect(remoteKeysym("vnc", 0xfe03, true)).toBe(0xfe03);
    stop();
  });
});

describe("toggle key repeat", () => {
  const HANGUL = 0xff31;
  const press = (target: HTMLElement, type: string, repeat = false) =>
    target.dispatchEvent(
      new KeyboardEvent(type, { key: "HangulMode", repeat, bubbles: true }),
    );

  it("sends one down and one up however long the key is held", () => {
    const target = document.createElement("div");
    const stop = watchRightAlt(target);
    press(target, "keydown");
    expect(shouldSendKey(HANGUL, true)).toBe(true);
    // The library's own repeat while the key is still down.
    expect(shouldSendKey(HANGUL, false)).toBe(false);
    expect(shouldSendKey(HANGUL, true)).toBe(false);
    press(target, "keydown", true);
    expect(shouldSendKey(HANGUL, true)).toBe(false);
    press(target, "keyup");
    expect(shouldSendKey(HANGUL, false)).toBe(true);
    // The next tap goes through again.
    press(target, "keydown");
    expect(shouldSendKey(HANGUL, true)).toBe(true);
    stop();
  });

  it("releases on focus loss and never filters other keys", () => {
    const target = document.createElement("div");
    const stop = watchRightAlt(target);
    press(target, "keydown");
    shouldSendKey(HANGUL, true);
    target.dispatchEvent(new FocusEvent("blur"));
    expect(shouldSendKey(HANGUL, false)).toBe(true);
    expect(shouldSendKey(0x61, true)).toBe(true);
    expect(shouldSendKey(0x61, true)).toBe(true);
    stop();
  });
});

describe("Option on an ARD host", () => {
  const ALT_L = 0xffe9;
  const ALT_R = 0xffea;
  const ALT_GR = 0xfe03;
  const AT = 0x40;
  const TWO = 0x32;

  function session() {
    const target = document.createElement("div");
    const stop = watchRightAlt(target);
    const key = (code: string, value: string, type = "keydown") =>
      target.dispatchEvent(
        new KeyboardEvent(type, { code, key: value, bubbles: true }),
      );
    return { key, stop };
  }

  it("sends Option plus the physical key, and releases the same key", () => {
    const { key, stop } = session();
    key("AltLeft", "Alt");
    expect(remoteKeysym("ard", ALT_L, true)).toBe(ALT_L);
    key("Digit2", "@");
    expect(remoteKeysym("ard", AT, true)).toBe(TWO);
    // Option comes up first, the key still releases as what was sent.
    expect(remoteKeysym("ard", ALT_L, false)).toBe(ALT_L);
    key("Digit2", "2", "keyup");
    expect(remoteKeysym("ard", AT, false)).toBe(TWO);
    stop();
  });

  it("uses the code from keypress, where a Mac browser reports the character", () => {
    const { key, stop } = session();
    remoteKeysym("ard", ALT_L, true);
    key("KeyQ", "@", "keypress");
    expect(remoteKeysym("ard", AT, true)).toBe(0x71);
    remoteKeysym("ard", AT, false);
    remoteKeysym("ard", ALT_L, false);
    stop();
  });

  it("sends right Option as Alt_R, and leaves a real AltGr alone", () => {
    const { key, stop } = session();
    key("AltRight", "Alt");
    expect(remoteKeysym("ard", ALT_GR, true)).toBe(ALT_R);
    key("Digit2", "@");
    expect(remoteKeysym("ard", AT, true)).toBe(TWO);
    remoteKeysym("ard", AT, false);
    expect(remoteKeysym("ard", ALT_GR, false)).toBe(ALT_R);
    key("AltRight", "AltGraph");
    expect(remoteKeysym("ard", ALT_GR, true)).toBe(ALT_GR);
    expect(remoteKeysym("ard", ALT_GR, false)).toBe(ALT_GR);
    stop();
  });

  it("changes nothing without Option, for other keys, or on other protocols", () => {
    const { key, stop } = session();
    key("Digit2", "@");
    expect(remoteKeysym("ard", AT, true)).toBe(AT);
    expect(remoteKeysym("ard", AT, false)).toBe(AT);
    remoteKeysym("ard", ALT_L, true);
    key("Escape", "Escape");
    expect(remoteKeysym("ard", 0xff1b, true)).toBe(0xff1b);
    expect(remoteKeysym("ard", 0xff1b, false)).toBe(0xff1b);
    remoteKeysym("ard", ALT_L, false);
    expect(remoteKeysym("vnc", ALT_L, true)).toBe(ALT_L);
    key("Digit2", "@");
    expect(remoteKeysym("vnc", AT, true)).toBe(AT);
    stop();
  });
});
