import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchNativeRdp } from "../../src/backend/native-rdp";

let dir: string | null = null;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("launchNativeRdp", () => {
  it("writes the .rdp file in its own data folder and has the app open it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-native-"));
    const open = vi.fn(async (file: string) => {
      expect(fs.readFileSync(file, "utf8")).toContain(
        "full address:s:server.example.com:3389",
      );
    });
    const result = await launchNativeRdp(
      { host: "server.example.com", port: 3389 },
      { dataDir: async () => dir!, open },
      "win32",
    );
    expect(result).toEqual({ success: true });
    const opened = open.mock.calls[0][0];
    expect(opened.startsWith(path.join(dir, "native-rdp"))).toBe(true);
    expect(path.basename(opened)).toBe("connection.rdp");
  });

  it("reports a failed open and cleans up", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-native-"));
    const result = await launchNativeRdp(
      { host: "server.example.com", port: 3389 },
      {
        dataDir: async () => dir!,
        open: async () => {
          throw new Error("no handler for .rdp");
        },
      },
      "win32",
    );
    expect(result).toEqual({ success: false, error: "no handler for .rdp" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(path.join(dir, "native-rdp"))).toEqual([]);
  });

  it("is Windows only", async () => {
    const open = vi.fn();
    const result = await launchNativeRdp(
      { host: "h" },
      { dataDir: async () => "/x", open },
      "linux",
    );
    expect(result.success).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
