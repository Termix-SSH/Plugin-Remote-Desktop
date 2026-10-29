/** Messages between an engine session (main thread) and its worker. */

export type EngineProtocol = "rdp" | "vnc" | "telnet";

export interface EngineConfig {
  protocol: EngineProtocol;
  /** Every connection parameter, by guacd's name, as strings. */
  settings: Record<string, string>;
  /** Folder for the RDP drive, made if missing. */
  drivePath?: string;
}

export type ToWorker =
  | { t: "start"; config: EngineConfig }
  | { t: "input"; user: string; opcode: string; args: string[] }
  | { t: "join"; user: string; owner: boolean; readOnly: boolean }
  | { t: "leave"; user: string }
  /** Asks for the current screen, to start a recording partway through. */
  | { t: "snapshot" }
  | { t: "stop" };

export type LogLevel = "debug" | "info" | "warn" | "error";

export type FromWorker =
  /** Instructions for every user, or `to` one user, or everyone `except` one. */
  | { t: "out"; data: string; to?: string; except?: string }
  /** The remote side is connected and drawing. */
  | { t: "ready" }
  | { t: "error"; message: string; status: number }
  | { t: "closed" }
  /** The current screen as instructions, answering "snapshot". */
  | { t: "snapshot"; data: string }
  | {
      t: "log";
      level: LogLevel;
      message: string;
      meta?: Record<string, unknown>;
    };

/** What the worker core talks through: a worker port or, in tests, a direct call. */
export interface Port {
  post(message: FromWorker): void;
}
