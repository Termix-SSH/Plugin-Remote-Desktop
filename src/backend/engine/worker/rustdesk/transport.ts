import net from "node:net";
import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2.js";

const MAX_FRAME = 64 * 1024 * 1024;

/** RustDesk's frame header: 1 to 4 bytes little endian, length << 2 | (bytes - 1). */
export function frameHeader(length: number): Buffer {
  if (length <= 0x3f) return Buffer.from([length << 2]);
  if (length <= 0x3fff) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE((length << 2) | 1);
    return b;
  }
  if (length <= 0x3fffff) {
    const h = (length << 2) | 2;
    return Buffer.from([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
  }
  if (length <= 0x3fffffff) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(((length << 2) | 3) >>> 0);
    return b;
  }
  throw new Error("Frame too large");
}

/** Splits a byte stream into frames. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.buffer.length === 0) break;
      const headLength = (this.buffer[0] & 3) + 1;
      if (this.buffer.length < headLength) break;
      let n = 0;
      for (let i = headLength - 1; i >= 0; i--) n = n * 256 + this.buffer[i];
      n = Math.floor(n / 4);
      if (n > MAX_FRAME) throw new Error("RustDesk frame too large");
      if (this.buffer.length < headLength + n) break;
      out.push(this.buffer.subarray(headLength, headLength + n));
      this.buffer = this.buffer.subarray(headLength + n);
    }
    return out;
  }
}

function nonce(counter: number): Uint8Array {
  const n = new Uint8Array(nacl.secretbox.nonceLength);
  new DataView(n.buffer).setBigUint64(0, BigInt(counter), true);
  return n;
}

const KX_LATEST = 1;
const SPLIT_CONTEXT = Buffer.from("rdkx-spl");

/** The key exchange version to use against a peer that offers `advertised`. */
export function kxVersionFor(advertised: number): number {
  return Math.min(advertised, KX_LATEST);
}

/** Version 1 key split: one key per direction, bound to the handshake. */
export function splitKey(
  key: Uint8Array,
  direction: 1 | 2,
  t: {
    initiatorPk: Uint8Array;
    responderPk: Uint8Array;
    advertised: number;
    picked: number;
  },
): Uint8Array {
  const le = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  return blake2b(
    Buffer.concat([
      SPLIT_CONTEXT,
      Buffer.from([direction]),
      le(t.advertised),
      le(t.picked),
      t.initiatorPk,
      t.responderPk,
    ]),
    { key, dkLen: 32 },
  );
}

/** secretbox with a counter nonce per direction, as RustDesk's Encrypt. */
export class Cipher {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly receiveKey: Uint8Array = sendKey,
  ) {}

  seal(data: Uint8Array): Uint8Array {
    this.sent += 1;
    return nacl.secretbox(data, nonce(this.sent), this.sendKey);
  }

  open(data: Uint8Array): Uint8Array {
    // RustDesk leaves frames of one byte or less as they are.
    if (data.length <= 1) return data;
    this.received += 1;
    const plain = nacl.secretbox.open(
      data,
      nonce(this.received),
      this.receiveKey,
    );
    if (!plain) throw new Error("Could not decrypt a RustDesk message");
    return plain;
  }
}

export interface Connection {
  send(data: Uint8Array): void;
  next(timeoutMs?: number): Promise<Uint8Array>;
  setCipher(cipher: Cipher): void;
  /** Hands every later frame to `handler` instead of next(). */
  onFrame(handler: (data: Uint8Array) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export function parseAddress(
  value: string,
  defaultPort: number,
): { host: string; port: number } {
  const trimmed = value.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };
  const parts = trimmed.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: Number(parts[1]) };
  }
  return { host: trimmed, port: defaultPort };
}

export type Dialer = (host: string, port: number) => net.Socket;

const defaultDialer: Dialer = (host, port) => net.connect({ host, port });

/** A framed TCP connection to hbbs, hbbr or a peer. */
export function connect(
  host: string,
  port: number,
  timeoutMs = 10_000,
  dial: Dialer = defaultDialer,
): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = dial(host, port);
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setKeepAlive(true, 15_000);
      resolve(wrap(socket));
    });
  });
}

export function wrap(socket: net.Socket): Connection {
  const reader = new FrameReader();
  const queue: Uint8Array[] = [];
  const waiting: Array<{
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | null;
  }> = [];
  let cipher: Cipher | null = null;
  let handler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: ((error?: Error) => void) | null = null;
  let ended: Error | null = null;

  const deliver = (frame: Uint8Array) => {
    if (handler) handler(frame);
    else {
      const w = waiting.shift();
      if (w) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve(frame);
      } else queue.push(frame);
    }
  };

  const finish = (error?: Error) => {
    if (ended) return;
    ended = error ?? new Error("The connection closed");
    for (const w of waiting.splice(0)) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(ended);
    }
    closeHandler?.(error);
  };

  socket.on("data", (chunk: Buffer) => {
    try {
      for (const frame of reader.push(chunk)) {
        deliver(cipher ? cipher.open(frame) : frame);
      }
    } catch (error) {
      socket.destroy();
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("error", (error) => finish(error));
  socket.on("close", () => finish());

  return {
    send(data) {
      if (ended || socket.destroyed) return;
      const body = cipher ? cipher.seal(data) : data;
      socket.write(Buffer.concat([frameHeader(body.length), body]));
    },
    next(timeoutMs = 10_000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (ended) return Promise.reject(ended);
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: null as NodeJS.Timeout | null,
        };
        entry.timer = setTimeout(() => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error("Timed out waiting for RustDesk"));
        }, timeoutMs);
        waiting.push(entry);
      });
    },
    setCipher(next) {
      cipher = next;
    },
    onFrame(next) {
      handler = next;
      for (const frame of queue.splice(0)) next(frame);
    },
    onClose(next) {
      closeHandler = next;
      if (ended) next();
    },
    close() {
      socket.destroy();
    },
  };
}
