import { describe, expect, it } from "vitest";
import {
  detectMetaKeyFamily,
  metaKeyLabels,
  remoteKeysym,
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
