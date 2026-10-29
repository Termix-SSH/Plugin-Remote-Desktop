import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import wasmBytes from "../../../../src/backend/engine/wasm/engine_bg.wasm";
import { EngineCore } from "../../../../src/backend/engine/worker/core.js";
import {
  loadWasm,
  type Wasm,
} from "../../../../src/backend/engine/worker/wasm.js";
import type {
  RemoteClient,
  RemoteHost,
} from "../../../../src/backend/engine/worker/remote.js";
import type { FromWorker } from "../../../../src/backend/engine/messages.js";
import {
  DriveFolder,
  STREAM_INDEX_MIMETYPE,
} from "../../../../src/backend/engine/worker/filesystem.js";

let wasm: Wasm;
beforeAll(() => {
  wasm = loadWasm(new WebAssembly.Module(wasmBytes as BufferSource));
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  dirs.push(dir);
  return dir;
}

function setup(settings: Record<string, string> = {}, drivePath?: string) {
  const posted: FromWorker[] = [];
  let host!: RemoteHost;
  const client: RemoteClient = {
    start: vi.fn(),
    mouse: vi.fn(),
    key: vi.fn(),
    resize: vi.fn(),
    clipboard: vi.fn(),
    stop: vi.fn(),
  };
  const core = new EngineCore({ post: (m) => posted.push(m) }, wasm, {
    rdp: (h) => {
      host = h;
      return client;
    },
  });
  core.handle({ t: "start", config: { protocol: "rdp", settings, drivePath } });
  core.handle({ t: "join", user: "owner", owner: true, readOnly: false });
  const to = (user: string) =>
    posted
      .filter((m) => m.t === "out" && m.to === user)
      .map((m) => (m as { data: string }).data)
      .join("");
  return { core, client, posted, host: () => host, to };
}

const input = (
  core: EngineCore,
  user: string,
  opcode: string,
  ...args: string[]
) => core.handle({ t: "input", user, opcode, args });

describe("EngineCore", () => {
  it("passes input to the client and resizes only for the owner", () => {
    const { core, client } = setup();
    core.handle({ t: "join", user: "viewer", owner: false, readOnly: false });
    input(core, "owner", "key", "97", "1");
    input(core, "owner", "mouse", "1", "2", "1");
    input(core, "viewer", "size", "800", "600");
    input(core, "owner", "size", "800", "600", "120");
    expect(client.key).toHaveBeenCalledWith(97, true);
    expect(client.mouse).toHaveBeenCalledWith(1, 2, 1);
    expect(client.resize).toHaveBeenCalledOnce();
    expect(client.resize).toHaveBeenCalledWith(800, 600, 120);
  });

  it("passes 0 for a size with no dpi, so the client keeps its own", () => {
    const { core, client } = setup();
    input(core, "owner", "size", "800", "600");
    expect(client.resize).toHaveBeenCalledWith(800, 600, 0);
  });

  it("pastes clipboard text from a client stream", () => {
    const { core, client } = setup();
    input(core, "owner", "clipboard", "5", "text/plain");
    input(core, "owner", "blob", "5", Buffer.from("héllo").toString("base64"));
    input(core, "owner", "end", "5");
    expect(client.clipboard).toHaveBeenCalledWith("héllo");
  });

  it("normalizes clipboard line endings both ways", async () => {
    const { core, client, host, posted } = setup({
      "normalize-clipboard": "windows",
    });
    input(core, "owner", "clipboard", "5", "text/plain");
    input(core, "owner", "blob", "5", Buffer.from("a\nb").toString("base64"));
    input(core, "owner", "end", "5");
    expect(client.clipboard).toHaveBeenCalledWith("a\r\nb");
    host().clipboard("c\nd");
    await new Promise((r) => setImmediate(r));
    expect(JSON.stringify(posted)).toContain(
      Buffer.from("c\r\nd").toString("base64"),
    );
  });

  it("honors disable-paste and disable-copy", async () => {
    const { core, client, host, posted } = setup({
      "disable-paste": "true",
      "disable-copy": "true",
    });
    input(core, "owner", "clipboard", "5", "text/plain");
    input(core, "owner", "end", "5");
    expect(client.clipboard).not.toHaveBeenCalled();
    host().clipboard("secret");
    await new Promise((r) => setImmediate(r));
    expect(JSON.stringify(posted)).not.toContain("clipboard");
  });

  it("lists the drive and streams a file to the owner only", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    const { core, host, to } = setup({ "enable-drive": "true" }, dir);
    host().ready();
    expect(to("owner")).toContain("10.filesystem,1.1,12.Shared Drive;");

    input(core, "owner", "get", "1", "/");
    const listing = to("owner");
    expect(listing).toContain(STREAM_INDEX_MIMETYPE);
    expect(listing).toContain(
      Buffer.from('{"/a.txt"').toString("base64").slice(0, 8),
    );

    input(core, "owner", "get", "1", "/a.txt");
    expect(to("owner")).toContain(Buffer.from("hello").toString("base64"));

    core.handle({ t: "join", user: "viewer", owner: false, readOnly: true });
    input(core, "viewer", "get", "1", "/a.txt");
    expect(to("viewer")).not.toContain("body");
  });

  it("takes uploads into the drive and refuses paths outside it", () => {
    const dir = tmp();
    const { core, to } = setup({ "enable-drive": "true" }, dir);
    input(core, "owner", "file", "3", "application/octet-stream", "up.txt");
    input(core, "owner", "blob", "3", Buffer.from("data").toString("base64"));
    input(core, "owner", "end", "3");
    expect(fs.readFileSync(path.join(dir, "up.txt"), "utf8")).toBe("data");

    input(
      core,
      "owner",
      "put",
      "1",
      "4",
      "application/octet-stream",
      "/../escape.txt",
    );
    expect(to("owner")).toContain("3.ack,1.4,");
    expect(fs.existsSync(path.join(dir, "..", "escape.txt"))).toBe(false);
  });

  it("refuses uploads with disable-upload or no drive", () => {
    const { core, to } = setup();
    input(core, "owner", "file", "3", "application/octet-stream", "up.txt");
    expect(to("owner")).toContain(
      "3.ack,1.3,28.File transfer is not enabled,3.256;",
    );
  });

  it("sends a joiner a snapshot once the session is ready", () => {
    const { core, host, to } = setup();
    host().ready();
    core.handle({ t: "join", user: "late", owner: false, readOnly: true });
    expect(to("late")).toContain("4.size,1.0,");
  });

  it("answers a snapshot request with the current screen", () => {
    const { core, host, posted } = setup();
    core.handle({ t: "snapshot" });
    expect(posted.at(-1)).toEqual({ t: "snapshot", data: "" });
    host().ready();
    core.handle({ t: "snapshot" });
    const last = posted.at(-1) as { t: string; data: string };
    expect(last.t).toBe("snapshot");
    expect(last.data).toContain("4.size,1.0,");
  });

  it("reports a client error once", () => {
    const { host, posted } = setup();
    host().fail("nope", 0x203);
    host().fail("again", 0x203);
    expect(posted.filter((m) => m.t === "error")).toHaveLength(1);
  });

  it("streams audio as L16 and switches streams when the format changes", async () => {
    const { host, posted } = setup();
    host().audio(44100, 2, new Uint8Array([1, 2, 3, 4]));
    host().audio(44100, 2, new Uint8Array([5, 6]));
    host().audio(22050, 1, new Uint8Array([7, 8]));
    await new Promise((r) => setImmediate(r));
    const text = posted.map((m) => (m.t === "out" ? m.data : "")).join("");
    expect(text.match(/5\.audio,/g)).toHaveLength(2);
    expect(text).toContain("audio/L16;rate=44100,channels=2");
    expect(text).toContain("audio/L16;rate=22050,channels=1");
  });
});

describe("DriveFolder", () => {
  it("keeps every path inside the folder", () => {
    const dir = tmp();
    const drive = new DriveFolder(dir);
    expect(drive.resolve("/a/b.txt")).toBe(path.join(drive.root, "a", "b.txt"));
    expect(drive.resolve("\\a\\b.txt")).toBe(
      path.join(drive.root, "a", "b.txt"),
    );
    expect(drive.resolve("/../x")).toBeNull();
    expect(drive.resolve("/a/../../x")).toBeNull();
    expect(drive.resolve("/a\0b")).toBeNull();
  });

  it("refuses a symlink that leads out", () => {
    const dir = tmp();
    const outside = tmp();
    try {
      fs.symlinkSync(outside, path.join(dir, "link"), "junction");
    } catch {
      return;
    }
    const drive = new DriveFolder(dir);
    expect(drive.resolve("/link/file")).toBeNull();
  });

  it("lists a folder as guacd's stream index", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "f"), "");
    const listing = JSON.parse(new DriveFolder(dir).listing("/")!);
    expect(listing).toEqual({
      "/sub": STREAM_INDEX_MIMETYPE,
      "/f": "application/octet-stream",
    });
  });
});
