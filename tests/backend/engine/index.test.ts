import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuiltinEngine,
  builtinSessionId,
  rdpDrivePath,
  resolveEngineMode,
} from "../../../src/backend/engine/index.js";
import type { EngineWorker } from "../../../src/backend/engine/session.js";
import type { ToWorker } from "../../../src/backend/engine/messages.js";
import { RemoteSessions } from "../../../src/backend/sessions.js";
import type { GuacamoleToken } from "../../../src/backend/token-service.js";

class FakeWorker extends EventEmitter implements EngineWorker {
  posted: ToWorker[] = [];
  postMessage(message: ToWorker) {
    this.posted.push(message);
  }
  terminate() {}
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

const log = { info: () => {}, warn: () => {}, error: () => {} };

function engine() {
  const workers: FakeWorker[] = [];
  const sessions = new RemoteSessions();
  const onRecording = vi.fn(async () => {});
  const instance = new BuiltinEngine({
    log,
    sessions,
    recordingsDir: () => path.join(os.tmpdir(), "termix-engine-test"),
    onRecording,
    module: async () => ({}) as WebAssembly.Module,
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { instance, workers, sessions, onRecording };
}

const meta = {
  termixConnectId: "c-1",
  hostId: 7,
  hostName: "box",
  ownerUserId: "user 1",
  protocol: "rdp" as const,
  tabInstanceId: null,
};

let open: BuiltinEngine[] = [];
afterEach(() => {
  for (const e of open) e.close();
  open = [];
});

describe("engine mode", () => {
  it("is built in unless guacd is asked for", () => {
    expect(resolveEngineMode(undefined, {})).toBe("builtin");
    expect(resolveEngineMode(false, {})).toBe("builtin");
    expect(resolveEngineMode(true, {})).toBe("guacd");
    expect(resolveEngineMode(false, { REMOTE_DESKTOP_ENGINE: "guacd" })).toBe(
      "guacd",
    );
    expect(resolveEngineMode(true, { REMOTE_DESKTOP_ENGINE: "builtin" })).toBe(
      "builtin",
    );
  });

  it("puts each user's drive in its own folder", () => {
    expect(rdpDrivePath("u/../1", { RDP_DRIVE_PATH: "/data/d" })).toBe(
      path.resolve("/data/d", "u____1"),
    );
    expect(rdpDrivePath("u1", { DATA_DIR: "/x" })).toBe(
      path.resolve("/x", "rdp-drive", "u1"),
    );
  });
});

describe("BuiltinEngine", () => {
  it("opens a host session under the id known at token time", async () => {
    const { instance, workers, sessions } = engine();
    open.push(instance);
    const token: GuacamoleToken = {
      connection: {
        type: "rdp",
        settings: { hostname: "h", "enable-drive": true },
      },
      termixMeta: meta,
    };
    const socket = new FakeSocket();
    const session = await instance.open(
      token,
      new URLSearchParams("width=800&height=600?"),
      socket,
    );
    expect(session?.id).toBe(builtinSessionId("c-1"));
    expect(instance.has("$c-1")).toBe(true);
    expect(sessions.byGuacamole("$c-1")?.hostId).toBe(7);
    const start = workers[0].posted[0];
    expect(start).toMatchObject({
      t: "start",
      config: {
        protocol: "rdp",
        settings: { width: "800", height: "600", "enable-drive": "true" },
      },
    });
    expect(start.t === "start" && start.config.drivePath).toContain("user_1");

    expect(instance.endSession("$c-1")).toBe(true);
    expect(instance.has("$c-1")).toBe(false);
    expect(sessions.byGuacamole("$c-1")).toBeNull();
  });

  it("joins viewers to a live session and refuses unknown ones", async () => {
    const { instance, workers } = engine();
    open.push(instance);
    await instance.open(
      { connection: { type: "vnc", settings: {} }, termixMeta: meta },
      new URLSearchParams(),
      new FakeSocket(),
    );
    const viewer = new FakeSocket();
    await instance.open(
      { connection: { join: "$c-1", readOnly: true, settings: {} } },
      new URLSearchParams(),
      viewer,
    );
    expect(workers[0].posted.at(-1)).toMatchObject({
      t: "join",
      owner: false,
      readOnly: true,
    });

    const stranger = new FakeSocket();
    const result = await instance.open(
      { connection: { join: "$nope", settings: {} } },
      new URLSearchParams(),
      stranger,
    );
    expect(result).toBeNull();
    expect(stranger.sent[0]).toContain("5.error");
    expect(stranger.readyState).toBe(3);
  });

  it("hands the recording on when the session ends", async () => {
    const { instance, onRecording } = engine();
    open.push(instance);
    const recording = {
      hostId: 7,
      userId: "u",
      protocol: "rdp" as const,
      path: "r1.guac",
      startedAt: new Date().toISOString(),
    };
    const session = await instance.open(
      {
        connection: { type: "rdp", settings: {} },
        termixMeta: meta,
        recording,
      },
      new URLSearchParams(),
      new FakeSocket(),
    );
    session!.end();
    expect(onRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        recording,
        file: path.join(os.tmpdir(), "termix-engine-test", "r1.guac"),
      }),
    );
  });

  it("starts and stops a recording partway through for the owner only", async () => {
    const { instance, workers, onRecording } = engine();
    open.push(instance);
    await instance.open(
      { connection: { type: "rdp", settings: {} }, termixMeta: meta },
      new URLSearchParams(),
      new FakeSocket(),
    );
    const worker = workers[0];

    expect(instance.recordingState("$c-1", "someone else")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(instance.recordingState("$nope", "user 1")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(instance.recordingState("$c-1", "user 1")).toEqual({
      ok: true,
      recording: false,
    });

    const started = instance.setRecording("$c-1", "user 1", true);
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => m.t === "snapshot")).toBe(true),
    );
    worker.emit("message", { t: "snapshot", data: "4.size,1.0;" });
    await expect(started).resolves.toEqual({ ok: true, recording: true });
    expect(instance.recordingState("$c-1", "user 1")).toEqual({
      ok: true,
      recording: true,
    });

    await expect(
      instance.setRecording("$c-1", "user 1", false),
    ).resolves.toEqual({ ok: true, recording: false });
    expect(onRecording).toHaveBeenCalledTimes(1);
    const saved = (onRecording.mock.calls[0] as unknown[])[0] as {
      recording: { hostId: number; userId: string; path: string };
      file: string;
    };
    expect(saved.recording).toMatchObject({ hostId: 7, userId: "user 1" });
    const fs = await import("node:fs");
    expect(fs.readFileSync(saved.file, "utf8")).toContain("4.size,1.0;");

    // Ending the session after a manual stop saves nothing twice.
    instance.endSession("$c-1");
    expect(onRecording).toHaveBeenCalledTimes(1);
  });

  it("saves a recording still running when the session ends", async () => {
    const { instance, workers, onRecording } = engine();
    open.push(instance);
    await instance.open(
      { connection: { type: "rdp", settings: {} }, termixMeta: meta },
      new URLSearchParams(),
      new FakeSocket(),
    );
    const started = instance.setRecording("$c-1", "user 1", true);
    await vi.waitFor(() =>
      expect(workers[0].posted.some((m) => m.t === "snapshot")).toBe(true),
    );
    workers[0].emit("message", { t: "snapshot", data: "" });
    await started;
    instance.endSession("$c-1");
    expect(onRecording).toHaveBeenCalledTimes(1);
  });

  it("refuses a recording path outside the folder", async () => {
    const { instance, onRecording } = engine();
    open.push(instance);
    const session = await instance.open(
      {
        connection: { type: "rdp", settings: {} },
        recording: {
          hostId: 7,
          userId: "u",
          protocol: "rdp",
          path: "../evil.guac",
          startedAt: new Date().toISOString(),
        },
      },
      new URLSearchParams(),
      new FakeSocket(),
    );
    session!.end();
    expect(onRecording).not.toHaveBeenCalled();
  });

  it("refuses an unknown protocol", async () => {
    const { instance } = engine();
    open.push(instance);
    const socket = new FakeSocket();
    const result = await instance.open(
      { connection: { type: "ssh" as never, settings: {} } },
      new URLSearchParams(),
      socket,
    );
    expect(result).toBeNull();
    expect(socket.sent[0]).toContain("5.error");
  });
});
