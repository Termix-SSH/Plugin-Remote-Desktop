import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Status } from "../../protocol.js";
import type { RdpClient as WasmRdpClient } from "../../wasm/engine.js";
import type { PixelSource } from "../display.js";
import type { RemoteClient, RemoteHost, Settings } from "../remote.js";
import { Keyboard } from "./keyboard.js";
import { DEFAULT_LAYOUT } from "./layouts.js";
import { DriveCallbacks } from "./drive.js";

type RdpEvent =
  | { k: "send"; data: Uint8Array }
  | { k: "tls" }
  | { k: "connected"; w: number; h: number }
  | { k: "resize"; w: number; h: number }
  | { k: "dirty"; x: number; y: number; w: number; h: number }
  | {
      k: "pointer";
      w: number;
      h: number;
      hx: number;
      hy: number;
      data: Uint8Array;
    }
  | { k: "pointerDefault" }
  | { k: "pointerHidden" }
  | { k: "pointerPosition"; x: number; y: number }
  | { k: "clipboard"; text: string }
  | { k: "audio"; rate: number; channels: number; data: Uint8Array }
  | { k: "logon" }
  | { k: "log"; message: string }
  | { k: "terminated"; reason: string }
  | { k: "error"; kind: string; message: string };

/** The key bytes CredSSP binds to: the subjectPublicKey BIT STRING of the SPKI. */
export function subjectPublicKey(spki: Buffer): Buffer {
  let pos = 0;
  const header = () => {
    const tag = spki[pos++];
    let length = spki[pos++];
    if (length & 0x80) {
      const bytes = length & 0x7f;
      length = 0;
      for (let i = 0; i < bytes; i++) length = (length << 8) | spki[pos++];
    }
    return { tag, length };
  };
  const outer = header();
  if (outer.tag !== 0x30) throw new Error("Bad certificate key");
  const algorithm = header();
  pos += algorithm.length;
  const bits = header();
  if (bits.tag !== 0x03) throw new Error("Bad certificate key");
  // Skip the unused-bits byte.
  return spki.subarray(pos + 1, pos + bits.length);
}

/** Pixels per inch to the scale factor RDP wants, in percent. */
export function scaleFromDpi(dpi: number): number {
  if (!dpi || dpi <= 96) return 100;
  return Math.min(500, Math.round((dpi * 100) / 96));
}

function on(s: Settings, name: string, fallback: boolean): boolean {
  return s.bool(name, fallback);
}

/** guacd's RDP parameters to the engine's config. */
export function rdpConfig(s: Settings, layoutId: number, drive: boolean) {
  const timezone = s.get("timezone");
  return {
    host: s.get("hostname"),
    username: s.get("username"),
    password: s.get("password"),
    domain: s.get("domain"),
    width: s.int("width", 1280),
    height: s.int("height", 720),
    scale: scaleFromDpi(s.int("dpi", 96)),
    security: s.get("security", "any"),
    colorDepth: s.int("color-depth", 32),
    clientName: s.get("client-name", "Termix"),
    keyboardLayout: layoutId,
    wallpaper: on(s, "enable-wallpaper", false),
    theming: on(s, "enable-theming", false),
    fontSmoothing: on(s, "enable-font-smoothing", false),
    fullWindowDrag: on(s, "enable-full-window-drag", false),
    desktopComposition: on(s, "enable-desktop-composition", false),
    menuAnimations: on(s, "enable-menu-animations", false),
    audio: !on(s, "disable-audio", false),
    clipboard: !(on(s, "disable-copy", false) && on(s, "disable-paste", false)),
    driveName: drive ? s.get("drive-name", "Shared Drive") : null,
    printerName: on(s, "enable-printing", false)
      ? s.get("printer-name", "Termix Printer")
      : null,
    printerDriver: s.get("printer-driver") || null,
    displayControl:
      s.get("resize-method", "display-update") === "display-update",
    initialProgram: s.get("initial-program"),
    workDir: s.get("client-dir"),
    loadBalanceInfo: s.get("load-balance-info"),
    timezoneBias: timezoneBias(timezone),
    timezoneName: timezone,
    kdcUrl: s.get("kdc-url"),
    preconnectionId: s.has("preconnection-id")
      ? s.int("preconnection-id", 0)
      : null,
    preconnectionBlob: s.get("preconnection-blob"),
    vmconnect: s.get("security") === "vmconnect",
    console: on(s, "console", false),
    remoteApp: s.get("remote-app"),
    remoteAppDir: s.get("remote-app-dir"),
    remoteAppArgs: s.get("remote-app-args"),
    lossy: !on(s, "force-lossless", false),
  };
}

/** Minutes west of UTC for an IANA zone, as Windows wants it. */
export function timezoneBias(zone: string, now = new Date()): number {
  if (!zone) return 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    const local = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
    );
    const utc = Math.floor(now.getTime() / 60000) * 60000;
    return Math.round((utc - local) / 60000);
  } catch {
    return 0;
  }
}

/** First 4 bytes of a print job say what it is. */
export function printFile(bytes: Uint8Array): {
  name: string;
  mimetype: string;
} {
  const head = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  if (head === "%PDF")
    return { name: `print-${stamp}.pdf`, mimetype: "application/pdf" };
  if (head.startsWith("%!")) {
    return { name: `print-${stamp}.ps`, mimetype: "application/postscript" };
  }
  return { name: `print-${stamp}.xps`, mimetype: "application/oxps" };
}

const KERBEROS_SCRIPT = `
const [proto, url, data] = [process.argv[1], process.argv[2], Buffer.from(process.argv[3], "base64")];
const done = (b) => { process.stdout.write(b.toString("base64")); process.exit(0); };
const fail = (e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); };
const u = new URL(url);
if (proto === "0") {
  const s = require("net").connect(Number(u.port) || 88, u.hostname);
  let buf = Buffer.alloc(0);
  s.setTimeout(10000, () => fail("timeout"));
  s.on("connect", () => s.write(data));
  s.on("data", (c) => { buf = Buffer.concat([buf, c]); if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { s.destroy(); done(buf); } });
  s.on("error", fail);
} else if (proto === "1") {
  const s = require("dgram").createSocket(u.hostname.includes(":") ? "udp6" : "udp4");
  const t = setTimeout(() => fail("timeout"), 10000);
  s.on("message", (m) => { clearTimeout(t); s.close(); done(m); });
  s.send(data, Number(u.port) || 88, u.hostname, (e) => e && fail(e));
} else {
  fetch(url, { method: "POST", body: data, headers: { "content-type": "application/kerberos" } })
    .then((r) => r.arrayBuffer()).then((b) => done(Buffer.from(b))).catch(fail);
}`;

/**
 * Kerberos asks for KDC round trips in the middle of a synchronous WASM call,
 * so each one runs in a short-lived child process the worker waits on.
 */
function kerberosRequest(
  protocol: number,
  url: string,
  data: Uint8Array,
): Uint8Array {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      KERBEROS_SCRIPT,
      String(protocol),
      url,
      Buffer.from(data).toString("base64"),
    ],
    { timeout: 15000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "KDC request failed");
  }
  return Buffer.from(result.stdout, "base64");
}

const KIND_STATUS: Record<string, [string, number]> = {
  auth: ["Authentication failed", Status.CLIENT_UNAUTHORIZED],
  negotiation: [
    "The server refused the security settings",
    Status.UPSTREAM_ERROR,
  ],
  protocol: [
    "The RDP server sent something the engine could not handle",
    Status.UPSTREAM_ERROR,
  ],
};

/**
 * RDP through the WASM client. The worker owns the TCP and TLS sockets and
 * shuttles bytes; the WASM side runs the protocol and keeps the framebuffer.
 */
export class RdpClient implements RemoteClient, PixelSource {
  private rdp: WasmRdpClient | null = null;
  private raw: net.Socket | null = null;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private keyboard: Keyboard;
  private drive: DriveCallbacks | null = null;
  private timer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private stopped = false;
  private reconnecting = false;
  private size = { width: 0, height: 0, dpi: 96 };
  width = 0;
  height = 0;

  constructor(private readonly host: RemoteHost) {
    this.keyboard = new Keyboard(
      host.settings.get("server-layout", DEFAULT_LAYOUT),
    );
  }

  start(): void {
    const s = this.host.settings;
    if (s.has("gateway-hostname")) {
      this.host.fail(
        "RD Gateway needs an external guacd. Set its address in Remote Desktop settings.",
        Status.UNSUPPORTED,
      );
      return;
    }
    this.size = {
      width: s.int("width", 1280),
      height: s.int("height", 720),
      dpi: s.int("dpi", 96),
    };
    if (this.host.drive && s.bool("enable-drive")) {
      this.drive = new DriveCallbacks(this.host.drive, (name, bytes) =>
        this.host.sendFile(name, "application/octet-stream", bytes),
      );
    }
    this.connect();
    this.timer = setInterval(() => {
      if (!this.rdp || !this.connected) return;
      this.rdp.tick();
      this.pump();
    }, 100);
  }

  private connect(): void {
    const s = this.host.settings;
    const config = rdpConfig(s, this.keyboard.layoutId, !!this.drive);
    if (config.security === "rdp") {
      // Legacy RC4 "RDP" security isn't in IronRDP; every server since
      // Windows Server 2003 SP1 also takes TLS.
      this.host.log(
        "warn",
        "RDP security is not supported by the built-in engine, using TLS",
      );
      config.security = "tls";
    }
    config.width = this.size.width;
    config.height = this.size.height;
    config.scale = scaleFromDpi(this.size.dpi);
    const callbacks = {
      network: kerberosRequest,
      print: (bytes: Uint8Array) => {
        const file = printFile(bytes);
        this.host.sendFile(file.name, file.mimetype, bytes);
      },
      ...(this.drive?.host() ?? {}),
    };
    this.rdp = new this.host.wasm.RdpClient(JSON.stringify(config), callbacks);

    const raw = net.connect({
      host: s.get("hostname"),
      port: s.int("port", 3389),
    });
    raw.setNoDelay(true);
    this.raw = raw;
    this.socket = raw;
    let reached = false;
    raw.setTimeout(15000, () => {
      if (!reached)
        raw.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    raw.once("connect", () => {
      reached = true;
      raw.setTimeout(0);
      this.rdp?.start();
      this.pump();
    });
    raw.on("data", this.onPlainData);
    raw.on("error", (error: NodeJS.ErrnoException) =>
      this.socketError(error, reached),
    );
    raw.on("close", () => this.socketClosed(raw));
  }

  private readonly onPlainData = (chunk: Buffer) => {
    if (this.socket !== this.raw) return;
    this.feed(chunk);
  };

  private feed(chunk: Buffer): void {
    if (!this.rdp) return;
    this.rdp.feed(chunk);
    this.pump();
  }

  private socketError(error: NodeJS.ErrnoException, reached: boolean): void {
    if (this.stopped || this.reconnecting) return;
    if (!reached) {
      const timeout = error.code === "ETIMEDOUT";
      this.host.fail(
        timeout
          ? "The RDP server did not answer"
          : "Could not reach the RDP server",
        timeout ? Status.UPSTREAM_TIMEOUT : Status.UPSTREAM_NOT_FOUND,
      );
      return;
    }
    this.host.log("warn", "RDP socket error", { error: error.message });
  }

  private socketClosed(raw: net.Socket): void {
    if (this.stopped || this.reconnecting || raw !== this.raw) return;
    if (this.connected) this.host.closed();
    else
      this.host.fail(
        "The RDP server closed the connection",
        Status.UPSTREAM_ERROR,
      );
  }

  private upgradeTls(): void {
    const raw = this.raw;
    if (!raw) return;
    const s = this.host.settings;
    const hostname = s.get("hostname");
    const verify = !s.bool("ignore-cert");
    raw.off("data", this.onPlainData);
    const secure = tls.connect({
      socket: raw,
      rejectUnauthorized: verify,
      ...(net.isIP(hostname)
        ? { host: hostname }
        : { servername: hostname, host: hostname }),
      // RDP servers often only offer old TLS versions.
      minVersion: "TLSv1",
    });
    this.socket = secure;
    secure.on("data", (chunk: Buffer) => this.feed(chunk));
    secure.on("error", (error: Error) => {
      if (this.stopped || this.reconnecting) return;
      if (!this.connected) {
        this.host.fail(
          verify
            ? `The server certificate was refused: ${error.message}`
            : "TLS failed",
          Status.UPSTREAM_ERROR,
        );
      }
    });
    secure.once("secureConnect", () => {
      let key: Buffer;
      try {
        const cert = secure.getPeerX509Certificate() as crypto.X509Certificate;
        const spki = cert.publicKey.export({ type: "spki", format: "der" });
        key = subjectPublicKey(spki);
      } catch (error) {
        this.host.fail(
          `Could not read the server certificate: ${(error as Error).message}`,
          Status.UPSTREAM_ERROR,
        );
        return;
      }
      this.rdp?.tls_done(key);
      this.pump();
    });
  }

  private write(data: Uint8Array): void {
    this.socket?.write(data);
  }

  private pump(): void {
    const rdp = this.rdp;
    if (!rdp) return;
    const events = rdp.take_events() as RdpEvent[];
    for (const event of events) {
      if (this.rdp !== rdp) return;
      this.handle(event);
    }
  }

  private handle(event: RdpEvent): void {
    const display = this.host.display;
    switch (event.k) {
      case "send":
        this.write(event.data);
        break;
      case "tls":
        this.upgradeTls();
        break;
      case "connected":
        this.connected = true;
        this.reconnecting = false;
        this.width = event.w;
        this.height = event.h;
        display.setSource(this);
        display.resize(event.w, event.h);
        this.rdp?.sync_locks(false, false, false);
        this.host.ready();
        break;
      case "resize":
        this.width = event.w;
        this.height = event.h;
        display.resize(event.w, event.h);
        break;
      case "dirty":
        display.damage({ x: event.x, y: event.y, w: event.w, h: event.h });
        break;
      case "pointer":
        display.setCursor({
          width: event.w,
          height: event.h,
          hotspotX: event.hx,
          hotspotY: event.hy,
          rgba: event.data,
        });
        break;
      case "pointerDefault":
        display.cursorDefault();
        break;
      case "pointerHidden":
        display.cursorHidden();
        break;
      case "clipboard":
        this.host.clipboard(event.text);
        break;
      case "audio":
        this.host.audio(event.rate, event.channels, event.data);
        break;
      case "logon":
        this.host.log("info", "RDP logon complete");
        break;
      case "log":
        this.host.log("warn", event.message);
        break;
      case "terminated":
        this.host.log("info", "RDP session ended", { reason: event.reason });
        if (!this.stopped) this.host.closed();
        break;
      case "error": {
        const [message, status] =
          KIND_STATUS[event.kind] ?? KIND_STATUS.protocol;
        this.host.log("warn", "RDP error", {
          kind: event.kind,
          error: event.message,
        });
        if (!this.stopped) this.host.fail(message, status);
        break;
      }
      default:
        break;
    }
  }

  png(x: number, y: number, w: number, h: number): Uint8Array {
    return this.rdp?.encode_png(x, y, w, h) ?? new Uint8Array();
  }

  jpeg(
    x: number,
    y: number,
    w: number,
    h: number,
    quality: number,
  ): Uint8Array {
    return this.rdp?.encode_jpeg(x, y, w, h, quality) ?? new Uint8Array();
  }

  mouse(x: number, y: number, mask: number): void {
    if (!this.connected || this.host.settings.bool("read-only")) return;
    this.rdp?.mouse(Math.max(0, x), Math.max(0, y), mask);
    this.pump();
  }

  key(keysym: number, pressed: boolean): void {
    if (!this.connected || this.host.settings.bool("read-only")) return;
    for (const out of this.keyboard.key(keysym, pressed)) {
      if ("scancode" in out) this.rdp?.key(out.scancode, out.down);
      else this.rdp?.unicode(out.unicode, out.down);
    }
    this.pump();
  }

  resize(width: number, height: number, dpi: number): void {
    if (width < 200 || height < 200) return;
    if (
      width === this.size.width &&
      height === this.size.height &&
      dpi === this.size.dpi
    )
      return;
    this.size = { width, height, dpi };
    const method = this.host.settings.get("resize-method", "display-update");
    if (method !== "display-update" && method !== "reconnect") return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    // Wait for the window to settle before asking the server.
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (!this.connected || this.stopped) return;
      if (method === "display-update") {
        if (this.rdp?.resize(width, height, scaleFromDpi(dpi))) {
          this.pump();
          return;
        }
      }
      this.reconnect();
    }, 400);
  }

  /** guacd's "reconnect" resize: a fresh connection at the new size. */
  private reconnect(): void {
    this.reconnecting = true;
    this.connected = false;
    this.rdp?.shutdown();
    this.pump();
    this.socket?.destroy();
    this.rdp?.free();
    this.rdp = null;
    this.raw = null;
    this.socket = null;
    this.drive?.reset();
    this.connect();
  }

  clipboard(text: string): void {
    this.rdp?.clipboard_set(text);
    this.pump();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    try {
      this.rdp?.shutdown();
      this.pump();
    } catch {
      // The connection may already be gone.
    }
    this.socket?.end();
    setTimeout(() => this.socket?.destroy(), 500).unref?.();
    this.drive?.reset();
    this.rdp?.free();
    this.rdp = null;
  }
}
