import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { Status } from "../../protocol.js";
import type { Surface } from "../../wasm/engine.js";
import type { PixelSource } from "../display.js";
import type { RemoteClient, RemoteHost } from "../remote.js";
import { surfaceView } from "../wasm.js";
import { ByteReader } from "./reader.js";
import { vncAuthResponse } from "./des.js";
import { ardResponse, msLogonResponse, plainCredentials } from "./auth.js";
import {
  DEFAULT_ENCODINGS,
  ENC,
  ENCODING_NAMES,
  decodeCopyRect,
  decodeCursor,
  decodeHextile,
  decodeRaw,
  decodeRre,
  decodeTight,
  decodeZrle,
  FORMAT_16,
  FORMAT_24,
  FORMAT_8,
  type Framebuffer,
  type PixelFormat,
  type InflateStream,
  type TightState,
} from "./encodings.js";

// Security types.
const SEC_NONE = 1;
const SEC_VNC = 2;
const SEC_TIGHT = 16;
const SEC_VENCRYPT = 19;
const SEC_ARD = 30;
const SEC_MSLOGON = 113;
// VeNCrypt subtypes.
const VC_PLAIN = 256;
const VC_TLS_NONE = 257;
const VC_TLS_VNC = 258;
const VC_TLS_PLAIN = 259;
const VC_X509_NONE = 260;
const VC_X509_VNC = 261;
const VC_X509_PLAIN = 262;

// ExtendedClipboard flags.
const CLIP_TEXT = 1 << 0;
const CLIP_CAPS = 1 << 24;
const CLIP_REQUEST = 1 << 25;
const CLIP_PEEK = 1 << 26;
const CLIP_NOTIFY = 1 << 27;
const CLIP_PROVIDE = 1 << 28;

export class VncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The SetPixelFormat message for guacd's color-depth, and how to read what
 * comes back. 8 and 16 bit save bandwidth; anything else is 24 bit color.
 */
export function pixelFormatFor(
  depth: number,
  swap: boolean,
): { format: PixelFormat; message: Buffer } {
  const message = Buffer.alloc(20);
  message[7] = 1; // true color
  let format: PixelFormat;
  if (depth === 16) {
    format = FORMAT_16;
    message[4] = 16;
    message[5] = 16;
    message.writeUInt16BE(31, 8);
    message.writeUInt16BE(63, 10);
    message.writeUInt16BE(31, 12);
    message[14] = swap ? 0 : 11;
    message[15] = 5;
    message[16] = swap ? 11 : 0;
  } else if (depth === 8) {
    // Red and blue have different widths here, so there is nothing to swap.
    format = FORMAT_8;
    message[4] = 8;
    message[5] = 8;
    message.writeUInt16BE(7, 8);
    message.writeUInt16BE(7, 10);
    message.writeUInt16BE(3, 12);
    message[14] = 0;
    message[15] = 3;
    message[16] = 6;
  } else {
    format = FORMAT_24;
    message[4] = 32;
    message[5] = 24;
    message.writeUInt16BE(255, 8);
    message.writeUInt16BE(255, 10);
    message.writeUInt16BE(255, 12);
    message[14] = swap ? 16 : 0;
    message[15] = 8;
    message[16] = swap ? 0 : 16;
  }
  return { format, message };
}

/** The protocol version to answer with, from the server's banner. */
export function chooseVersion(banner: string): {
  minor: number;
  reply: string;
} {
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
  if (!match) throw new VncError("Not a VNC server", Status.UPSTREAM_ERROR);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  // macOS offers Apple's login (type 30) to a client that answers 3.8 too.
  // Answering 3.889 gets black frames on macOS 26, so it answers like guacd.
  if (major === 3 && minor === 889) {
    return { minor: 8, reply: "RFB 003.008\n" };
  }
  if (major > 3 || minor >= 8) return { minor: 8, reply: "RFB 003.008\n" };
  if (minor === 7) return { minor: 7, reply: "RFB 003.007\n" };
  return { minor: 3, reply: "RFB 003.003\n" };
}

/** The security type to use from what the server offers. */
export function chooseSecurity(
  offered: number[],
  username: string,
  password: string,
): number | null {
  const order = username
    ? [SEC_ARD, SEC_VENCRYPT, SEC_MSLOGON, SEC_VNC, SEC_TIGHT, SEC_NONE]
    : [SEC_VENCRYPT, SEC_VNC, SEC_TIGHT, SEC_NONE];
  for (const type of order) {
    if (!offered.includes(type)) continue;
    if (type === SEC_VNC && !password && offered.includes(SEC_NONE)) continue;
    return type;
  }
  return null;
}

export function chooseVencrypt(
  offered: number[],
  username: string,
): number | null {
  const order = username
    ? [
        VC_X509_PLAIN,
        VC_TLS_PLAIN,
        VC_PLAIN,
        VC_X509_VNC,
        VC_TLS_VNC,
        VC_X509_NONE,
        VC_TLS_NONE,
      ]
    : [
        VC_X509_VNC,
        VC_TLS_VNC,
        VC_X509_NONE,
        VC_TLS_NONE,
        VC_X509_PLAIN,
        VC_TLS_PLAIN,
      ];
  return order.find((type) => offered.includes(type)) ?? null;
}

/** Names the encodings to ask for, from guacd's space separated setting. */
export function encodingList(
  setting: string,
  localCursor: boolean,
  quality: number,
): number[] {
  const names = setting.trim()
    ? setting.trim().toLowerCase().split(/\s+/)
    : DEFAULT_ENCODINGS;
  const list = names
    .map((name) => ENCODING_NAMES[name])
    .filter((n) => n !== undefined);
  if (!list.includes(ENC.RAW)) list.push(ENC.RAW);
  list.push(
    ENC.DESKTOP_SIZE,
    ENC.EXTENDED_DESKTOP_SIZE,
    ENC.LAST_RECT,
    ENC.EXTENDED_CLIPBOARD,
    ENC.QUALITY_0 + quality,
    ENC.COMPRESS_0 + 6,
  );
  if (localCursor) list.push(ENC.CURSOR);
  return list;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** Latin-1 or another single byte charset to and from text. */
function encodeText(text: string, encoding: string): Buffer {
  switch (encoding.toUpperCase()) {
    case "UTF-8":
      return Buffer.from(text, "utf8");
    case "UTF-16":
      return Buffer.from(text, "utf16le");
    default:
      return Buffer.from(text.replace(/[^\x00-\xff]/g, "?"), "latin1");
  }
}

function decodeText(bytes: Buffer, encoding: string): string {
  switch (encoding.toUpperCase()) {
    case "UTF-8":
      return bytes.toString("utf8");
    case "UTF-16":
      return bytes.toString("utf16le");
    default:
      return bytes.toString("latin1");
  }
}

/**
 * VNC (RFB 3.3 to 3.8, and Apple's 3.889). Decodes into a WASM Surface the
 * display encodes from, like guacd's VNC client draws into a layer.
 */
export class VncClient implements RemoteClient, Framebuffer {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private reader = new ByteReader();
  private surface: Surface | null = null;
  private tight: TightState | null = null;
  private zrle: InflateStream | null = null;
  private connected = false;
  private stopped = false;
  private readOnly = false;
  private extendedDesktop = false;
  private screenId = 0;
  private extendedClipboard = false;
  private clipboardText = "";
  private pendingResize: { width: number; height: number } | null = null;
  private format: PixelFormat = FORMAT_24;
  private attempts = 0;
  width = 0;
  height = 0;

  constructor(private readonly host: RemoteHost) {}

  start(): void {
    this.readOnly = this.host.settings.bool("read-only");
    if (this.host.settings.get("cursor", "remote") !== "local") {
      this.host.display.cursorDot();
    }
    this.connect();
  }

  private connect(): void {
    const s = this.host.settings;
    this.reader = new ByteReader();
    const socket = net.connect({
      host: s.get("hostname"),
      port: s.int("port", 5900),
    });
    socket.setNoDelay(true);
    this.socket = socket;
    socket.setTimeout(15000, () => {
      if (!this.connected)
        socket.destroy(
          Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        );
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.socket === socket) this.reader.push(chunk);
    });
    let reached = false;
    socket.on("error", (error) => {
      if (!reached) this.ended(error);
      else this.reader.close(error);
    });
    socket.on("close", () => this.reader.close(new Error("closed")));
    socket.once("connect", () => {
      reached = true;
      this.run(socket).catch((error) => this.ended(error));
    });
  }

  private write(data: Buffer | Uint8Array): void {
    this.socket?.write(data);
  }

  private ended(error: unknown): void {
    if (this.stopped) return;
    const err = error as NodeJS.ErrnoException;
    if (this.connected) {
      if (err instanceof VncError) this.host.fail(err.message, err.status);
      else if (err.message === "closed") this.host.closed();
      else {
        this.host.log("warn", "VNC connection error", { error: err.message });
        this.host.fail("The VNC connection failed", Status.UPSTREAM_ERROR);
      }
      return;
    }
    const retries = this.host.settings.int("autoretry", 0);
    if (
      !(err instanceof VncError && err.status === Status.CLIENT_UNAUTHORIZED) &&
      this.attempts < retries
    ) {
      this.attempts++;
      this.socket?.destroy();
      setTimeout(() => !this.stopped && this.connect(), 1000);
      return;
    }
    if (err instanceof VncError) {
      this.host.fail(err.message, err.status);
    } else if (err.code === "ETIMEDOUT" || err.message === "timeout") {
      this.host.fail("The VNC server did not answer", Status.UPSTREAM_TIMEOUT);
    } else if (
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.code === "EHOSTUNREACH"
    ) {
      this.host.fail(
        "Could not reach the VNC server",
        Status.UPSTREAM_NOT_FOUND,
      );
    } else {
      this.host.log("warn", "VNC handshake failed", { error: err.message });
      this.host.fail(
        "The VNC server closed the connection",
        Status.UPSTREAM_ERROR,
      );
    }
  }

  private async run(socket: net.Socket): Promise<void> {
    const s = this.host.settings;
    const destHost = s.get("dest-host");
    if (destHost) {
      // UltraVNC repeater: the target as a 250 byte string first.
      const id = Buffer.alloc(250);
      id.write(`${destHost}:${s.int("dest-port", 5900)}`, "latin1");
      this.write(id);
    }
    const username = s.get("username");
    const password = s.get("password");
    const { minor, reply } = chooseVersion(
      (await this.reader.bytes(12)).toString("latin1"),
    );
    this.write(Buffer.from(reply, "latin1"));
    await this.security(minor, username, password);

    this.write(Buffer.from([1])); // shared
    const width = await this.reader.u16();
    const height = await this.reader.u16();
    await this.reader.bytes(16);
    const nameLength = await this.reader.u32();
    await this.reader.bytes(nameLength);

    this.connected = true;
    socket.setTimeout(0);
    this.setSize(width, height);
    this.host.display.setSource(this.pixels());
    this.sendPixelFormat();
    const localCursor = s.get("cursor", "remote") === "local";
    const quality = this.host.display.lossless ? 9 : 6;
    const encodings = encodingList(s.get("encodings"), localCursor, quality);
    this.write(
      Buffer.concat([
        Buffer.from([2, 0]),
        u16(encodings.length),
        ...encodings.map((n) => u32(n)),
      ]),
    );
    this.requestUpdate(false);
    this.host.ready();
    await this.loop();
  }

  private async security(
    minor: number,
    username: string,
    password: string,
  ): Promise<void> {
    let type: number;
    if (minor === 3) {
      type = await this.reader.u32();
      if (type === 0)
        throw new VncError(await this.reason(), Status.UPSTREAM_ERROR);
    } else {
      const count = await this.reader.u8();
      if (count === 0)
        throw new VncError(await this.reason(), Status.UPSTREAM_ERROR);
      const offered = [...(await this.reader.bytes(count))];
      const chosen = chooseSecurity(offered, username, password);
      if (chosen === null) {
        throw new VncError(
          "The VNC server offers no login this client supports",
          Status.UPSTREAM_ERROR,
        );
      }
      type = chosen;
      this.write(Buffer.from([type]));
    }
    await this.authenticate(type, minor, username, password);
  }

  private async authenticate(
    type: number,
    minor: number,
    username: string,
    password: string,
  ) {
    switch (type) {
      case SEC_NONE:
        if (minor === 8) await this.result(minor);
        return;
      case SEC_VNC:
        await this.vncAuth(password);
        await this.result(minor);
        return;
      case SEC_ARD: {
        const generator = await this.reader.bytes(2);
        const keyLength = await this.reader.u16();
        const prime = Buffer.from(await this.reader.bytes(keyLength));
        const serverKey = Buffer.from(await this.reader.bytes(keyLength));
        this.write(
          ardResponse(
            Buffer.from(generator),
            prime,
            serverKey,
            username,
            password,
          ),
        );
        await this.result(minor);
        return;
      }
      case SEC_TIGHT:
        await this.tightSecurity(minor, password);
        return;
      case SEC_MSLOGON: {
        const generator = Buffer.from(await this.reader.bytes(8));
        const modulus = Buffer.from(await this.reader.bytes(8));
        const serverKey = Buffer.from(await this.reader.bytes(8));
        this.write(
          msLogonResponse(generator, modulus, serverKey, username, password),
        );
        await this.result(minor);
        return;
      }
      case SEC_VENCRYPT:
        await this.vencrypt(minor, username, password);
        return;
      default:
        throw new VncError(
          `Unsupported VNC security type ${type}`,
          Status.UPSTREAM_ERROR,
        );
    }
  }

  private async vncAuth(password: string) {
    if (!password)
      throw new VncError(
        "The VNC server needs a password",
        Status.CLIENT_UNAUTHORIZED,
      );
    const challenge = await this.reader.bytes(16);
    this.write(vncAuthResponse(password, challenge));
  }

  private async tightSecurity(minor: number, password: string) {
    const tunnels = await this.reader.u32();
    if (tunnels > 0) {
      await this.reader.bytes(tunnels * 16);
      this.write(u32(0));
    }
    const auths = await this.reader.u32();
    if (auths === 0) {
      if (minor === 8) await this.result(minor);
      return;
    }
    const codes: number[] = [];
    for (let i = 0; i < auths; i++) {
      codes.push((await this.reader.bytes(16)).readUInt32BE(0));
    }
    const code =
      codes.includes(SEC_VNC) && password
        ? SEC_VNC
        : codes.includes(SEC_NONE)
          ? SEC_NONE
          : null;
    if (code === null)
      throw new VncError(
        "Unsupported Tight authentication",
        Status.UPSTREAM_ERROR,
      );
    this.write(u32(code));
    if (code === SEC_VNC) await this.vncAuth(password);
    await this.result(minor);
  }

  private async vencrypt(minor: number, username: string, password: string) {
    const major = await this.reader.u8();
    const sub = await this.reader.u8();
    if (major !== 0 || sub < 2) {
      throw new VncError("Unsupported VeNCrypt version", Status.UPSTREAM_ERROR);
    }
    this.write(Buffer.from([0, 2]));
    if ((await this.reader.u8()) !== 0) {
      throw new VncError("The server refused VeNCrypt", Status.UPSTREAM_ERROR);
    }
    const count = await this.reader.u8();
    const offered: number[] = [];
    for (let i = 0; i < count; i++) offered.push(await this.reader.u32());
    const chosen = chooseVencrypt(offered, username);
    if (chosen === null)
      throw new VncError("No VeNCrypt type in common", Status.UPSTREAM_ERROR);
    this.write(u32(chosen));
    if ((await this.reader.u8()) !== 1) {
      throw new VncError(
        "The server refused the VeNCrypt type",
        Status.UPSTREAM_ERROR,
      );
    }
    if (chosen !== VC_PLAIN) await this.startTls(chosen >= VC_X509_NONE);
    switch (chosen) {
      case VC_PLAIN:
      case VC_TLS_PLAIN:
      case VC_X509_PLAIN:
        this.write(plainCredentials(username, password));
        break;
      case VC_TLS_VNC:
      case VC_X509_VNC:
        await this.vncAuth(password);
        break;
      default:
        break;
    }
    await this.result(minor);
  }

  private async startTls(x509: boolean): Promise<void> {
    const raw = this.socket as net.Socket;
    const rest = this.reader.takeAll();
    if (rest.length > 0)
      throw new VncError("Unexpected data before TLS", Status.UPSTREAM_ERROR);
    raw.removeAllListeners("data");
    this.reader = new ByteReader();
    const hostname = this.host.settings.get("hostname");
    const secure = tls.connect({
      socket: raw,
      rejectUnauthorized: false,
      ...(net.isIP(hostname) ? {} : { servername: hostname }),
      // TLSNone/TLSVnc/TLSPlain are anonymous Diffie-Hellman.
      ...(x509
        ? {}
        : { ciphers: "aNULL:ADH:@SECLEVEL=0", maxVersion: "TLSv1.2" as const }),
    });
    this.socket = secure;
    secure.on("data", (chunk: Buffer) => this.reader.push(chunk));
    secure.on("error", (error) => this.reader.close(error));
    secure.on("close", () => this.reader.close(new Error("closed")));
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", (error) =>
        reject(
          new VncError(`TLS failed: ${error.message}`, Status.UPSTREAM_ERROR),
        ),
      );
    });
  }

  private async result(minor: number): Promise<void> {
    const status = await this.reader.u32();
    if (status === 0) return;
    const message = minor === 8 ? await this.reason() : "Authentication failed";
    throw new VncError(
      message || "Authentication failed",
      Status.CLIENT_UNAUTHORIZED,
    );
  }

  private async reason(): Promise<string> {
    const length = await this.reader.u32();
    return (await this.reader.bytes(Math.min(length, 4096))).toString("utf8");
  }

  private sendPixelFormat(): void {
    const spec = pixelFormatFor(
      this.host.settings.int("color-depth", 24),
      this.host.settings.bool("swap-red-blue"),
    );
    this.format = spec.format;
    this.write(spec.message);
  }

  private requestUpdate(incremental: boolean): void {
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(this.width, 6);
    b.writeUInt16BE(this.height, 8);
    this.write(b);
  }

  private setSize(width: number, height: number): void {
    if (!this.surface) this.surface = new this.host.wasm.Surface(width, height);
    else this.surface.resize(width, height);
    this.width = width;
    this.height = height;
    this.host.display.resize(width, height);
  }

  private streams(): TightState {
    this.tight ??= {
      streams: [0, 1, 2, 3].map(() => this.inflater()),
    };
    return this.tight;
  }

  private inflater(): InflateStream {
    const wasm = this.host.wasm;
    let inner = new wasm.Inflater();
    return {
      inflate: (input, expected) => inner.inflate(input, expected),
      reset: () => {
        inner.free();
        inner = new wasm.Inflater();
      },
    };
  }

  private async loop(): Promise<void> {
    const r = this.reader;
    for (;;) {
      const type = await r.u8();
      switch (type) {
        case 0:
          await this.update();
          this.requestUpdate(true);
          break;
        case 1: {
          await r.bytes(3);
          const count = await r.u16();
          await r.bytes(count * 6);
          break;
        }
        case 2:
          break;
        case 3:
          await this.serverCutText();
          break;
        case 150:
          break;
        case 248: {
          await r.bytes(3);
          const flags = await r.u32();
          const length = await r.u8();
          const payload = await r.bytes(length);
          // Answer the fence with the request bit cleared.
          this.write(
            Buffer.concat([
              Buffer.from([248, 0, 0, 0]),
              u32(flags & ~0x80000000),
              Buffer.from([length]),
              payload,
            ]),
          );
          break;
        }
        default:
          throw new VncError(
            `Unknown VNC message ${type}`,
            Status.UPSTREAM_ERROR,
          );
      }
    }
  }

  private async update(): Promise<void> {
    const r = this.reader;
    await r.u8();
    const count = await r.u16();
    const display = this.host.display;
    for (let i = 0; i < count; i++) {
      const rect = {
        x: await r.u16(),
        y: await r.u16(),
        w: await r.u16(),
        h: await r.u16(),
      };
      const encoding = await r.s32();
      switch (encoding) {
        case ENC.RAW:
          await decodeRaw(r, this, rect, this.format);
          display.damage(rect);
          break;
        case ENC.COPYRECT: {
          const { sx, sy } = await decodeCopyRect(r, this, rect);
          display.copy({ x: sx, y: sy, w: rect.w, h: rect.h }, rect.x, rect.y);
          break;
        }
        case ENC.RRE:
          await decodeRre(r, this, rect, this.format);
          display.damage(rect);
          break;
        case ENC.HEXTILE:
          await decodeHextile(r, this, rect, this.format);
          display.damage(rect);
          break;
        case ENC.ZRLE:
          this.zrle ??= this.inflater();
          await decodeZrle(r, this, rect, this.zrle, this.format);
          display.damage(rect);
          break;
        case ENC.TIGHT:
          await decodeTight(r, this, rect, this.streams(), this.format);
          display.damage(rect);
          break;
        case ENC.CURSOR: {
          if (rect.w === 0 || rect.h === 0) {
            await decodeCursor(r, rect, this.format);
            display.cursorHidden();
            break;
          }
          const rgba = await decodeCursor(r, rect, this.format);
          display.setCursor({
            width: rect.w,
            height: rect.h,
            hotspotX: rect.x,
            hotspotY: rect.y,
            rgba,
          });
          break;
        }
        case ENC.DESKTOP_SIZE:
          this.setSize(rect.w, rect.h);
          break;
        case ENC.EXTENDED_DESKTOP_SIZE: {
          const screens = await r.u8();
          await r.bytes(3);
          const data = await r.bytes(screens * 16);
          this.extendedDesktop = true;
          if (screens > 0) this.screenId = data.readUInt32BE(0);
          // y carries the status; a refused resize keeps the old size.
          if (rect.x !== 1 || rect.y === 0) this.setSize(rect.w, rect.h);
          const pending = this.pendingResize;
          if (
            pending &&
            rect.x === 0 &&
            (pending.width !== this.width || pending.height !== this.height)
          ) {
            this.sendDesktopSize();
          }
          break;
        }
        case ENC.LAST_RECT:
          return;
        default:
          throw new VncError(
            `The VNC server sent encoding ${encoding}`,
            Status.UPSTREAM_ERROR,
          );
      }
    }
  }

  private async serverCutText(): Promise<void> {
    const r = this.reader;
    await r.bytes(3);
    const length = await r.s32();
    if (length >= 0) {
      const text = decodeText(
        await r.bytes(Math.min(length, 16 * 1024 * 1024)),
        this.host.settings.get("clipboard-encoding", "ISO8859-1"),
      );
      this.host.clipboard(text);
      return;
    }
    const payload = await r.bytes(-length);
    const flags = payload.readUInt32BE(0);
    if (flags & CLIP_CAPS) {
      this.extendedClipboard = true;
      // Say what this client does: text, and every action but peek.
      this.writeExtended(
        CLIP_CAPS |
          CLIP_TEXT |
          CLIP_REQUEST |
          CLIP_NOTIFY |
          CLIP_PROVIDE |
          CLIP_PEEK,
        u32(1024 * 1024),
      );
      return;
    }
    if (flags & CLIP_NOTIFY && flags & CLIP_TEXT) {
      this.writeExtended(CLIP_REQUEST | CLIP_TEXT, Buffer.alloc(0));
      return;
    }
    if (flags & (CLIP_REQUEST | CLIP_PEEK)) {
      if (flags & CLIP_REQUEST && flags & CLIP_TEXT)
        this.provideText(this.clipboardText);
      else
        this.writeExtended(
          CLIP_NOTIFY | (this.clipboardText ? CLIP_TEXT : 0),
          Buffer.alloc(0),
        );
      return;
    }
    if (flags & CLIP_PROVIDE && flags & CLIP_TEXT) {
      try {
        const data = zlib.inflateSync(payload.subarray(4));
        const size = data.readUInt32BE(0);
        const text = data
          .subarray(4, 4 + size)
          .toString("utf8")
          .replace(/\0+$/, "");
        this.host.clipboard(text.replace(/\r\n/g, "\n"));
      } catch {
        // A bad payload only loses this one copy.
      }
    }
  }

  private writeExtended(flags: number, data: Buffer): void {
    const length = 4 + data.length;
    this.write(
      Buffer.concat([
        Buffer.from([6, 0, 0, 0]),
        u32(-length),
        u32(flags),
        data,
      ]),
    );
  }

  private provideText(text: string): void {
    const bytes = Buffer.from(`${text.replace(/\r?\n/g, "\r\n")}\0`, "utf8");
    const data = zlib.deflateSync(Buffer.concat([u32(bytes.length), bytes]));
    this.writeExtended(CLIP_PROVIDE | CLIP_TEXT, data);
  }

  private sendDesktopSize(): void {
    const size = this.pendingResize;
    if (!size) return;
    this.pendingResize = null;
    const b = Buffer.alloc(24);
    b[0] = 251;
    b.writeUInt16BE(size.width, 2);
    b.writeUInt16BE(size.height, 4);
    b[6] = 1;
    b.writeUInt32BE(this.screenId, 8);
    b.writeUInt16BE(size.width, 16);
    b.writeUInt16BE(size.height, 18);
    this.write(b);
  }

  // Framebuffer

  view(): Uint8Array {
    return surfaceView(this.host.wasm, this.surface!);
  }

  copy(
    sx: number,
    sy: number,
    w: number,
    h: number,
    dx: number,
    dy: number,
  ): void {
    this.surface?.copy_rect(sx, sy, w, h, dx, dy);
  }

  jpeg(x: number, y: number, data: Uint8Array): boolean {
    return (
      !!this.surface &&
      this.host.wasm.decode_jpeg_into(this.surface, x, y, data)
    );
  }

  /** What the display encodes from. */
  private pixels(): PixelSource {
    const client = this;
    return {
      get width() {
        return client.width;
      },
      get height() {
        return client.height;
      },
      png: (x, y, w, h) =>
        client.surface?.encode_png(x, y, w, h, false) ?? new Uint8Array(),
      jpeg: (x, y, w, h, q) =>
        client.surface?.encode_jpeg(x, y, w, h, q) ?? new Uint8Array(),
    };
  }

  // RemoteClient

  mouse(x: number, y: number, mask: number): void {
    if (!this.connected || this.readOnly) return;
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask & 0xff;
    b.writeUInt16BE(Math.max(0, Math.min(this.width - 1, x)), 2);
    b.writeUInt16BE(Math.max(0, Math.min(this.height - 1, y)), 4);
    this.write(b);
  }

  key(keysym: number, pressed: boolean): void {
    if (!this.connected || this.readOnly) return;
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = pressed ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.write(b);
  }

  resize(width: number, height: number): void {
    if (this.readOnly || width <= 0 || height <= 0) return;
    if (width === this.width && height === this.height) {
      this.pendingResize = null;
      return;
    }
    this.pendingResize = { width, height };
    // Before the server says it can resize, the size waits for that.
    if (this.connected && this.extendedDesktop) this.sendDesktopSize();
  }

  clipboard(text: string): void {
    this.clipboardText = text;
    if (!this.connected || this.readOnly) return;
    if (this.extendedClipboard) {
      this.writeExtended(CLIP_NOTIFY | CLIP_TEXT, Buffer.alloc(0));
      return;
    }
    const bytes = encodeText(
      text.replace(/\r?\n/g, "\n"),
      this.host.settings.get("clipboard-encoding", "ISO8859-1"),
    );
    this.write(
      Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(bytes.length), bytes]),
    );
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    this.reader.close(new Error("closed"));
    this.surface?.free();
    this.surface = null;
  }
}
