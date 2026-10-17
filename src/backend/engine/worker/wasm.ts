import * as glue from "../wasm/engine.js";

export type Wasm = typeof glue & { memory: WebAssembly.Memory };

let instance: Wasm | null = null;

/** Instantiates the engine module once per thread. */
export function loadWasm(module: WebAssembly.Module): Wasm {
  if (instance) return instance;
  const exports = glue.initSync({ module }) as unknown as {
    memory: WebAssembly.Memory;
  };
  instance = Object.assign(Object.create(null), glue, {
    memory: exports.memory,
  }) as Wasm;
  return instance;
}

/** A writable view of a Surface's pixels. Make a fresh one after any WASM call. */
export function surfaceView(wasm: Wasm, surface: glue.Surface): Uint8Array {
  return new Uint8Array(wasm.memory.buffer, surface.ptr(), surface.len());
}
