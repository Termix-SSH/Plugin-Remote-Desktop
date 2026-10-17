import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import wasmBytes from "../../../src/backend/engine/wasm/engine_bg.wasm";
import { engineSourceHash } from "../../../scripts/engine-hash.mjs";
import {
  loadWasm,
  surfaceView,
} from "../../../src/backend/engine/worker/wasm.js";

const root = path.resolve(__dirname, "../../..");

describe("engine module", () => {
  it("was built from the Rust code in this checkout", () => {
    const built = fs
      .readFileSync(
        path.join(root, "src/backend/engine/wasm/source-hash.txt"),
        "utf8",
      )
      .trim();
    // Run `npm run build:engine` after changing native/engine.
    expect(engineSourceHash(path.join(root, "native/engine"))).toBe(built);
  });

  it("encodes a surface as PNG and JPEG", () => {
    const wasm = loadWasm(new WebAssembly.Module(wasmBytes as BufferSource));
    const surface = new wasm.Surface(4, 4);
    surface.fill(0, 0, 4, 4, 0xff0000ff);
    expect(surfaceView(wasm, surface).subarray(0, 4)).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );
    const png = surface.encode_png(0, 0, 4, 4, false);
    expect(Buffer.from(png.subarray(1, 4)).toString()).toBe("PNG");
    const jpeg = surface.encode_jpeg(0, 0, 4, 4, 80);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    surface.copy_rect(0, 0, 2, 2, 2, 2);
    surface.free();
  });
});
