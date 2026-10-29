import type { Display } from "./display.js";
import type { Output } from "./output.js";
import type { DriveFolder } from "./filesystem.js";
import type { LogLevel } from "../messages.js";
import type { Wasm } from "./wasm.js";

/** Connection parameters by guacd's names, with typed reads. */
export class Settings {
  constructor(private readonly values: Record<string, string>) {}

  get(name: string, fallback = ""): string {
    const value = this.values[name];
    return value === undefined || value === null ? fallback : String(value);
  }

  has(name: string): boolean {
    return this.get(name) !== "";
  }

  bool(name: string, fallback = false): boolean {
    const value = this.get(name).toLowerCase();
    if (value === "") return fallback;
    return value === "true" || value === "1" || value === "yes";
  }

  int(name: string, fallback: number): number {
    const value = Number.parseInt(this.get(name), 10);
    return Number.isFinite(value) ? value : fallback;
  }
}

/** What a protocol client can use from the session it runs in. */
export interface RemoteHost {
  readonly out: Output;
  readonly display: Display;
  readonly wasm: Wasm;
  readonly settings: Settings;
  readonly drive: DriveFolder | null;
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  /** Connected and drawing. */
  ready(): void;
  /** Ends the session with a Guacamole error. */
  fail(message: string, status: number): void;
  /** The remote side closed normally. */
  closed(): void;
  /** Text the remote copied, for every user. */
  clipboard(text: string): void;
  /** A file for the owner to download (RDP Download folder, printing). */
  sendFile(name: string, mimetype: string, bytes: Uint8Array): void;
  /** PCM from the remote, 16-bit little endian. */
  audio(rate: number, channels: number, pcm: Uint8Array): void;
}

export interface RemoteClient {
  start(): void;
  mouse(x: number, y: number, mask: number): void;
  key(keysym: number, pressed: boolean): void;
  /** A dpi of 0 keeps the current one. */
  resize(width: number, height: number, dpi: number): void;
  clipboard(text: string): void;
  stop(): void;
}
