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

  it("compresses repeating screen content in PNG frames", () => {
    const wasm = loadWasm(new WebAssembly.Module(wasmBytes as BufferSource));
    const size = 256;
    const surface = new wasm.Surface(size, size);
    const pixels = surfaceView(wasm, surface);
    // Dark marks repeating on a light background, like lines of text.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const value = ((x % 8) * 3 + (y % 12) * 5) % 7 < 2 ? 20 : 235;
        pixels.fill(value, i, i + 3);
        pixels[i + 3] = 255;
      }
    }
    const png = surface.encode_png(0, 0, size, size, false);
    // Huffman-only deflate kept this near raw size, a frame's worth per repaint.
    expect(png.length).toBeLessThan((size * size * 3) / 4);
    surface.free();
  });
});
