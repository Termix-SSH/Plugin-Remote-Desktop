import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CLIPBOARD_KEY_HOLD_MS,
  RdpClient,
  nextSize,
  normalizeKdcUrl,
  printFile,
  rdpConfig,
  redirectTarget,
  scaleFromDpi,
  subjectPublicKey,
  timezoneBias,
} from "../../../../../src/backend/engine/worker/rdp/client.js";
import { Settings } from "../../../../../src/backend/engine/worker/remote.js";

describe("subjectPublicKey", () => {
  it("is the BIT STRING inside the SPKI, as CredSSP wants", () => {
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pkcs1 = publicKey.export({ type: "pkcs1", format: "der" });
    expect(subjectPublicKey(spki).equals(pkcs1)).toBe(true);
  });

  it("refuses something that isn't a key", () => {
    expect(() => subjectPublicKey(Buffer.from([1, 2, 3, 4]))).toThrow();
  });
});

describe("rdpConfig", () => {
  it("maps guacd's settings", () => {
    const config = rdpConfig(
      new Settings({
        hostname: "h",
        username: "u",
        password: "p",
        domain: "D",
        dpi: "192",
        "disable-audio": "true",
        "enable-wallpaper": "true",
        "enable-printing": "true",
        "resize-method": "reconnect",
        "force-lossless": "true",
      }),
      0x407,
      true,
    );
    expect(config).toMatchObject({
      host: "h",
      username: "u",
      domain: "D",
      scale: 200,
      keyboardLayout: 0x407,
      audio: false,
      wallpaper: true,
      driveName: "Shared Drive",
      printerName: "Termix Printer",
      displayControl: false,
      lossy: false,
      security: "any",
    });
  });

  it("maps console and RemoteApp", () => {
    const config = rdpConfig(
      new Settings({
        console: "true",
        "remote-app": "||notepad",
        "remote-app-dir": "C:\\",
        "remote-app-args": "a.txt",
      }),
      0x409,
      false,
    );
    expect(config).toMatchObject({
      console: true,
      remoteApp: "||notepad",
      remoteAppDir: "C:\\",
      remoteAppArgs: "a.txt",
    });
  });

  it("leaves the drive and printer out unless asked", () => {
    const config = rdpConfig(new Settings({}), 0x409, false);
    expect(config.driveName).toBeNull();
    expect(config.printerName).toBeNull();
    expect(config.displayControl).toBe(true);
  });
});

describe("normalizeKdcUrl", () => {
  it("adds the scheme and port", () => {
    expect(normalizeKdcUrl("dc1.example.com")).toBe("tcp://dc1.example.com:88");
    expect(normalizeKdcUrl(" dc1.example.com:8888 ")).toBe(
      "tcp://dc1.example.com:8888",
    );
    expect(normalizeKdcUrl("udp://10.0.0.5")).toBe("udp://10.0.0.5:88");
  });

  it("keeps a proxy url and drops junk", () => {
    expect(normalizeKdcUrl("https://proxy.example.com/KdcProxy")).toBe(
      "https://proxy.example.com/KdcProxy",
    );
    expect(normalizeKdcUrl("")).toBe("");
  });
});

describe("helpers", () => {
  it("turns dpi into a scale factor", () => {
    expect(scaleFromDpi(96)).toBe(100);
    expect(scaleFromDpi(144)).toBe(150);
    expect(scaleFromDpi(1000)).toBe(500);
  });

  it("finds a zone's offset from UTC", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(timezoneBias("America/New_York", winter)).toBe(300);
    expect(timezoneBias("Europe/Berlin", winter)).toBe(-60);
    expect(timezoneBias("", winter)).toBe(0);
    expect(timezoneBias("Not/AZone", winter)).toBe(0);
  });

  it("names a print job by its content", () => {
    expect(printFile(Buffer.from("%PDF-1.7")).mimetype).toBe("application/pdf");
    expect(printFile(Buffer.from("%!PS")).name).toMatch(/\.ps$/);
    expect(printFile(Buffer.from("PK\x03\x04")).name).toMatch(/\.xps$/);
  });
});

describe("nextSize", () => {
  const current = { width: 1280, height: 720, dpi: 192 };

  it("keeps the dpi when a resize has none", () => {
    expect(nextSize(current, 720, 1280, 0)).toEqual({
      width: 720,
      height: 1280,
      dpi: 192,
    });
  });

  it("takes a new dpi when one is sent", () => {
    expect(nextSize(current, 1280, 720, 96)?.dpi).toBe(96);
  });

  it("skips tiny and unchanged sizes", () => {
    expect(nextSize(current, 100, 720, 0)).toBeNull();
    expect(nextSize(current, 1280, 720, 0)).toBeNull();
  });
});

describe("redirectTarget", () => {
  const event = {
    address: "10.0.0.5",
    fqdn: "",
    loadBalanceInfo: "Cookie: msts=abc\r\n",
    username: "bob",
    domain: "",
    password: "",
  };

  it("follows the address and strips the cookie wrapper", () => {
    const t = redirectTarget(event, "gnome.lan", 3389, 0);
    expect(t).toMatchObject({
      host: "10.0.0.5",
      port: 3389,
      loadBalanceInfo: "abc",
    });
    expect(t?.username).toBe("bob");
  });

  it("uses the same host when the server sends only a token", () => {
    const t = redirectTarget({ ...event, address: "" }, "gnome.lan", 3389, 0);
    expect(t?.host).toBe("gnome.lan");
  });

  it("stops after three hops", () => {
    expect(redirectTarget(event, "gnome.lan", 3389, 3)).toBeNull();
  });

  it("refuses a jump to loopback or link local", () => {
    expect(
      redirectTarget({ ...event, address: "127.0.0.1" }, "gnome.lan", 3389, 0),
    ).toBeNull();
    expect(
      redirectTarget(
        { ...event, address: "169.254.169.254" },
        "gnome.lan",
        3389,
        0,
      ),
    ).toBeNull();
  });
});

describe("paste after a clipboard update", () => {
  function client() {
    const calls: string[] = [];
    const rdp = {
      clipboard_set: (text: string) => calls.push(`clip:${text}`),
      key: (code: number, down: boolean) => calls.push(`key:${code}:${down}`),
      unicode: (code: number, down: boolean) =>
        calls.push(`uni:${code}:${down}`),
      take_events: () => [],
    };
    const c = new RdpClient({ settings: new Settings({}) } as never);
    Object.assign(c as unknown as Record<string, unknown>, {
      rdp,
      connected: true,
    });
    return { c, calls };
  }

  it("holds keys until the server has had time to take the new clipboard (#29)", () => {
    vi.useFakeTimers();
    try {
      const { c, calls } = client();
      c.clipboard("new text");
      c.key(0xffe3, true);
      c.key(0x76, true);
      c.key(0x76, false);
      c.key(0xffe3, false);
      expect(calls).toEqual(["clip:new text"]);
      vi.advanceTimersByTime(CLIPBOARD_KEY_HOLD_MS);
      expect(calls[0]).toBe("clip:new text");
      expect(calls.slice(1)).toHaveLength(4);
      expect(calls[1]).toMatch(/:true$/);
      expect(calls.at(-1)).toMatch(/:false$/);
      // Later keys go straight through again.
      c.key(0x61, true);
      expect(calls).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops held keys when the session stops", () => {
    vi.useFakeTimers();
    try {
      const { c, calls } = client();
      c.clipboard("x");
      c.key(0x61, true);
      Object.assign(c as unknown as Record<string, unknown>, {
        connected: false,
      });
      vi.advanceTimersByTime(CLIPBOARD_KEY_HOLD_MS);
      expect(calls).toEqual(["clip:x"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
