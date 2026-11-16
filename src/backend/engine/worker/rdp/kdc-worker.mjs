// One KDC round trip on its own thread. Writes the reply (or the error text)
// into the shared buffer and wakes the caller. state: 1 reply, 2 error.
// Plain JS so it runs as is from the source tree; the build bundles it into
// dist/workers/kdc.js.
import dgram from "node:dgram";
import net from "node:net";
import { workerData } from "node:worker_threads";

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
const fail = (e) => finish(2, Buffer.from(String((e && e.message) || e)));
const done = (b) =>
  b.length > bytes.length ? fail("KDC reply is too large") : finish(1, b);

try {
  const u = new URL(url);
  const payload = Buffer.from(data);
  if (proto === 0) {
    const s = net.connect(Number(u.port) || 88, u.hostname);
    let buf = Buffer.alloc(0);
    s.setTimeout(10000, () => {
      s.destroy();
      fail("timeout");
    });
    s.on("connect", () => s.write(payload));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > bytes.length) {
        s.destroy();
        fail("KDC reply is too large");
        return;
      }
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        s.destroy();
        done(buf);
      }
    });
    s.on("error", fail);
  } else if (proto === 1) {
    const s = dgram.createSocket(u.hostname.includes(":") ? "udp6" : "udp4");
    const t = setTimeout(() => {
      s.close();
      fail("timeout");
    }, 10000);
    s.on("message", (m) => {
      clearTimeout(t);
      s.close();
      done(m);
    });
    s.send(payload, Number(u.port) || 88, u.hostname, (e) => e && fail(e));
  } else {
    fetch(url, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/kerberos" },
    })
      .then((r) => r.arrayBuffer())
      .then((b) => done(Buffer.from(b)))
      .catch(fail);
  }
} catch (e) {
  fail(e);
}
