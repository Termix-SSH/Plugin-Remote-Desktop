import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** Largest KDC reply we take. Real ones are a few KB. */
const MAX_REPLY = 1024 * 1024;
const TIMEOUT_MS = 15000;

/**
 * The worker file: bundled next to the engine worker in a build, the .mjs
 * beside this file when running from source. A worker must start from a file
 * in a plugin process.
 */
function kdcWorkerUrl(): URL {
  const built = new URL("./kdc.js", import.meta.url);
  try {
    if (fs.existsSync(fileURLToPath(built))) return built;
  } catch {
    // not a file URL
  }
  return new URL("./kdc-worker.mjs", import.meta.url);
}

/**
 * Kerberos asks for KDC round trips in the middle of a synchronous WASM call,
 * so each one runs in a short lived worker thread the caller blocks on. No
 * child process is started, since the desktop app's binary can't run as node.
 */
export function kerberosRequest(
  protocol: number,
  url: string,
  data: Uint8Array,
  timeoutMs = TIMEOUT_MS,
): Uint8Array {
  const signal = new SharedArrayBuffer(8);
  const out = new SharedArrayBuffer(MAX_REPLY);
  const flag = new Int32Array(signal);
  const worker = new Worker(kdcWorkerUrl(), {
    workerData: {
      proto: protocol,
      url,
      data: Uint8Array.from(data),
      signal,
      out,
    },
  });
  worker.on("error", () => {
    // Reported through the shared buffer or the timeout below.
  });
  try {
    const waited = Atomics.wait(flag, 0, 0, timeoutMs);
    const state = Atomics.load(flag, 0);
    if (waited === "timed-out" && state === 0) {
      throw new Error("KDC request timed out");
    }
    const length = Atomics.load(flag, 1);
    const reply = Buffer.from(new Uint8Array(out, 0, length));
    if (state !== 1) {
      throw new Error(reply.toString("utf8") || "KDC request failed");
    }
    return new Uint8Array(reply);
  } finally {
    void worker.terminate();
  }
}
