import fs from "node:fs";
import path from "node:path";
import type { DriveFolder } from "../filesystem.js";

// NTSTATUS values the RDPDR replies carry.
export const NT = {
  SUCCESS: 0,
  UNSUCCESSFUL: 0xc0000001,
  INVALID_HANDLE: 0xc0000008,
  NO_SUCH_FILE: 0xc000000f,
  ACCESS_DENIED: 0xc0000022,
  OBJECT_NAME_INVALID: 0xc0000033,
  OBJECT_NAME_COLLISION: 0xc0000035,
  OBJECT_PATH_NOT_FOUND: 0xc000003a,
  FILE_IS_A_DIRECTORY: 0xc00000ba,
  NOT_SUPPORTED: 0xc00000bb,
  DIRECTORY_NOT_EMPTY: 0xc0000101,
  NOT_A_DIRECTORY: 0xc0000103,
} as const;

// MS-SMB2 CreateDisposition.
const SUPERSEDE = 0;
const OPEN = 1;
const CREATE = 2;
const OPEN_IF = 3;
const OVERWRITE = 4;
const OVERWRITE_IF = 5;
// CreateOptions.
const DIRECTORY_FILE = 0x1;
const NON_DIRECTORY_FILE = 0x40;
const DELETE_ON_CLOSE = 0x1000;
// DesiredAccess bits that need write access.
const WRITE_ACCESS = 0x2 | 0x4 | 0x40000000 | 0x10000000 | 0x00010000;

// Information values for a create.
const FILE_SUPERSEDED = 0;
const FILE_OPENED = 1;
const FILE_OVERWRITTEN = 3;

/** Files in this folder go to the browser as downloads, then leave the drive. */
export const DOWNLOAD_FOLDER = "Download";
/** Bigger files stay on the drive, for the file browser to fetch instead. */
export const MAX_AUTO_DOWNLOAD = 512 * 1024 * 1024;

interface Handle {
  /** Drive-relative path, with forward slashes. */
  client: string;
  full: string;
  dir: boolean;
  fd: number | null;
  written: boolean;
  deleteOnClose: boolean;
}

export interface DriveFile {
  name: string;
  size: number;
  dir: boolean;
  readonly: boolean;
  ctime: number;
  atime: number;
  mtime: number;
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "";
}

function statusOf(error: unknown): number {
  switch (code(error)) {
    case "ENOENT":
      return NT.NO_SUCH_FILE;
    case "EEXIST":
      return NT.OBJECT_NAME_COLLISION;
    case "EACCES":
    case "EPERM":
      return NT.ACCESS_DENIED;
    case "ENOTDIR":
      return NT.NOT_A_DIRECTORY;
    case "EISDIR":
      return NT.FILE_IS_A_DIRECTORY;
    case "ENOTEMPTY":
      return NT.DIRECTORY_NOT_EMPTY;
    default:
      return NT.UNSUCCESSFUL;
  }
}

function toClient(rdpPath: string): string {
  return `/${rdpPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function fileInfo(name: string, stat: fs.Stats): DriveFile {
  return {
    name,
    size: stat.isDirectory() ? 0 : stat.size,
    dir: stat.isDirectory(),
    readonly: (stat.mode & 0o200) === 0,
    ctime: stat.birthtimeMs || stat.ctimeMs,
    atime: stat.atimeMs,
    mtime: stat.mtimeMs,
  };
}

/**
 * What the WASM RDPDR backend calls for every drive request. Paths come from
 * the RDP server and are resolved inside the user's drive folder only.
 */
export class DriveCallbacks {
  private readonly handles = new Map<number, Handle>();
  private nextId = 1;

  constructor(
    private readonly drive: DriveFolder,
    private readonly onDownload: (name: string, bytes: Buffer) => void,
  ) {
    try {
      fs.mkdirSync(path.join(drive.root, DOWNLOAD_FOLDER), { recursive: true });
    } catch {
      // The drive still works without it.
    }
  }

  /** The functions handed to the WASM client, by the names it calls. */
  host(): Record<string, (...args: never[]) => unknown> {
    return {
      fs_create: (
        p: string,
        disposition: number,
        options: number,
        access: number,
      ) => this.create(p, disposition, options, access),
      fs_read: (id: number, offset: number, length: number) =>
        this.read(id, offset, length),
      fs_write: (id: number, offset: number, data: Uint8Array) =>
        this.write(id, offset, data),
      fs_close: (id: number) => this.close(id),
      fs_info: (id: number) => this.info(id),
      fs_list: (id: number, pattern: string) => this.list(id, pattern),
      fs_set: (id: number, kind: string, value: unknown, extra: unknown) =>
        this.set(id, kind, value, extra),
      fs_volume: () => this.volume(),
      fs_reset: () => this.reset(),
    };
  }

  create(
    rdpPath: string,
    disposition: number,
    options: number,
    access: number,
  ): { status: number; handle?: number; information?: number } {
    const client = toClient(rdpPath);
    const full = this.drive.resolve(client);
    if (!full) return { status: NT.ACCESS_DENIED };
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(full);
    } catch {
      stat = null;
    }
    const wantsDir = (options & DIRECTORY_FILE) !== 0;
    const wantsFile = (options & NON_DIRECTORY_FILE) !== 0;
    const deleteOnClose = (options & DELETE_ON_CLOSE) !== 0;
    const open = (dir: boolean, fd: number | null, information: number) => {
      const id = this.nextId++;
      this.handles.set(id, {
        client,
        full,
        dir,
        fd,
        written: false,
        deleteOnClose,
      });
      return { status: NT.SUCCESS, handle: id, information };
    };

    if (stat?.isDirectory()) {
      if (disposition === CREATE) return { status: NT.OBJECT_NAME_COLLISION };
      if (wantsFile) return { status: NT.FILE_IS_A_DIRECTORY };
      return open(true, null, FILE_OPENED);
    }
    if (stat && wantsDir) return { status: NT.NOT_A_DIRECTORY };
    if (!stat && wantsDir) {
      if (disposition !== CREATE && disposition !== OPEN_IF) {
        return { status: NT.NO_SUCH_FILE };
      }
      try {
        fs.mkdirSync(full);
      } catch (error) {
        return { status: statusOf(error) };
      }
      return open(true, null, FILE_SUPERSEDED);
    }

    const writable = (access & WRITE_ACCESS) !== 0;
    let flags: string;
    let information = FILE_OPENED;
    switch (disposition) {
      case OPEN:
        if (!stat) return { status: NT.NO_SUCH_FILE };
        flags = writable ? "r+" : "r";
        break;
      case CREATE:
        if (stat) return { status: NT.OBJECT_NAME_COLLISION };
        flags = "wx+";
        information = FILE_SUPERSEDED;
        break;
      case OPEN_IF:
        flags = stat ? (writable ? "r+" : "r") : "w+";
        information = stat ? FILE_OPENED : FILE_SUPERSEDED;
        break;
      case OVERWRITE:
        if (!stat) return { status: NT.NO_SUCH_FILE };
        flags = "w+";
        information = FILE_OVERWRITTEN;
        break;
      case OVERWRITE_IF:
        flags = "w+";
        information = stat ? FILE_OVERWRITTEN : FILE_SUPERSEDED;
        break;
      case SUPERSEDE:
        flags = "w+";
        information = FILE_SUPERSEDED;
        break;
      default:
        return { status: NT.NOT_SUPPORTED };
    }
    try {
      const fd = fs.openSync(full, flags);
      return open(false, fd, information);
    } catch (error) {
      if (code(error) === "ENOENT") return { status: NT.OBJECT_PATH_NOT_FOUND };
      return { status: statusOf(error) };
    }
  }

  read(id: number, offset: number, length: number): Uint8Array | number {
    const handle = this.handles.get(id);
    if (!handle || handle.fd === null) return NT.INVALID_HANDLE;
    const buffer = Buffer.alloc(Math.min(length, 16 * 1024 * 1024));
    try {
      const n = fs.readSync(handle.fd, buffer, 0, buffer.length, offset);
      return buffer.subarray(0, n);
    } catch (error) {
      return statusOf(error);
    }
  }

  write(id: number, offset: number, data: Uint8Array): number {
    const handle = this.handles.get(id);
    if (!handle || handle.fd === null) return -1;
    try {
      const n = fs.writeSync(handle.fd, data, 0, data.length, offset);
      handle.written = true;
      return n;
    } catch {
      return -1;
    }
  }

  close(id: number): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.handles.delete(id);
    if (handle.fd !== null) {
      try {
        fs.closeSync(handle.fd);
      } catch {
        // Already closed.
      }
    }
    if (handle.deleteOnClose) {
      this.remove(handle);
      return;
    }
    if (handle.written && !handle.dir && this.inDownloads(handle.client)) {
      this.download(handle);
    }
  }

  private inDownloads(client: string): boolean {
    const parts = client.split("/").filter(Boolean);
    return parts.length === 2 && parts[0] === DOWNLOAD_FOLDER;
  }

  /** guacd's Download folder: send the file, then take it off the drive. */
  private download(handle: Handle): void {
    try {
      if (fs.statSync(handle.full).size > MAX_AUTO_DOWNLOAD) return;
      const bytes = fs.readFileSync(handle.full);
      this.onDownload(path.basename(handle.full), bytes);
      fs.rmSync(handle.full, { force: true });
    } catch {
      // Leave it on the drive if it can't be read.
    }
  }

  info(id: number): DriveFile | null {
    const handle = this.handles.get(id);
    if (!handle) return null;
    try {
      const stat =
        handle.fd !== null ? fs.fstatSync(handle.fd) : fs.statSync(handle.full);
      return fileInfo(path.basename(handle.full), stat);
    } catch {
      return null;
    }
  }

  /** A directory query: "\dir\*" lists the folder, anything else names one entry. */
  list(id: number, pattern: string): DriveFile[] | null {
    const handle = this.handles.get(id);
    if (!handle) return null;
    const client = toClient(pattern);
    const wildcard = /[*?]/.test(client);
    if (!wildcard) {
      const full = this.drive.resolve(client);
      if (!full) return null;
      try {
        return [fileInfo(path.basename(full), fs.statSync(full))];
      } catch {
        return null;
      }
    }
    const dirClient = client.slice(0, client.lastIndexOf("/") + 1) || "/";
    const mask = client.slice(client.lastIndexOf("/") + 1);
    const dir = this.drive.resolve(dirClient);
    if (!dir) return null;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const matcher = globToRegex(mask);
    const out: DriveFile[] = [];
    for (const name of names) {
      if (!matcher.test(name)) continue;
      try {
        out.push(fileInfo(name, fs.lstatSync(path.join(dir, name))));
      } catch {
        // Gone since the listing.
      }
    }
    return out;
  }

  set(id: number, kind: string, value: unknown, extra: unknown): number {
    const handle = this.handles.get(id);
    if (!handle) return NT.INVALID_HANDLE;
    try {
      switch (kind) {
        case "rename": {
          const target = this.drive.resolve(toClient(String(value)));
          if (!target) return NT.ACCESS_DENIED;
          if (!extra && fs.existsSync(target)) return NT.OBJECT_NAME_COLLISION;
          fs.renameSync(handle.full, target);
          handle.full = target;
          handle.client = toClient(String(value));
          return NT.SUCCESS;
        }
        case "delete":
          if (handle.dir && fs.readdirSync(handle.full).length > 0) {
            return NT.DIRECTORY_NOT_EMPTY;
          }
          handle.deleteOnClose = value === true;
          return NT.SUCCESS;
        case "truncate":
          if (handle.fd === null) return NT.FILE_IS_A_DIRECTORY;
          fs.ftruncateSync(handle.fd, Number(value));
          return NT.SUCCESS;
        default:
          return NT.NOT_SUPPORTED;
      }
    } catch (error) {
      return statusOf(error);
    }
  }

  volume(): { total: number; free: number } {
    try {
      const stat = fs.statfsSync(this.drive.root);
      return {
        total: stat.blocks * stat.bsize,
        free: stat.bavail * stat.bsize,
      };
    } catch {
      return { total: 1 << 30, free: 1 << 30 };
    }
  }

  reset(): void {
    for (const id of [...this.handles.keys()]) this.close(id);
  }

  private remove(handle: Handle): void {
    try {
      fs.rmSync(handle.full, { recursive: handle.dir, force: true });
    } catch {
      // Already gone.
    }
  }
}

/** A Windows file mask like "*" or "*.txt" as a case-insensitive regex. */
export function globToRegex(mask: string): RegExp {
  if (mask === "" || mask === "*" || mask === "*.*") return /^/;
  const source = mask
    .split("")
    .map((c) =>
      c === "*"
        ? ".*"
        : c === "?"
          ? "."
          : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "i");
}
