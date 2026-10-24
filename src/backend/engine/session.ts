import crypto from "node:crypto";
import fs from "node:fs";
import { encode, Parser, Status } from "./protocol.js";
import type {
  EngineConfig,
  FromWorker,
  LogLevel,
  ToWorker,
} from "./messages.js";

/** The parts of a ws WebSocket a session uses. */
export interface UserSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  /** A socket level ping. Browsers answer it even in a throttled tab. */
  ping?(): void;
}

/** The parts of a worker_threads Worker a session uses. */
export interface EngineWorker {
  postMessage(message: ToWorker): void;
  on(event: "message", listener: (message: FromWorker) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

export interface RecordingOptions {
  /** Absolute path of the .guac file. */
  file: string;
  excludeOutput: boolean;
  excludeMouse: boolean;
  includeKeys: boolean;
}

export interface SessionOptions {
  /** guacd style connection id; random when not given. */
  id?: string;
  config: EngineConfig;
  worker: EngineWorker;
  recording?: RecordingOptions | null;
  log: (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  /** Called once, after every user is gone and the worker stopped. */
  onEnd?: (session: EngineSession) => void;
  keepaliveMs?: number;
  inactivityMs?: number;
}

interface User {
  id: string;
  socket: UserSocket;
  owner: boolean;
  readOnly: boolean;
  shareId: string | null;
  parser: Parser;
  lastSeen: number;
}

const OPEN = 1;
/** What a read-only viewer may still send: frame acks and goodbyes. */
const READ_ONLY_OPCODES = new Set(["sync", "nop", "ack", "disconnect", ""]);

/**
 * Tees what the session draws into a .guac file, the format guacd records
 * and the Session Recording player reads.
 */
export class RecordingTee {
  private fd: number | null;

  constructor(private readonly options: RecordingOptions) {
    this.fd = fs.openSync(options.file, "w", 0o600);
  }

  output(data: string): void {
    if (!this.options.excludeOutput) this.write(data);
  }

  input(opcode: string, args: string[]): void {
    if (opcode === "mouse" && !this.options.excludeMouse) {
      this.write(encode("mouse", args[0], args[1], args[2], Date.now()));
    } else if (opcode === "key" && this.options.includeKeys) {
      this.write(encode("key", args[0], args[1], Date.now()));
    }
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Already closed.
    }
    this.fd = null;
  }

  private write(data: string): void {
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, data);
    } catch {
      this.close();
    }
  }
}

/**
 * One built-in engine connection: the worker that speaks RDP, VNC or Telnet,
 * and every browser watching it. The id is what guacd would call the
 * connection id, so join tokens and session sharing work unchanged.
 */
export class EngineSession {
  readonly id: string;
  private readonly users = new Map<string, User>();
  private readonly recording: RecordingTee | null;
  private readonly keepalive: NodeJS.Timeout;
  private ended = false;
  private ready = false;
  private ownerId: string | null = null;

  constructor(private readonly options: SessionOptions) {
    this.id = options.id ?? `$${crypto.randomUUID()}`;
    this.recording = options.recording
      ? new RecordingTee(options.recording)
      : null;
    const { worker } = options;
    worker.on("message", (message) => this.fromWorker(message));
    worker.on("error", (error) => {
      options.log("error", "Remote desktop engine worker crashed", {
        error: error.message,
      });
      this.fail("The remote desktop engine stopped", Status.SERVER_ERROR);
    });
    worker.on("exit", () => {
      if (!this.ended)
        this.fail("The remote desktop engine stopped", Status.SERVER_ERROR);
    });
    worker.postMessage({ t: "start", config: options.config });

    const keepaliveMs = options.keepaliveMs ?? 5000;
    // A hidden browser tab or a phone app in the background sends no nop for
    // a while; the socket ping keeps those alive (issue #104).
    const inactivityMs = options.inactivityMs ?? 30000;
    this.keepalive = setInterval(() => {
      const now = Date.now();
      for (const user of [...this.users.values()]) {
        if (now - user.lastSeen > inactivityMs) {
          this.detach(user.id, "inactive");
          continue;
        }
        this.sendTo(user, encode("nop"));
        try {
          user.socket.ping?.();
        } catch {
          // Closing already.
        }
      }
    }, keepaliveMs);
    this.keepalive.unref?.();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get userCount(): number {
    return this.users.size;
  }

  /** Adds a browser. The first owner starts the session; joiners get a snapshot. */
  attach(
    socket: UserSocket,
    {
      owner,
      readOnly,
      shareId = null,
    }: { owner: boolean; readOnly: boolean; shareId?: string | null },
  ): string {
    const user: User = {
      id: `@${crypto.randomUUID()}`,
      socket,
      owner: owner && !this.ownerId,
      readOnly: readOnly && !owner,
      shareId,
      parser: new Parser(),
      lastSeen: Date.now(),
    };
    if (this.ended) {
      socket.close(1011, "Session ended");
      return user.id;
    }
    if (user.owner) this.ownerId = user.id;
    this.users.set(user.id, user);
    this.sendTo(user, encode("", this.id));
    socket.on("message", (data) => this.fromUser(user, data));
    socket.on("pong", () => {
      user.lastSeen = Date.now();
    });
    socket.on("close", () => this.detach(user.id, "closed"));
    socket.on("error", () => this.detach(user.id, "error"));
    this.options.worker.postMessage({
      t: "join",
      user: user.id,
      owner: user.owner,
      readOnly: user.readOnly,
    });
    return user.id;
  }

  /** Closes every viewer that isn't the owner. */
  kickViewers(): void {
    for (const user of [...this.users.values()]) {
      if (!user.owner) this.detach(user.id, "kicked");
    }
  }

  /** Closes the viewers that joined through one share. Returns how many. */
  kickShare(shareId: string): number {
    let count = 0;
    for (const user of [...this.users.values()]) {
      if (!user.owner && user.shareId === shareId) {
        this.detach(user.id, "share revoked");
        count++;
      }
    }
    return count;
  }

  kick(userId: string): void {
    this.detach(userId, "kicked");
  }

  /** Ends the connection for everyone. */
  end(reason = "Session ended"): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.keepalive);
    try {
      this.options.worker.postMessage({ t: "stop" });
    } catch {
      // The worker may be gone already.
    }
    const worker = this.options.worker;
    setTimeout(() => void worker.terminate(), 1000).unref?.();
    for (const user of [...this.users.values()]) {
      this.users.delete(user.id);
      this.closeSocket(user, 1000, reason);
    }
    this.recording?.close();
    this.options.onEnd?.(this);
  }

  private fail(message: string, status: number): void {
    if (this.ended) return;
    for (const user of this.users.values()) {
      this.sendTo(user, encode("error", message, status));
    }
    this.end(message);
  }

  private detach(userId: string, why: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    this.users.delete(userId);
    this.closeSocket(user, 1000, why);
    if (this.ended) return;
    if (user.owner) {
      this.end("The owner left");
      return;
    }
    this.options.worker.postMessage({ t: "leave", user: userId });
  }

  private closeSocket(user: User, code: number, reason: string): void {
    try {
      if (user.socket.readyState === OPEN) user.socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private sendTo(user: User, data: string): void {
    if (user.socket.readyState !== OPEN) return;
    try {
      user.socket.send(data);
    } catch {
      this.detach(user.id, "send failed");
    }
  }

  private fromUser(user: User, raw: unknown): void {
    if (this.ended) return;
    user.lastSeen = Date.now();
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw as Buffer[]).toString("utf8")
            : Buffer.from(raw as ArrayBuffer).toString("utf8");
    let instructions;
    try {
      instructions = user.parser.receive(text);
    } catch {
      this.sendTo(
        user,
        encode("error", "Bad request", Status.CLIENT_BAD_REQUEST),
      );
      this.detach(user.id, "bad request");
      return;
    }
    for (const { opcode, args } of instructions) {
      if (opcode === "") {
        // The tunnel's own ping, answered by the server like guacd's proxy does.
        if (args[0] === "ping")
          this.sendTo(user, encode("", "ping", args[1] ?? ""));
        continue;
      }
      if (opcode === "nop") continue;
      if (opcode === "disconnect") {
        this.detach(user.id, "disconnect");
        return;
      }
      if (user.readOnly && !READ_ONLY_OPCODES.has(opcode)) continue;
      if (!user.readOnly) this.recording?.input(opcode, args);
      this.options.worker.postMessage({
        t: "input",
        user: user.id,
        opcode,
        args,
      });
    }
  }

  private fromWorker(message: FromWorker): void {
    switch (message.t) {
      case "out": {
        if (message.to) {
          const user = this.users.get(message.to);
          if (user) this.sendTo(user, message.data);
          return;
        }
        if (!message.except) this.recording?.output(message.data);
        for (const user of this.users.values()) {
          if (user.id !== message.except) this.sendTo(user, message.data);
        }
        return;
      }
      case "ready":
        this.ready = true;
        return;
      case "error":
        this.fail(message.message, message.status);
        return;
      case "closed":
        for (const user of this.users.values()) {
          this.sendTo(user, encode("disconnect"));
        }
        this.end("The remote side closed the connection");
        return;
      case "log":
        this.options.log(message.level, message.message, message.meta);
        return;
    }
  }
}
