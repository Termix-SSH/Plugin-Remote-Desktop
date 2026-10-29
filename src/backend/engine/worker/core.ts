import fs from "node:fs";
import path from "node:path";
import { encode, Status } from "../protocol.js";
import type { EngineConfig, LogLevel, Port, ToWorker } from "../messages.js";
import { Output } from "./output.js";
import { Display } from "./display.js";
import { DriveFolder, STREAM_INDEX_MIMETYPE } from "./filesystem.js";
import { Settings, type RemoteClient, type RemoteHost } from "./remote.js";
import type { Wasm } from "./wasm.js";
import { normalizeLineEndings, sendMagicPacket } from "./wol.js";

export type ClientFactory = (host: RemoteHost) => RemoteClient;

interface InboundStream {
  user: string;
  kind: "clipboard" | "upload";
  chunks: Buffer[];
  size: number;
  fd?: number;
  file?: string;
}

interface OutboundFile {
  user: string;
  size: number;
  offset: number;
  read(offset: number, length: number): Buffer;
  close?(): void;
}

function bufferFile(user: string, bytes: Buffer): OutboundFile {
  return {
    user,
    size: bytes.length,
    offset: 0,
    read: (offset, length) => bytes.subarray(offset, offset + length),
  };
}

/** Reads a drive file a blob at a time, so a large one never sits in memory. */
function diskFile(user: string, full: string): OutboundFile {
  const fd = fs.openSync(full, "r");
  return {
    user,
    size: fs.fstatSync(fd).size,
    offset: 0,
    read: (offset, length) => {
      const buffer = Buffer.alloc(length);
      const n = fs.readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, n);
    },
    close: () => fs.closeSync(fd),
  };
}

const FILESYSTEM_OBJECT = 1;
const BLOB_SIZE = 6048;
const CLIPBOARD_LIMIT = 256 * 1024;

/**
 * One remote desktop session inside its worker: the client for the
 * protocol, the display, and the streams every user opens.
 */
export class EngineCore implements RemoteHost {
  readonly out: Output;
  readonly display: Display;
  settings = new Settings({});
  drive: DriveFolder | null = null;
  private client: RemoteClient | null = null;
  private owner: string | null = null;
  private readonly users = new Map<string, { readOnly: boolean }>();
  private readonly inbound = new Map<string, InboundStream>();
  private readonly downloads = new Map<number, OutboundFile>();
  private audioStream: { index: number; mimetype: string } | null = null;
  private audioBytes = 0;
  private audioLoggedAt = 0;
  private isReady = false;
  private finished = false;
  private stopped = false;
  private disableCopy = false;
  private disablePaste = false;

  constructor(
    private readonly port: Port,
    readonly wasm: Wasm,
    private readonly factories: Record<string, ClientFactory>,
  ) {
    this.out = new Output(port);
    this.display = new Display(this.out, {
      rgbaPng: (rgba, w, h) => wasm.encode_rgba_png(rgba, w, h),
    });
  }

  handle(message: ToWorker): void {
    try {
      switch (message.t) {
        case "start":
          this.start(message.config);
          break;
        case "join":
          this.join(message.user, message.owner, message.readOnly);
          break;
        case "leave":
          this.leave(message.user);
          break;
        case "snapshot":
          this.out.flush();
          this.port.post({
            t: "snapshot",
            data: this.isReady ? this.display.snapshot() : "",
          });
          break;
        case "input":
          this.input(message.user, message.opcode, message.args);
          break;
        case "stop":
          this.stop();
          break;
      }
    } catch (error) {
      this.log("error", "Remote desktop engine error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (message.t === "start") {
        this.fail(
          error instanceof Error ? error.message : String(error),
          Status.SERVER_ERROR,
        );
      }
    }
  }

  private start(config: EngineConfig): void {
    this.settings = new Settings(config.settings);
    this.disableCopy = this.settings.bool("disable-copy");
    this.disablePaste = this.settings.bool("disable-paste");
    this.display.lossless = this.settings.bool("force-lossless");
    if (config.drivePath) {
      try {
        this.drive = new DriveFolder(config.drivePath);
      } catch (error) {
        this.log("warn", "Could not open the RDP drive folder", {
          path: config.drivePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const factory = this.factories[config.protocol];
    if (!factory) {
      this.fail(`Unsupported protocol ${config.protocol}`, Status.UNSUPPORTED);
      return;
    }
    if (this.settings.bool("wol-send-packet")) {
      void this.wakeThenStart(factory);
      return;
    }
    this.client = factory(this);
    this.client.start();
  }

  /** Sends the magic packet, waits wol-wait-time seconds, then connects. */
  private async wakeThenStart(factory: ClientFactory): Promise<void> {
    const s = this.settings!;
    try {
      await sendMagicPacket(
        s.get("wol-mac-addr"),
        s.get("wol-broadcast-addr", "255.255.255.255"),
        s.int("wol-udp-port", 9),
      );
    } catch (error) {
      this.log("warn", "Could not send the Wake-on-LAN packet", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const wait = Math.min(600, Math.max(0, s.int("wol-wait-time", 0)));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    if (this.stopped) return;
    this.client = factory(this);
    this.client.start();
  }

  private join(user: string, owner: boolean, readOnly: boolean): void {
    this.users.set(user, { readOnly });
    this.display.addUser(user);
    if (owner) this.owner = user;
    if (this.isReady && !owner) {
      this.out.to(user, this.display.snapshot());
    }
    if (this.isReady && owner && this.drive) {
      this.out.to(user, this.filesystemInstruction());
    }
  }

  private leave(user: string): void {
    this.users.delete(user);
    this.display.removeUser(user);
    for (const [key, stream] of this.inbound) {
      if (stream.user === user) this.closeInbound(key);
    }
    for (const [index, file] of this.downloads) {
      if (file.user === user) this.finishDownload(index, file);
    }
  }

  private input(user: string, opcode: string, args: string[]): void {
    const client = this.client;
    switch (opcode) {
      case "sync":
        this.display.ack(user, Number(args[0]));
        break;
      case "mouse": {
        const [x, y, mask] = args.map(Number);
        client?.mouse(x, y, mask);
        // Other users see the pointer move, as with guacd.
        this.out.except(user, "mouse", x, y, mask, Date.now());
        break;
      }
      case "key":
        client?.key(Number(args[0]), args[1] === "1");
        break;
      case "size":
        if (user === this.owner) {
          client?.resize(
            Number(args[0]),
            Number(args[1]),
            // guacamole-common-js sends no dpi; 0 keeps the session's.
            Number(args[2]) || 0,
          );
        }
        break;
      case "clipboard":
        this.openInbound(user, args[0], "clipboard");
        break;
      case "file":
        this.openUpload(user, args[0], args[2] ?? "upload");
        break;
      case "put":
        this.openUpload(user, args[1], args[3] ?? "upload");
        break;
      case "get":
        this.get(user, args[1] ?? "/");
        break;
      case "blob":
        this.blob(user, args[0], args[1] ?? "");
        break;
      case "end":
        this.endInbound(user, args[0]);
        break;
      case "ack":
        this.ack(Number(args[0]), Number(args[2]));
        break;
      default:
        break;
    }
  }

  private stop(): void {
    this.stopped = true;
    this.client?.stop();
    this.client = null;
    this.display.stop();
    for (const key of [...this.inbound.keys()]) this.closeInbound(key);
    for (const [index, file] of [...this.downloads]) {
      this.finishDownload(index, file);
    }
  }

  // RemoteHost

  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    this.port.post({ t: "log", level, message, meta });
  }

  ready(): void {
    if (this.isReady || this.finished) return;
    this.isReady = true;
    this.port.post({ t: "ready" });
    for (const [user] of this.users) {
      if (user !== this.owner) this.out.to(user, this.display.snapshot());
    }
    if (this.drive && this.owner) {
      this.out.to(this.owner, this.filesystemInstruction());
    }
  }

  fail(message: string, status: number): void {
    if (this.finished) return;
    this.finished = true;
    this.out.flush();
    this.port.post({ t: "error", message, status });
    this.stop();
  }

  closed(): void {
    if (this.finished) return;
    this.finished = true;
    this.out.flush();
    this.port.post({ t: "closed" });
    this.stop();
  }

  clipboard(text: string): void {
    if (this.disableCopy) return;
    text = normalizeLineEndings(
      text,
      this.settings?.get("normalize-clipboard") ?? "",
    );
    const stream = this.out.openStream();
    this.out.send("clipboard", stream, "text/plain");
    this.out.blobs(stream, Buffer.from(text, "utf8"));
    this.out.send("end", stream);
    this.out.closeStream(stream);
  }

  sendFile(name: string, mimetype: string, bytes: Uint8Array): void {
    if (!this.owner) return;
    const stream = this.out.openStream();
    this.downloads.set(stream, bufferFile(this.owner, Buffer.from(bytes)));
    this.out.to(this.owner, encode("file", stream, mimetype, name));
    // BlobReader acks each blob but not the stream itself.
    this.ack(stream, Status.SUCCESS);
  }

  audio(rate: number, channels: number, pcm: Uint8Array): void {
    const mimetype = `audio/L16;rate=${rate},channels=${channels}`;
    if (this.audioStream?.mimetype !== mimetype) {
      if (this.audioStream) {
        this.out.send("end", this.audioStream.index);
        this.out.closeStream(this.audioStream.index);
      }
      this.audioStream = { index: this.out.openStream(), mimetype };
      this.out.send("audio", this.audioStream.index, mimetype);
    }
    this.out.blobs(this.audioStream.index, pcm);
    this.audioBytes += pcm.length;
    const now = Date.now();
    if (now - this.audioLoggedAt >= 10_000) {
      this.audioLoggedAt = now;
      this.log("debug", "rdpsnd audio sent", { bytes: this.audioBytes });
    }
  }

  // Streams the clients open

  private key(user: string, index: string): string {
    return `${user}:${index}`;
  }

  private openInbound(user: string, index: string, kind: "clipboard"): void {
    this.inbound.set(this.key(user, index), {
      user,
      kind,
      chunks: [],
      size: 0,
    });
    this.out.to(user, encode("ack", index, "OK", Status.SUCCESS));
  }

  private openUpload(user: string, index: string, name: string): void {
    const refuse = (message: string, status: number) =>
      this.out.to(user, encode("ack", index, message, status));
    if (!this.drive || this.settings.bool("disable-upload")) {
      refuse("File transfer is not enabled", Status.UNSUPPORTED);
      return;
    }
    const target = this.drive.resolve(name);
    if (!target || this.drive.isDirectory(name)) {
      refuse("Cannot open the file", Status.CLIENT_FORBIDDEN);
      return;
    }
    let fd: number;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fd = fs.openSync(target, "w");
    } catch {
      refuse("Cannot open the file", Status.RESOURCE_NOT_FOUND);
      return;
    }
    this.inbound.set(this.key(user, index), {
      user,
      kind: "upload",
      chunks: [],
      size: 0,
      fd,
      file: target,
    });
    this.out.to(user, encode("ack", index, "OK", Status.SUCCESS));
  }

  private blob(user: string, index: string, data: string): void {
    const stream = this.inbound.get(this.key(user, index));
    if (!stream) return;
    const bytes = Buffer.from(data, "base64");
    if (stream.kind === "clipboard") {
      if (stream.size + bytes.length <= CLIPBOARD_LIMIT) {
        stream.chunks.push(bytes);
        stream.size += bytes.length;
      }
    } else if (stream.fd !== undefined) {
      try {
        fs.writeSync(stream.fd, bytes);
      } catch {
        this.out.to(
          user,
          encode("ack", index, "Write failed", Status.SERVER_ERROR),
        );
        this.closeInbound(this.key(user, index));
        return;
      }
    }
    this.out.to(user, encode("ack", index, "OK", Status.SUCCESS));
  }

  private endInbound(user: string, index: string): void {
    const key = this.key(user, index);
    const stream = this.inbound.get(key);
    if (!stream) return;
    if (stream.kind === "clipboard" && !this.disablePaste) {
      this.client?.clipboard(
        normalizeLineEndings(
          Buffer.concat(stream.chunks).toString("utf8"),
          this.settings?.get("normalize-clipboard") ?? "",
        ),
      );
    }
    this.closeInbound(key);
  }

  private closeInbound(key: string): void {
    const stream = this.inbound.get(key);
    this.inbound.delete(key);
    if (stream?.fd !== undefined) {
      try {
        fs.closeSync(stream.fd);
      } catch {
        // Already closed.
      }
    }
  }

  // The drive as a Guacamole filesystem object

  private filesystemInstruction(): string {
    const name = this.settings.get("drive-name", "Shared Drive");
    return encode("filesystem", FILESYSTEM_OBJECT, name);
  }

  private get(user: string, name: string): void {
    const drive = this.drive;
    if (!drive || user !== this.owner) return;
    const stream = this.out.openStream();
    if (drive.isDirectory(name)) {
      const listing = drive.listing(name) ?? "{}";
      let data = encode(
        "body",
        FILESYSTEM_OBJECT,
        stream,
        STREAM_INDEX_MIMETYPE,
        name,
      );
      const json = Buffer.from(listing, "utf8");
      for (let offset = 0; offset < json.length; offset += BLOB_SIZE) {
        data += encode(
          "blob",
          stream,
          json.subarray(offset, offset + BLOB_SIZE).toString("base64"),
        );
      }
      data += encode("end", stream);
      this.out.closeStream(stream);
      this.out.to(user, data);
      return;
    }
    if (this.settings.bool("disable-download")) {
      this.out.closeStream(stream);
      return;
    }
    const full = drive.resolve(name);
    let file: OutboundFile;
    try {
      file = full ? diskFile(user, full) : bufferFile(user, Buffer.alloc(0));
    } catch {
      this.out.closeStream(stream);
      return;
    }
    this.downloads.set(stream, file);
    this.out.to(
      user,
      encode(
        "body",
        FILESYSTEM_OBJECT,
        stream,
        "application/octet-stream",
        name,
      ),
    );
    this.ack(stream, Status.SUCCESS);
  }

  /** The client took the last blob of a download (or opened it): send more. */
  private ack(index: number, status: number): void {
    const file = this.downloads.get(index);
    if (!file) return;
    let chunk: Buffer;
    try {
      chunk =
        status === Status.SUCCESS && file.offset < file.size
          ? file.read(file.offset, BLOB_SIZE)
          : Buffer.alloc(0);
    } catch {
      chunk = Buffer.alloc(0);
    }
    if (chunk.length === 0) {
      this.out.to(file.user, encode("end", index));
      this.finishDownload(index, file);
      return;
    }
    file.offset += chunk.length;
    this.out.to(file.user, encode("blob", index, chunk.toString("base64")));
  }

  private finishDownload(index: number, file: OutboundFile): void {
    this.downloads.delete(index);
    this.out.closeStream(index);
    try {
      file.close?.();
    } catch {
      // Already closed.
    }
  }
}
