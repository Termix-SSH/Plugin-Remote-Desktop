import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import wasmBytes from "./wasm/engine_bg.wasm";
import { mergeSettings } from "./defaults.js";
import { encode, Status } from "./protocol.js";
import type { EngineConfig, EngineProtocol } from "./messages.js";
import {
  EngineSession,
  type EngineWorker,
  type RecordingOptions,
  type UserSocket,
} from "./session.js";
import { SHARE_ID_SETTING, type GuacamoleToken } from "../token-service.js";
import type { RemoteSessions } from "../sessions.js";
import { errorMessage, type RemoteDesktopLogger } from "../log.js";

export type EngineMode = "builtin" | "guacd";

/**
 * REMOTE_DESKTOP_ENGINE wins over the admin "Use an external guacd"
 * setting; built in by default.
 */
export function resolveEngineMode(
  useGuacd: unknown,
  env: NodeJS.ProcessEnv = process.env,
): EngineMode {
  const value = env.REMOTE_DESKTOP_ENGINE?.trim().toLowerCase();
  if (value === "guacd" || value === "builtin") return value;
  return useGuacd === true ? "guacd" : "builtin";
}

const DATA_DIR = process.env.DATA_DIR || "./db/data";

/** The RDP drive folder for a user in built-in mode. */
export function rdpDrivePath(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    env.RDP_DRIVE_PATH?.trim() ||
    path.join(env.DATA_DIR || DATA_DIR, "rdp-drive");
  return path.resolve(root, userId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * A saved host's session id is known when its token is minted, so a collab
 * room can present it before the display connects.
 */
export function builtinSessionId(termixConnectId: string): string {
  return `$${termixConnectId}`;
}

let compiled: Promise<WebAssembly.Module> | null = null;

/** The engine module, compiled once and shared with every worker. */
export function engineModule(): Promise<WebAssembly.Module> {
  compiled ??= WebAssembly.compile(wasmBytes as BufferSource);
  return compiled;
}

function spawnWorker(wasm: WebAssembly.Module): EngineWorker {
  return new Worker(new URL("./workers/engine.js", import.meta.url), {
    workerData: { wasm },
  }) as unknown as EngineWorker;
}

export interface FinishedRecording {
  recording: NonNullable<GuacamoleToken["recording"]>;
  file: string;
}

export interface BuiltinEngineDeps {
  log: RemoteDesktopLogger;
  sessions: RemoteSessions;
  /** Where .guac recordings are written. */
  recordingsDir: () => string;
  /** Hands a finished recording to the Session Recording plugin. */
  onRecording: (finished: FinishedRecording) => Promise<void>;
  /** Called when a primary session opens; returns what to release on close. */
  onOpen?: (hostId: number) => () => void;
  spawn?: (wasm: WebAssembly.Module) => EngineWorker;
  module?: () => Promise<WebAssembly.Module>;
}

/**
 * The built-in engine: guacd's job done inside Termix. Every connection is
 * an EngineSession with its own worker, and browsers still speak the
 * Guacamole protocol to it.
 */
type ActiveRecording = {
  meta: NonNullable<GuacamoleToken["recording"]>;
  options: RecordingOptions;
};

/** Who opened a session, for the record button. */
interface SessionInfo {
  userId: string;
  hostId: number;
  protocol: EngineProtocol;
  settings: Record<string, string>;
}

export type RecordingControl =
  | { ok: true; recording: boolean }
  | { ok: false; status: number; error: string };

export class BuiltinEngine {
  private readonly live = new Map<string, EngineSession>();
  private readonly info = new Map<string, SessionInfo>();
  private readonly recordings = new Map<string, ActiveRecording>();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly deps: BuiltinEngineDeps) {}

  has(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    token: GuacamoleToken,
  ): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const query = new URL(request.url ?? "/", "http://localhost")
        .searchParams;
      this.open(token, query, ws as unknown as UserSocket).catch((error) => {
        this.deps.log.error("Failed to open a remote desktop session", {
          operation: "engine_open_error",
          error: errorMessage(error),
        });
        refuse(ws as unknown as UserSocket, "Could not start the session");
      });
    });
  }

  async open(
    token: GuacamoleToken,
    query: URLSearchParams,
    socket: UserSocket,
  ): Promise<EngineSession | null> {
    const join = token.connection.join;
    if (join) {
      const session = this.live.get(join);
      if (!session) {
        refuse(socket, "The session has ended", Status.RESOURCE_NOT_FOUND);
        return null;
      }
      session.attach(socket, {
        owner: false,
        readOnly: token.connection.readOnly !== false,
        shareId:
          typeof token.connection.settings[SHARE_ID_SETTING] === "string"
            ? (token.connection.settings[SHARE_ID_SETTING] as string)
            : null,
      });
      return session;
    }

    const protocol = token.connection.type as EngineProtocol | undefined;
    if (protocol !== "rdp" && protocol !== "vnc" && protocol !== "telnet") {
      refuse(socket, "Unsupported protocol", Status.UNSUPPORTED);
      return null;
    }
    const settings = mergeSettings(protocol, token.connection.settings, query);
    const meta = token.termixMeta;
    const userId = meta?.ownerUserId ?? token.userId;
    const config: EngineConfig = { protocol, settings };
    if (protocol === "rdp" && settings["enable-drive"] === "true" && userId) {
      config.drivePath = rdpDrivePath(userId);
    }
    const recording = this.recordingFor(token, settings);

    const wasm = await (this.deps.module ?? engineModule)();
    const worker = (this.deps.spawn ?? spawnWorker)(wasm);
    let release: (() => void) | undefined;
    const session = new EngineSession({
      id: meta ? builtinSessionId(meta.termixConnectId) : undefined,
      config,
      worker,
      recording: recording?.options,
      log: (level, message, logMeta) => {
        const write =
          level === "error"
            ? this.deps.log.error
            : level === "warn"
              ? this.deps.log.warn
              : level === "debug"
                ? this.deps.log.debug
                : this.deps.log.info;
        write?.(message, { protocol, ...logMeta });
      },
      onEnd: (ended) => {
        this.live.delete(ended.id);
        this.info.delete(ended.id);
        if (meta) this.deps.sessions.closed(meta.termixConnectId);
        else release?.();
        this.saveRecording(ended.id);
      },
    });
    this.live.set(session.id, session);
    if (recording) this.recordings.set(session.id, recording);
    if (userId) {
      this.info.set(session.id, {
        userId,
        hostId: meta?.hostId ?? token.recording?.hostId ?? 0,
        protocol,
        settings,
      });
    }
    if (meta) {
      release = this.deps.onOpen?.(meta.hostId);
      this.deps.sessions.opened(meta, session.id, release ? [release] : []);
    }
    session.attach(socket, { owner: true, readOnly: false });
    return session;
  }

  private recordingFor(
    token: GuacamoleToken,
    settings: Record<string, string>,
  ): {
    meta: NonNullable<GuacamoleToken["recording"]>;
    options: RecordingOptions;
  } | null {
    const recording = token.recording;
    if (!recording) return null;
    const dir = path.resolve(this.deps.recordingsDir());
    const file = path.resolve(dir, recording.path);
    if (!file.startsWith(`${dir}${path.sep}`)) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.deps.log.warn("Could not make the recordings folder", {
        operation: "engine_recording_dir_error",
        path: dir,
        error: errorMessage(error),
      });
      return null;
    }
    return {
      meta: recording,
      options: {
        file,
        excludeOutput: settings["recording-exclude-output"] === "true",
        excludeMouse: settings["recording-exclude-mouse"] === "true",
        includeKeys: settings["recording-include-keys"] === "true",
      },
    };
  }

  /** Whether a session is recording, for the user who opened it. */
  recordingState(sessionId: string, userId: string): RecordingControl {
    const session = this.live.get(sessionId);
    const info = this.info.get(sessionId);
    if (!session || !info || !info.hostId) {
      return { ok: false, status: 404, error: "Session not found" };
    }
    if (info.userId !== userId) {
      return {
        ok: false,
        status: 403,
        error: "Only the session owner can record",
      };
    }
    return { ok: true, recording: session.isRecording };
  }

  /** Starts or stops recording a running session. */
  async setRecording(
    sessionId: string,
    userId: string,
    on: boolean,
  ): Promise<RecordingControl> {
    const state = this.recordingState(sessionId, userId);
    if (!state.ok) return state;
    const session = this.live.get(sessionId)!;
    const info = this.info.get(sessionId)!;
    if (!on) {
      if (session.stopRecording()) this.saveRecording(sessionId);
      return { ok: true, recording: false };
    }
    if (session.isRecording) return { ok: true, recording: true };

    const dir = path.resolve(this.deps.recordingsDir());
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.deps.log.warn("Could not make the recordings folder", {
        operation: "engine_recording_dir_error",
        path: dir,
        error: errorMessage(error),
      });
      return { ok: false, status: 500, error: "Could not start recording" };
    }
    const name = `${crypto.randomUUID()}.guac`;
    const active: ActiveRecording = {
      meta: {
        hostId: info.hostId,
        userId: info.userId,
        protocol: info.protocol,
        path: name,
        startedAt: new Date().toISOString(),
      },
      options: {
        file: path.join(dir, name),
        excludeOutput: info.settings["recording-exclude-output"] === "true",
        excludeMouse: info.settings["recording-exclude-mouse"] === "true",
        includeKeys: info.settings["recording-include-keys"] !== "false",
      },
    };
    if (!(await session.startRecording(active.options))) {
      return { ok: false, status: 409, error: "Could not start recording" };
    }
    this.recordings.set(sessionId, active);
    return { ok: true, recording: true };
  }

  /** Hands the session's recording to Session Recording, once. */
  private saveRecording(sessionId: string): void {
    const recording = this.recordings.get(sessionId);
    if (!recording) return;
    this.recordings.delete(sessionId);
    this.deps
      .onRecording({
        recording: recording.meta,
        file: recording.options.file,
      })
      .catch((error) =>
        this.deps.log.error("Failed to save a recording", {
          operation: "engine_recording_persist_error",
          error: errorMessage(error),
        }),
      );
  }

  /** Ends a session and closes everyone watching it. */
  endSession(sessionId: string): boolean {
    const session = this.live.get(sessionId);
    if (!session) return false;
    session.end();
    return true;
  }

  /** Closes the viewers that joined through one share. */
  disconnectShare(sessionId: string, shareId: string): number {
    return this.live.get(sessionId)?.kickShare(shareId) ?? 0;
  }

  close(): void {
    for (const session of [...this.live.values()]) session.end();
    this.live.clear();
    this.wss.close();
  }
}

function refuse(
  socket: UserSocket,
  message: string,
  status: number = Status.SERVER_ERROR,
): void {
  try {
    socket.send(encode("error", message, status));
    socket.close(1000, message);
  } catch {
    // The peer is gone.
  }
}
