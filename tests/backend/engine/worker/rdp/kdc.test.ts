import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kerberosRequest } from "../../../../../src/backend/engine/worker/rdp/kdc.js";

// A stand in KDC on its own thread, since the request blocks this one. TCP
// answers with a length prefixed reply, UDP with the request reversed.
const KDC = `
const { parentPort } = require("node:worker_threads");
const net = require("node:net");
const dgram = require("node:dgram");
const tcp = net.createServer((socket) => {
  socket.once("data", (data) => {
    const body = Buffer.concat([Buffer.from("tcp:"), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    socket.end(Buffer.concat([head, body]));
  });
});
const udp = dgram.createSocket("udp4");
udp.on("message", (msg, from) => udp.send(Buffer.from(msg).reverse(), from.port, from.address));
tcp.listen(0, "127.0.0.1", () => {
  udp.bind(0, "127.0.0.1", () => {
    parentPort.postMessage({ tcp: tcp.address().port, udp: udp.address().port });
  });
});
`;

let kdc: Worker;
let ports = { tcp: 0, udp: 0 };

beforeAll(async () => {
  kdc = new Worker(KDC, { eval: true });
  ports = await new Promise((resolve) => kdc.once("message", resolve));
});

afterAll(() => kdc.terminate());

describe("kerberosRequest", () => {
  it("does a TCP round trip", () => {
    const reply = kerberosRequest(
      0,
      `tcp://127.0.0.1:${ports.tcp}`,
      new Uint8Array([1, 2, 3]),
    );
    const body = Buffer.from(reply).subarray(4).toString("latin1");
    expect(body).toBe("tcp:\u0001\u0002\u0003");
  });

  it("does a UDP round trip", () => {
    const reply = kerberosRequest(
      1,
      `udp://127.0.0.1:${ports.udp}`,
      new Uint8Array([1, 2, 3]),
    );
    expect([...reply]).toEqual([3, 2, 1]);
  });

  it("times out instead of hanging", () => {
    expect(() =>
      kerberosRequest(1, "udp://127.0.0.1:9", new Uint8Array([1]), 500),
    ).toThrow(/time/);
  });

  it("reports a refused connection as an error", () => {
    expect(() =>
      kerberosRequest(0, "tcp://127.0.0.1:1", new Uint8Array([1]), 5000),
    ).toThrow();
  });

  it("never starts a child process", () => {
    const source = fs.readFileSync(
      "src/backend/engine/worker/rdp/kdc.ts",
      "utf8",
    );
    expect(source).not.toMatch(/child_process|execPath|spawn/);
  });
});
