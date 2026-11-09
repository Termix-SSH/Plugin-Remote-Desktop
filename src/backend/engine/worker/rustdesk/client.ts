import { decompress } from "fzstd";
import { OpusDecoder } from "opus-decoder";
import { encode, Status } from "../../protocol.js";
import type { CursorImage } from "../cursor.js";
import type { RemoteClient, RemoteHost } from "../remote.js";
import { PbMessage } from "./pb.js";
import {
  MISC,
  MSG,
  auth2fa,
  clipboardText,
  keyEvent,
  loginRequest,
  mouseEvent,
  readCursorData,
  readPeerInfo,
  readSwitchDisplay,
  readVideoFrame,
  refreshVideo,
  switchDisplay,
  type Decodings,
  type DisplayInfo,
  type VideoCodec,
} from "./messages.js";
import {
  CLIENT_VERSION,
  DIRECT_PORT,
  RustDeskError,
  directRoute,
  passwordHash,
  relayRoute,
  secure,
  type Route,
} from "./handshake.js";
import { CK, Modifiers, keysymTarget, mouseActions } from "./input.js";
import type { Connection, Dialer } from "./transport.js";

/** Error messages the browser turns into a password or 2FA prompt. */
export const LOGIN_ERRORS = {
  passwordRequired: "rustdesk-password-required",
  passwordWrong: "rustdesk-password-wrong",
  codeRequired: "rustdesk-2fa-required",
  codeWrong: "rustdesk-2fa-wrong",
} as const;

/** The argv name the monitor list and monitor choice travel under. */
export const DISPLAYS_ARGUMENT = "rustdesk-display";

export const VIDEO_MIMETYPE = "video/x-termix-rustdesk";

/** Frame chunk flags, the first byte of every video blob. */
export const FRAME_KEY = 1;
export const FRAME_END = 2;

const CHUNK = 192 * 1024;
const LOGIN_TIMEOUT_MS = 120_000;
const REFRESH_GAP_MS = 1000;
const MAX_CURSORS = 64;

export function parseDecodings(value: string): Decodings {
  const list = value.toLowerCase().split(/[\s,]+/);
  const out = {
    vp9: list.includes("vp9"),
    vp8: list.includes("vp8"),
    av1: list.includes("av1"),
  };
  // Every RustDesk peer can send VP9; a browser that said nothing gets it.
  if (!out.vp9 && !out.vp8 && !out.av1) out.vp9 = true;
  return out;
}

/** Splits one encoded frame into blobs: a flag byte, then the data. */
export function frameChunks(data: Uint8Array, key: boolean): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length || offset === 0;) {
    const end = Math.min(data.length, offset + CHUNK);
    const last = end >= data.length;
    const flags = (key ? FRAME_KEY : 0) | (last ? FRAME_END : 0);
    out.push(Buffer.concat([Buffer.from([flags]), data.subarray(offset, end)]));
    if (last) break;
    offset = end;
  }
  return out;
}

/** Planar float audio to interleaved 16 bit little endian. */
export function toPcm16(channels: Float32Array[], samples: number): Buffer {
  const out = Buffer.alloc(samples * channels.length * 2);
  let i = 0;
  for (let s = 0; s < samples; s++) {
    for (const channel of channels) {
      const v = Math.max(-1, Math.min(1, channel[s] ?? 0));
      out.writeInt16LE(Math.round(v * 32767), i);
      i += 2;
    }
  }
  return out;
}

export interface RustDeskDeps {
  dial?: Dialer;
}

/**
 * A RustDesk session. The peer's video stays encoded: it goes to the
 * browser as a Guacamole video stream and WebCodecs decodes it there.
 */
export class RustDeskClient implements RemoteClient {
  private conn: Connection | null = null;
  private stopped = false;
  private loggedIn = false;
  private codeSent = false;
  private loginTimer: NodeJS.Timeout | null = null;
  private displays: DisplayInfo[] = [];
  private current = 0;
  private cursorEmbedded = false;
  private video: { index: number; mimetype: string } | null = null;
  private waitingForKey = true;
  private lastRefresh = 0;
  private readonly cursors = new Map<bigint, CursorImage>();
  private readonly modifiers = new Modifiers();
  private lastMouse = { x: -1, y: -1, mask: 0 };
  private audio: {
    decoder: OpusDecoder;
    channels: number;
    ready: boolean;
  } | null = null;

  constructor(
    private readonly host: RemoteHost,
    private readonly deps: RustDeskDeps = {},
  ) {}

  start(): void {
    void this.run().catch((error) => {
      if (this.stopped) return;
      const status =
        error instanceof RustDeskError ? error.status : Status.UPSTREAM_ERROR;
      const message = error instanceof Error ? error.message : String(error);
      this.host.log("warn", "RustDesk connection failed", { error: message });
      this.abort(message, status);
    });
  }

  private async run(): Promise<void> {
    const s = this.host.settings;
    const peerId = s.get("rustdesk-id").replace(/\s+/g, "");
    const direct = s.bool("direct");
    if (!direct && !peerId) {
      throw new RustDeskError(
        "This host has no RustDesk ID",
        Status.CLIENT_BAD_REQUEST,
      );
    }
    const idServer = s.get("id-server");
    const key = s.get("server-key");
    const route: Route = direct
      ? await directRoute(
          s.get("hostname"),
          s.int("port", DIRECT_PORT),
          this.deps.dial,
        )
      : await relayRoute({
          peerId,
          idServer,
          relayServer: s.get("relay-server"),
          key,
          dial: this.deps.dial,
        });
    this.conn = route.conn;
    if (this.stopped) {
      route.conn.close();
      return;
    }
    await secure(route.conn, peerId, route, { key, direct, idServer });
    this.host.log("debug", "RustDesk session secured", { direct });
    this.loginTimer = setTimeout(() => {
      if (this.loggedIn || this.stopped) return;
      this.abort(
        "The remote device did not accept the session in time",
        Status.UPSTREAM_TIMEOUT,
      );
    }, LOGIN_TIMEOUT_MS);
    route.conn.onClose((error) => {
      if (this.stopped) return;
      if (this.loggedIn) this.host.closed();
      else {
        this.abort(
          error?.message || "The remote device closed the connection",
          Status.UPSTREAM_ERROR,
        );
      }
    });
    route.conn.onFrame((frame) => {
      try {
        this.receive(frame, peerId);
      } catch (error) {
        this.host.log("warn", "Bad RustDesk message", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /** Ends the session with an error, once. */
  private abort(message: string, status: number): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.host.fail(message, status);
    this.conn?.close();
  }

  private send(data: Uint8Array): void {
    this.conn?.send(data);
  }

  private receive(frame: Uint8Array, peerId: string): void {
    if (frame.length === 0) return;
    const m = PbMessage.decode(frame);
    const field = m.which(Object.values(MSG));
    switch (field) {
      case MSG.hash: {
        const hash = m.message(MSG.hash)!;
        this.login(peerId, hash.string(1), hash.string(2));
        break;
      }
      case MSG.loginResponse:
        this.loginResponse(m.message(MSG.loginResponse)!);
        break;
      case MSG.peerInfo:
        this.peerInfo(m.message(MSG.peerInfo)!);
        break;
      case MSG.testDelay:
        // The peer measures latency; echo its own probes back unchanged.
        if (!m.message(MSG.testDelay)!.bool(2)) this.send(frame);
        break;
      case MSG.videoFrame:
        this.videoFrame(m.message(MSG.videoFrame)!);
        break;
      case MSG.cursorData:
        this.cursorData(m.message(MSG.cursorData)!);
        break;
      case MSG.cursorId: {
        const image = this.cursors.get(m.big(MSG.cursorId));
        if (image && !this.cursorEmbedded) this.host.display.setCursor(image);
        break;
      }
      case MSG.clipboard:
        this.clipboardIn([m.message(MSG.clipboard)!]);
        break;
      case MSG.multiClipboards:
        this.clipboardIn(m.message(MSG.multiClipboards)!.messages(1));
        break;
      case MSG.audioFrame:
        this.audioFrame(m.message(MSG.audioFrame)!.bytes(1));
        break;
      case MSG.misc:
        this.misc(m.message(MSG.misc)!);
        break;
      case MSG.messageBox: {
        const box = m.message(MSG.messageBox)!;
        this.host.log("info", "RustDesk message", {
          type: box.string(1),
          title: box.string(2),
          text: box.string(3),
        });
        break;
      }
      default:
        break;
    }
  }

  private login(peerId: string, salt: string, challenge: string): void {
    if (this.loggedIn) return;
    const s = this.host.settings;
    this.send(
      loginRequest({
        peerId,
        password: passwordHash(s.get("password"), salt, challenge),
        myId: "termix",
        myName: s.get("client-name", "Termix"),
        version: CLIENT_VERSION,
        decodings: parseDecodings(s.get("codecs")),
        prefer: (s.get("prefer-codec") as VideoCodec) || null,
        disableAudio: s.bool("disable-audio"),
        disableClipboard: s.bool("disable-copy") && s.bool("disable-paste"),
        viewOnly: s.bool("read-only"),
      }),
    );
  }

  private loginResponse(lr: PbMessage): void {
    const error = lr.string(1);
    if (lr.has(2)) {
      this.peerInfo(lr.message(2)!);
      return;
    }
    if (!error) return;
    const s = this.host.settings;
    if (error === "2FA Required" && s.has("code") && !this.codeSent) {
      this.codeSent = true;
      this.send(auth2fa(s.get("code").replace(/\s+/g, "")));
      return;
    }
    const mapped: Record<string, string> = {
      "Password Required": LOGIN_ERRORS.passwordRequired,
      "Wrong Password": s.has("password")
        ? LOGIN_ERRORS.passwordWrong
        : LOGIN_ERRORS.passwordRequired,
      "No Password Access": LOGIN_ERRORS.passwordRequired,
      "2FA Required": LOGIN_ERRORS.codeRequired,
      "Wrong 2FA Code": LOGIN_ERRORS.codeWrong,
    };
    const message = mapped[error];
    this.abort(
      message ?? error,
      message ? Status.CLIENT_UNAUTHORIZED : Status.UPSTREAM_ERROR,
    );
  }

  private peerInfo(pi: PbMessage): void {
    const info = readPeerInfo(pi);
    this.displays = info.displays;
    this.current = Math.min(
      Math.max(0, info.currentDisplay),
      Math.max(0, info.displays.length - 1),
    );
    const display = this.displays[this.current];
    if (display) this.useDisplay(display.width, display.height, display);
    if (!this.loggedIn) {
      this.loggedIn = true;
      if (this.loginTimer) clearTimeout(this.loginTimer);
      this.host.log("info", "RustDesk session started", {
        platform: info.platform,
        version: info.version,
        displays: info.displays.length,
      });
      this.host.display.cursorDefault();
      this.host.ready();
      this.out(this.displaysInstruction());
    }
  }

  private useDisplay(
    width: number,
    height: number,
    info: { cursorEmbedded: boolean },
  ): void {
    this.cursorEmbedded = info.cursorEmbedded;
    if (width > 0 && height > 0) this.host.display.resize(width, height);
    if (this.cursorEmbedded) this.host.display.cursorDot();
    this.waitingForKey = true;
  }

  /** Tells the browser which monitors there are, for the toolbar picker. */
  private displaysInstruction(): string {
    const list = this.displays.map((d, i) => ({
      index: i,
      name: d.name,
      width: d.width,
      height: d.height,
    }));
    const out = this.host.out;
    const stream = out.openStream();
    const json = JSON.stringify({ current: this.current, list });
    const data =
      encode("argv", stream, "application/json", DISPLAYS_ARGUMENT) +
      encode("blob", stream, Buffer.from(json, "utf8").toString("base64")) +
      encode("end", stream);
    out.closeStream(stream);
    return data;
  }

  private out(data: string): void {
    this.host.out.raw(data);
  }

  private requestKeyFrame(): void {
    const now = Date.now();
    if (now - this.lastRefresh < REFRESH_GAP_MS) return;
    this.lastRefresh = now;
    this.send(refreshVideo());
  }

  private videoFrame(m: PbMessage): void {
    const vf = readVideoFrame(m);
    if (vf.display !== this.current) return;
    if (vf.codec === "other" || vf.codec === "h264" || vf.codec === "h265") {
      this.abort(
        "The remote device sent video this browser can not show",
        Status.UNSUPPORTED,
      );
      return;
    }
    const mimetype = `${VIDEO_MIMETYPE};codec=${vf.codec}`;
    const out = this.host.out;
    if (this.video?.mimetype !== mimetype) {
      if (this.video) {
        out.send("end", this.video.index);
        out.closeStream(this.video.index);
      }
      this.video = { index: out.openStream(), mimetype };
      out.send("video", this.video.index, 0, mimetype);
      this.waitingForKey = true;
    }
    const display = this.host.display;
    for (const frame of vf.frames) {
      // A lagging browser skips ahead to the next key frame.
      if (!frame.key && (this.waitingForKey || display.behind())) {
        if (!this.waitingForKey) this.waitingForKey = true;
        if (!display.behind()) this.requestKeyFrame();
        continue;
      }
      if (frame.key) this.waitingForKey = false;
      for (const chunk of frameChunks(frame.data, frame.key)) {
        out.send("blob", this.video.index, chunk.toString("base64"));
      }
      display.frame();
    }
    out.flush();
  }

  private cursorData(m: PbMessage): void {
    const cd = readCursorData(m);
    if (cd.width <= 0 || cd.height <= 0 || cd.width * cd.height > 1 << 20) {
      return;
    }
    let rgba: Uint8Array;
    try {
      rgba = decompress(cd.colors);
    } catch {
      return;
    }
    if (rgba.length !== cd.width * cd.height * 4) return;
    const image: CursorImage = {
      width: cd.width,
      height: cd.height,
      hotspotX: Math.max(0, Math.min(cd.width - 1, cd.hotx)),
      hotspotY: Math.max(0, Math.min(cd.height - 1, cd.hoty)),
      rgba,
    };
    if (this.cursors.size >= MAX_CURSORS) {
      const oldest = this.cursors.keys().next().value;
      if (oldest !== undefined) this.cursors.delete(oldest);
    }
    this.cursors.set(cd.id, image);
    if (!this.cursorEmbedded) this.host.display.setCursor(image);
  }

  private clipboardIn(list: PbMessage[]): void {
    for (const cb of list) {
      // Format 0 is text; images and files are left out.
      if (cb.int(5) !== 0) continue;
      let content = cb.bytes(2);
      if (cb.bool(1)) {
        try {
          content = decompress(content);
        } catch {
          continue;
        }
      }
      this.host.clipboard(Buffer.from(content).toString("utf8"));
      return;
    }
  }

  private misc(m: PbMessage): void {
    if (m.has(MISC.switchDisplay)) {
      const sd = readSwitchDisplay(m.message(MISC.switchDisplay)!);
      this.current = sd.display;
      const known = this.displays[sd.display];
      if (known) {
        known.width = sd.width;
        known.height = sd.height;
      }
      this.useDisplay(sd.width, sd.height, sd);
      this.out(this.displaysInstruction());
      return;
    }
    if (m.has(MISC.audioFormat)) {
      const format = m.message(MISC.audioFormat)!;
      this.startAudio(format.uint(2) || 2);
      return;
    }
    if (m.has(MISC.closeReason)) {
      const reason = m.string(MISC.closeReason);
      this.abort(
        reason || "The remote device ended the session",
        Status.SESSION_CLOSED,
      );
    }
  }

  private startAudio(channels: number): void {
    if (this.host.settings.bool("disable-audio")) return;
    if (this.audio?.channels === channels) return;
    this.audio?.decoder.free();
    const decoder = new OpusDecoder({ channels: Math.min(2, channels) });
    const audio = { decoder, channels, ready: false };
    this.audio = audio;
    void decoder.ready.then(() => {
      audio.ready = true;
    });
  }

  private audioFrame(data: Uint8Array): void {
    const audio = this.audio;
    if (!audio?.ready || data.length === 0) return;
    const decoded = audio.decoder.decodeFrame(data);
    if (decoded.samplesDecoded === 0) return;
    this.host.audio(
      decoded.sampleRate,
      decoded.channelData.length,
      toPcm16(decoded.channelData, decoded.samplesDecoded),
    );
  }

  // RemoteClient

  /** A viewer joining late needs the video stream and a key frame. */
  joined(): string {
    this.requestKeyFrame();
    let data = this.displaysInstruction();
    if (this.video) {
      data += encode("video", this.video.index, 0, this.video.mimetype);
    }
    return data;
  }

  mouse(x: number, y: number, mask: number): void {
    if (!this.loggedIn) return;
    const origin = this.displays[this.current] ?? { x: 0, y: 0 };
    const moved = x !== this.lastMouse.x || y !== this.lastMouse.y;
    const actions = mouseActions(this.lastMouse.mask, mask, x, y, moved);
    this.lastMouse = { x, y, mask };
    const modifiers = this.modifiers.list();
    for (const a of actions) {
      const wheel = (a.mask & 7) === 3;
      this.send(
        mouseEvent(
          a.mask,
          wheel ? a.x : a.x + origin.x,
          wheel ? a.y : a.y + origin.y,
          modifiers,
        ),
      );
    }
  }

  key(keysym: number, pressed: boolean): void {
    if (!this.loggedIn) return;
    let target = keysymTarget(keysym);
    if (!target) return;
    const held = this.modifiers.list();
    if (
      pressed &&
      "controlKey" in target &&
      target.controlKey === CK.Delete &&
      (held.includes(CK.Control) || held.includes(CK.RControl)) &&
      (held.includes(CK.Alt) || held.includes(CK.RAlt))
    ) {
      target = { controlKey: CK.CtrlAltDel };
      this.send(keyEvent(target, true, [], true));
      return;
    }
    this.modifiers.update(target, pressed);
    this.send(keyEvent(target, pressed, this.modifiers.list()));
  }

  /** The browser scales the picture; the remote resolution stays as is. */
  resize(): void {}

  clipboard(text: string): void {
    if (!this.loggedIn) return;
    this.send(clipboardText(text));
  }

  /** A value the browser set: the monitor picked in the toolbar. */
  argument(name: string, value: string): void {
    if (name !== DISPLAYS_ARGUMENT) return;
    const index = Number.parseInt(value, 10);
    if (!this.loggedIn || !(index >= 0 && index < this.displays.length)) {
      return;
    }
    this.send(switchDisplay(index));
  }

  stop(): void {
    this.stopped = true;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    if (this.loggedIn) {
      for (const key of this.modifiers.clear()) {
        this.send(keyEvent({ controlKey: key }, false, []));
      }
    }
    this.audio?.decoder.free();
    this.audio = null;
    this.conn?.close();
    this.conn = null;
  }
}
