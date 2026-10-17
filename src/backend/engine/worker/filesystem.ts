import fs from "node:fs";
import path from "node:path";

export const STREAM_INDEX_MIMETYPE =
  "application/vnd.glyptodon.guacamole.stream-index+json";

/**
 * The per-user drive folder. Every path a client or the RDP server names is
 * resolved inside it, and nothing may leave it, through `..` or a symlink.
 */
export class DriveFolder {
  readonly root: string;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
  }

  /** A client path like "/Download/a.txt" to a real path, or null if it escapes. */
  resolve(clientPath: string): string | null {
    const parts = clientPath
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === ".." || part.includes("\0"))) return null;
    const full = path.join(this.root, ...parts);
    if (!this.inside(full)) return null;
    // An existing path (or its nearest existing parent) must not be a
    // symlink that points outside.
    let probe = full;
    while (!fs.existsSync(probe) && probe !== this.root) {
      probe = path.dirname(probe);
    }
    try {
      if (!this.inside(fs.realpathSync(probe))) return null;
    } catch {
      return null;
    }
    return full;
  }

  private inside(full: string): boolean {
    const relative = path.relative(this.root, full);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  /** The stream-index JSON guacd sends for a directory. */
  listing(clientPath: string): string | null {
    const dir = this.resolve(clientPath);
    if (!dir) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const base = clientPath.endsWith("/") ? clientPath : `${clientPath}/`;
    const index: Record<string, string> = {};
    for (const entry of entries) {
      const key = `${base.startsWith("/") ? base : `/${base}`}${entry.name}`;
      index[key] = entry.isDirectory()
        ? STREAM_INDEX_MIMETYPE
        : "application/octet-stream";
    }
    return JSON.stringify(index);
  }

  isDirectory(clientPath: string): boolean {
    const full = this.resolve(clientPath);
    try {
      return !!full && fs.statSync(full).isDirectory();
    } catch {
      return false;
    }
  }
}
