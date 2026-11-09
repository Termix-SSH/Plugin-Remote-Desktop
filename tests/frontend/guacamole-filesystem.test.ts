import { describe, expect, it, vi } from "vitest";
import {
  describeUploadError,
  listDirectory,
} from "../../src/frontend/guacamole-filesystem";

const t = (key: string) => `#${key}`;

describe("describeUploadError", () => {
  it("explains guacd's refusal to open the target file as a drive-folder problem", () => {
    expect(describeUploadError(new Error("FAIL (CANNOT OPEN)"), t)).toBe(
      "#driveNotWritable",
    );
    expect(describeUploadError(new Error("FAIL (NO FS)"), t)).toBe(
      "#driveUnavailable",
    );
  });

  it("passes other messages through and falls back for unknown errors", () => {
    expect(describeUploadError(new Error("disk full"), t)).toBe("disk full");
    expect(describeUploadError(undefined, t)).toBe("#uploadFailed");
  });
});

describe("listDirectory", () => {
  it("rejects when a folder stream never ends", async () => {
    vi.useFakeTimers();
    const fs = {
      requestInputStream: (_p: string, cb: (s: unknown, m: string) => void) =>
        cb({}, "application/vnd.glyptodon.guacamole.stream-index+json"),
    };
    const done = listDirectory(fs as never, "/").catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(16000);
    expect(await done).toContain("Timed out");
    vi.useRealTimers();
  });
});
