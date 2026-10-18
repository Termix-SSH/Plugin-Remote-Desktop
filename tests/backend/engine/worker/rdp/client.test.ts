import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  printFile,
  rdpConfig,
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
