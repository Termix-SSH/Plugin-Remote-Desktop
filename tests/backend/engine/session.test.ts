import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineSession,
  type EngineWorker,
  type UserSocket,
} from "../../../src/backend/engine/session.js";
import type {
  FromWorker,
  ToWorker,
} from "../../../src/backend/engine/messages.js";

class FakeSocket extends EventEmitter implements UserSocket {
  readyState = 1;
  sent: string[] = [];
  closed: [number?, string?] | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = [code, reason];
    this.emit("close");
  }
  client(data: string) {
    this.emit("message", Buffer.from(data));
  }
}

class FakeWorker extends EventEmitter implements EngineWorker {
  posted: ToWorker[] = [];
  terminated = false;
  postMessage(message: ToWorker) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: FromWorker) {
    this.emit("message", message);
  }
  inputs() {
    return this.posted.filter((m) => m.t === "input");
  }
}

function make(options: { recording?: string } = {}) {
  const worker = new FakeWorker();
  const onEnd = vi.fn();
  const session = new EngineSession({
    config: { protocol: "vnc", settings: {} },
    worker,
    log: () => {},
    onEnd,
    recording: options.recording
      ? {
          file: options.recording,
          excludeOutput: false,
          excludeMouse: false,
          includeKeys: true,
        }
      : null,
  });
  return { worker, session, onEnd };
}

let sessions: EngineSession[] = [];
afterEach(() => {
  for (const session of sessions) session.end();
  sessions = [];
  vi.useRealTimers();
});

describe("EngineSession", () => {
  it("starts the worker and sends the connection id first", () => {
    const { worker, session } = make({});
    sessions.push(session);
    const owner = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    expect(worker.posted[0]).toMatchObject({ t: "start" });
    expect(worker.posted[1]).toMatchObject({ t: "join", owner: true });
    expect(owner.sent[0]).toBe(`0.,${session.id.length}.${session.id};`);
  });

  it("uses a given id", () => {
    const worker = new FakeWorker();
    const session = new EngineSession({
      id: "$fixed",
      config: { protocol: "rdp", settings: {} },
      worker,
      log: () => {},
    });
    sessions.push(session);
    expect(session.id).toBe("$fixed");
  });

  it("routes worker output to everyone, one user, or all but one", () => {
    const { worker, session } = make();
    sessions.push(session);
    const a = new FakeSocket();
    const b = new FakeSocket();
    const ida = session.attach(a, { owner: true, readOnly: false });
    session.attach(b, { owner: false, readOnly: true });
    worker.reply({ t: "out", data: "all;" });
    worker.reply({ t: "out", data: "only-a;", to: ida });
    worker.reply({ t: "out", data: "not-a;", except: ida });
    expect(a.sent.slice(1)).toEqual(["all;", "only-a;"]);
    expect(b.sent.slice(1)).toEqual(["all;", "not-a;"]);
  });

  it("drops everything but acks from a read-only viewer", () => {
    const { worker, session } = make();
    sessions.push(session);
    session.attach(new FakeSocket(), { owner: true, readOnly: false });
    const viewer = new FakeSocket();
    session.attach(viewer, { owner: false, readOnly: true });
    viewer.client(
      "5.mouse,1.1,1.2,1.1;3.key,2.97,1.1;4.size,3.800,3.600;9.clipboard,1.1,10.text/plain;4.sync,3.123;",
    );
    expect(worker.inputs().map((m) => m.t === "input" && m.opcode)).toEqual([
      "sync",
    ]);
  });

  it("passes a read-write viewer's input on", () => {
    const { worker, session } = make();
    sessions.push(session);
    session.attach(new FakeSocket(), { owner: true, readOnly: false });
    const viewer = new FakeSocket();
    session.attach(viewer, { owner: false, readOnly: false });
    viewer.client("3.key,2.97,1.1;");
    expect(worker.inputs()).toHaveLength(1);
  });

  it("answers the tunnel ping itself", () => {
    const { worker, session } = make();
    sessions.push(session);
    const owner = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    owner.client("0.,4.ping,3.555;");
    expect(owner.sent.at(-1)).toBe("0.,4.ping,3.555;");
    expect(worker.inputs()).toHaveLength(0);
  });

  it("ends for everyone when the owner leaves", () => {
    const { worker, session, onEnd } = make();
    const owner = new FakeSocket();
    const viewer = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    session.attach(viewer, { owner: false, readOnly: true });
    owner.close();
    expect(viewer.closed).not.toBeNull();
    expect(worker.posted.at(-1)).toEqual({ t: "stop" });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("only drops a viewer that leaves or is kicked", () => {
    const { worker, session } = make();
    sessions.push(session);
    const owner = new FakeSocket();
    const viewer = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    session.attach(viewer, { owner: false, readOnly: true });
    session.kickViewers();
    expect(viewer.closed).not.toBeNull();
    expect(owner.closed).toBeNull();
    expect(worker.posted.at(-1)).toMatchObject({ t: "leave" });
  });

  it("closes only the viewers of a revoked share", () => {
    const { session } = make();
    sessions.push(session);
    const owner = new FakeSocket();
    const a = new FakeSocket();
    const b = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    session.attach(a, { owner: false, readOnly: true, shareId: "s1" });
    session.attach(b, { owner: false, readOnly: true, shareId: "s2" });
    expect(session.kickShare("s1")).toBe(1);
    expect(a.closed).not.toBeNull();
    expect(b.closed).toBeNull();
    expect(owner.closed).toBeNull();
  });

  it("sends the engine error to everyone and closes", () => {
    const { worker, session, onEnd } = make();
    const owner = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    worker.reply({ t: "error", message: "Bad login", status: 0x301 });
    expect(owner.sent).toContain("5.error,9.Bad login,3.769;");
    expect(owner.closed).not.toBeNull();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("sends nop and closes users that went quiet", () => {
    vi.useFakeTimers();
    const { session } = make();
    sessions.push(session);
    const owner = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    vi.advanceTimersByTime(5000);
    expect(owner.sent.at(-1)).toBe("3.nop;");
    vi.advanceTimersByTime(10000);
    expect(owner.closed).not.toBeNull();
  });

  it("refuses a bad instruction", () => {
    const { session } = make();
    sessions.push(session);
    const owner = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    owner.client("zz.a;");
    expect(owner.sent.at(-1)).toContain("5.error");
    expect(owner.closed).not.toBeNull();
  });

  it("records broadcast output, mouse and keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    const file = path.join(dir, "a.guac");
    const { worker, session } = make({ recording: file });
    const owner = new FakeSocket();
    const id = session.attach(owner, { owner: true, readOnly: false });
    worker.reply({ t: "out", data: "4.size,1.0,2.10,2.10;" });
    worker.reply({ t: "out", data: "private;", to: id });
    owner.client("5.mouse,1.5,1.6,1.0;3.key,2.97,1.1;");
    session.end();
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("4.size,1.0,2.10,2.10;")).toBe(true);
    expect(text).not.toContain("private");
    expect(text).toMatch(/5\.mouse,1\.5,1\.6,1\.0,\d+\.\d+;/);
    expect(text).toMatch(/3\.key,2\.97,1\.1,\d+\.\d+;/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves mouse and keys out when told to", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    const file = path.join(dir, "b.guac");
    const worker = new FakeWorker();
    const session = new EngineSession({
      config: { protocol: "rdp", settings: {} },
      worker,
      log: () => {},
      recording: {
        file,
        excludeOutput: true,
        excludeMouse: true,
        includeKeys: false,
      },
    });
    const owner = new FakeSocket();
    session.attach(owner, { owner: true, readOnly: false });
    worker.reply({ t: "out", data: "4.size,1.0,2.10,2.10;" });
    owner.client("5.mouse,1.5,1.6,1.0;3.key,2.97,1.1;");
    session.end();
    expect(fs.readFileSync(file, "utf8")).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
