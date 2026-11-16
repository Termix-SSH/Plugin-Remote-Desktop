import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistRecording,
  readRecordingChunk,
  RECORDING_CHUNK_BYTES,
  type RecordingsWriter,
} from "../../src/backend/guacamole-server.js";

let dir: string;
const savedEnv = process.env.GUACD_RECORDING_BACKEND_PATH;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rec-"));
  process.env.GUACD_RECORDING_BACKEND_PATH = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.GUACD_RECORDING_BACKEND_PATH;
  else process.env.GUACD_RECORDING_BACKEND_PATH = savedEnv;
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("recording handoff", () => {
  it("reads a recording in chunks and ends with null", async () => {
    const file = path.join(dir, "a.guac");
    const body = Buffer.alloc(RECORDING_CHUNK_BYTES + 10, 7);
    fs.writeFileSync(file, body);
    const first = await readRecordingChunk(file, 0);
    expect(first?.length).toBe(RECORDING_CHUNK_BYTES);
    const second = await readRecordingChunk(file, RECORDING_CHUNK_BYTES);
    expect(second?.length).toBe(10);
    expect(await readRecordingChunk(file, body.length)).toBeNull();
    expect(await readRecordingChunk(file, -1)).toBeNull();
  });

  it("hands Session Recording a reader and drops its own copy after", async () => {
    fs.writeFileSync(path.join(dir, "s.guac"), "recording bytes");
    let copied = "";
    const writer = {
      enabledFor: async () => true,
      createFinished: vi.fn(
        async (input: Parameters<RecordingsWriter["createFinished"]>[0]) => {
          const chunk = await input.read?.(0);
          copied = Buffer.from(chunk ?? []).toString();
          return { id: 1 };
        },
      ),
    } as unknown as RecordingsWriter;
    await persistRecording(
      {
        log: log as never,
        recordings: async () => writer,
        asUser: (_u, fn) => fn(),
      },
      {
        path: "s.guac",
        hostId: 3,
        userId: "u1",
        startedAt: Date.now() - 1000,
        protocol: "rdp",
      } as never,
    );
    expect(copied).toBe("recording bytes");
    expect(fs.existsSync(path.join(dir, "s.guac"))).toBe(false);
  });

  it("keeps the file when Session Recording fails to take it", async () => {
    fs.writeFileSync(path.join(dir, "k.guac"), "x");
    const writer = {
      enabledFor: async () => true,
      createFinished: async () => {
        throw new Error("no room");
      },
    } as unknown as RecordingsWriter;
    await persistRecording(
      {
        log: log as never,
        recordings: async () => writer,
        asUser: (_u, fn) => fn(),
      },
      {
        path: "k.guac",
        hostId: 3,
        userId: "u1",
        startedAt: Date.now(),
        protocol: "rdp",
      } as never,
    ).catch(() => {});
    expect(fs.existsSync(path.join(dir, "k.guac"))).toBe(true);
  });
});
