import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriveCallbacks,
  NT,
  globToRegex,
} from "../../../../../src/backend/engine/worker/rdp/drive.js";
import { DriveFolder } from "../../../../../src/backend/engine/worker/filesystem.js";

// CreateDisposition and options, as the server sends them.
const OPEN = 1;
const CREATE = 2;
const OPEN_IF = 3;
const OVERWRITE_IF = 5;
const DIRECTORY = 0x1;
const NON_DIRECTORY = 0x40;
const READ = 0x1;
const WRITE = 0x2;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rdpdr-"));
  dirs.push(dir);
  const onDownload = vi.fn();
  const drive = new DriveCallbacks(new DriveFolder(dir), onDownload);
  return { dir, drive, onDownload };
}

describe("DriveCallbacks", () => {
  it("makes the Download folder", () => {
    const { dir } = setup();
    expect(fs.statSync(path.join(dir, "Download")).isDirectory()).toBe(true);
  });

  it("creates, writes, reads and closes a file", () => {
    const { dir, drive } = setup();
    const created = drive.create("\\a.txt", CREATE, NON_DIRECTORY, WRITE);
    expect(created.status).toBe(NT.SUCCESS);
    expect(drive.write(created.handle!, 0, Buffer.from("hello"))).toBe(5);
    drive.close(created.handle!);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("hello");

    const opened = drive.create("\\a.txt", OPEN, 0, READ);
    const read = drive.read(opened.handle!, 1, 3);
    expect(Buffer.from(read as Uint8Array).toString()).toBe("ell");
    expect(drive.info(opened.handle!)).toMatchObject({
      name: "a.txt",
      size: 5,
      dir: false,
    });
  });

  it("follows each create disposition", () => {
    const { drive } = setup();
    expect(drive.create("\\none", OPEN, 0, READ).status).toBe(NT.NO_SUCH_FILE);
    expect(drive.create("\\f", OPEN_IF, 0, WRITE)).toMatchObject({
      status: 0,
      information: 0,
    });
    expect(drive.create("\\f", CREATE, 0, WRITE).status).toBe(
      NT.OBJECT_NAME_COLLISION,
    );
    expect(drive.create("\\f", OVERWRITE_IF, 0, WRITE)).toMatchObject({
      status: 0,
      information: 3,
    });
    expect(drive.create("\\f", OPEN, DIRECTORY, READ).status).toBe(
      NT.NOT_A_DIRECTORY,
    );
    expect(drive.create("\\d", CREATE, DIRECTORY, READ)).toMatchObject({
      status: 0,
    });
    expect(drive.create("\\d", OPEN, NON_DIRECTORY, READ).status).toBe(
      NT.FILE_IS_A_DIRECTORY,
    );
    expect(drive.create("\\missing\\f", CREATE, 0, WRITE).status).toBe(
      NT.OBJECT_PATH_NOT_FOUND,
    );
  });

  it("refuses paths outside the drive", () => {
    const { drive } = setup();
    expect(drive.create("\\..\\..\\etc\\passwd", OPEN, 0, READ).status).toBe(
      NT.ACCESS_DENIED,
    );
    const handle = drive.create("\\f", CREATE, 0, WRITE).handle!;
    expect(drive.set(handle, "rename", "\\..\\out", false)).toBe(
      NT.ACCESS_DENIED,
    );
  });

  it("lists a folder with a mask", () => {
    const { dir, drive } = setup();
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    fs.writeFileSync(path.join(dir, "b.log"), "1");
    const root = drive.create("\\", OPEN, DIRECTORY, READ).handle!;
    expect(
      drive
        .list(root, "\\*")!
        .map((f) => f.name)
        .sort(),
    ).toEqual(["Download", "a.txt", "b.log"]);
    expect(drive.list(root, "\\*.TXT")!.map((f) => f.name)).toEqual(["a.txt"]);
    expect(drive.list(root, "\\b.log")![0]).toMatchObject({
      name: "b.log",
      size: 1,
    });
    expect(drive.list(root, "\\nope")).toBeNull();
  });

  it("renames, truncates and deletes on close", () => {
    const { dir, drive } = setup();
    const handle = drive.create("\\f", CREATE, 0, WRITE).handle!;
    drive.write(handle, 0, Buffer.from("123456"));
    expect(drive.set(handle, "truncate", 2, undefined)).toBe(NT.SUCCESS);
    expect(drive.set(handle, "rename", "\\g", false)).toBe(NT.SUCCESS);
    drive.close(handle);
    expect(fs.readFileSync(path.join(dir, "g"), "utf8")).toBe("12");

    const again = drive.create("\\g", OPEN, 0, WRITE).handle!;
    expect(drive.set(again, "delete", true, undefined)).toBe(NT.SUCCESS);
    drive.close(again);
    expect(fs.existsSync(path.join(dir, "g"))).toBe(false);
  });

  it("refuses to delete a folder that isn't empty", () => {
    const { dir, drive } = setup();
    fs.mkdirSync(path.join(dir, "d"));
    fs.writeFileSync(path.join(dir, "d", "x"), "");
    const handle = drive.create("\\d", OPEN, DIRECTORY, READ).handle!;
    expect(drive.set(handle, "delete", true, undefined)).toBe(
      NT.DIRECTORY_NOT_EMPTY,
    );
  });

  it("sends files written to Download and removes them", () => {
    const { dir, drive, onDownload } = setup();
    const handle = drive.create("\\Download\\r.pdf", CREATE, 0, WRITE).handle!;
    drive.write(handle, 0, Buffer.from("%PDF"));
    drive.close(handle);
    expect(onDownload).toHaveBeenCalledWith("r.pdf", Buffer.from("%PDF"));
    expect(fs.existsSync(path.join(dir, "Download", "r.pdf"))).toBe(false);

    // Reading a file there doesn't send it.
    fs.writeFileSync(path.join(dir, "Download", "keep"), "x");
    drive.close(drive.create("\\Download\\keep", OPEN, 0, READ).handle!);
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("reports bad handles", () => {
    const { drive } = setup();
    expect(drive.read(99, 0, 1)).toBe(NT.INVALID_HANDLE);
    expect(drive.write(99, 0, new Uint8Array(1))).toBe(-1);
    expect(drive.info(99)).toBeNull();
    expect(drive.volume().total).toBeGreaterThan(0);
  });
});

describe("globToRegex", () => {
  it("matches Windows masks", () => {
    expect(globToRegex("*").test("x")).toBe(true);
    expect(globToRegex("*.txt").test("A.TXT")).toBe(true);
    expect(globToRegex("a?c").test("abc")).toBe(true);
    expect(globToRegex("a.c").test("abc")).toBe(false);
  });
});
