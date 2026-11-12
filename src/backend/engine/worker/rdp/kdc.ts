import { Worker } from "node:worker_threads";

/** Largest KDC reply we take. Real ones are a few KB. */
const MAX_REPLY = 1024 * 1024;
const TIMEOUT_MS = 15000;

// Runs in a worker thread. Writes the reply (or the error text) into the
// shared buffer and wakes the caller. state: 1 reply, 2 error.
const KDC_WORKER = `
const { workerData } = require("node:worker_threads");
const { proto, url, data, signal, out } = workerData;
const flag = new Int32Array(signal);
const bytes = new Uint8Array(out);
let finished = false;
const finish = (state, buf) => {
  if (finished) return;
  finished = true;
  const n = Math.min(buf.length, bytes.length);
  bytes.set(buf.subarray(0, n));
  Atomics.store(flag, 1, n);
  Atomics.store(flag, 0, state);
  Atomics.notify(flag, 0);
};
const done = (b) =>
  b.length > bytes.length ? fail("KDC reply is too large") : finish(1, b);
const fail = (e) => finish(2, Buffer.from(String((e && e.message) || e)));
try {
  const u = new URL(url);
  const payload = Buffer.from(data);
  if (proto === 0) {
    const s = require("node:net").connect(Number(u.port) || 88, u.hostname);
    let buf = Buffer.alloc(0);
    s.setTimeout(10000, () => { s.destroy(); fail("timeout"); });
    s.on("connect", () => s.write(payload));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > bytes.length) { s.destroy(); fail("KDC reply is too large"); return; }
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { s.destroy(); done(buf); }
    });
    s.on("error", fail);
  } else if (proto === 1) {
    const s = require("node:dgram").createSocket(u.hostname.includes(":") ? "udp6" : "udp4");
    const t = setTimeout(() => { s.close(); fail("timeout"); }, 10000);
    s.on("message", (m) => { clearTimeout(t); s.close(); done(m); });
    s.send(payload, Number(u.port) || 88, u.hostname, (e) => e && fail(e));
  } else {
    fetch(url, { method: "POST", body: payload, headers: { "content-type": "application/kerberos" } })
      .then((r) => r.arrayBuffer())
      .then((b) => done(Buffer.from(b)))
      .catch(fail);
  }
} catch (e) {
  fail(e);
}
`;

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
  const worker = new Worker(KDC_WORKER, {
    eval: true,
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
