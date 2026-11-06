import { describe, expect, it } from "vitest";
import { RustDeskClient } from "../../../../../src/backend/engine/worker/rustdesk/client.js";
import { Output } from "../../../../../src/backend/engine/worker/output.js";
import { Display } from "../../../../../src/backend/engine/worker/display.js";
import {
  Settings,
  type RemoteHost,
} from "../../../../../src/backend/engine/worker/remote.js";

/**
 * Against a real RustDesk device. Set LIVE_RUSTDESK_ID, LIVE_RUSTDESK_SERVER,
 * LIVE_RUSTDESK_KEY and LIVE_RUSTDESK_PASSWORD (or LIVE_RUSTDESK_DIRECT=host).
 */
const env = process.env;
const live = !!(env.LIVE_RUSTDESK_ID || env.LIVE_RUSTDESK_DIRECT);

describe.runIf(live)("RustDesk live", () => {
  it("logs in and receives video, cursor and audio", async () => {
    const out: string[] = [];
    const events: string[] = [];
    const output = new Output({
      post: (m) => {
        if (m.t === "out") out.push(m.data);
      },
    });
    const display = new Display(output, { rgbaPng: () => new Uint8Array(0) });
    display.addUser("u");
    let audioBytes = 0;
    let failed = "";
    let ready = false;
    const host: RemoteHost = {
      out: output,
      display,
      wasm: null as never,
      settings: new Settings({
        "rustdesk-id": env.LIVE_RUSTDESK_ID ?? "",
        "id-server": env.LIVE_RUSTDESK_SERVER ?? "",
        "relay-server": env.LIVE_RUSTDESK_RELAY ?? "",
        "server-key": env.LIVE_RUSTDESK_KEY ?? "",
        password: env.LIVE_RUSTDESK_PASSWORD ?? "",
        direct: env.LIVE_RUSTDESK_DIRECT ? "true" : "false",
        hostname: env.LIVE_RUSTDESK_DIRECT ?? "",
        codecs: "vp9,av1,vp8",
      }),
      drive: null,
      log: (level, message, meta) =>
        events.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`),
      ready: () => {
        ready = true;
      },
      fail: (message) => {
        failed = message;
      },
      closed: () => events.push("closed"),
      clipboard: (text) => events.push(`clipboard ${text}`),
      sendFile: () => {},
      audio: (_r, _c, pcm) => {
        audioBytes += pcm.length;
      },
    };
    const client = new RustDeskClient(host);
    client.start();
    const end = Date.now() + 30_000;
    let acked = 0;
    while (Date.now() < end && !failed) {
      await new Promise((r) => setTimeout(r, 100));
      display.ack("u", Date.now());
      if (ready) {
        client.mouse(200, 200, 0);
        acked++;
      }
      if (out.join("").includes("blob") && acked > 30) break;
    }
    client.stop();
    const all = out.join("");
    console.log(events.join("\n"));
    console.log("output bytes", all.length, "audio bytes", audioBytes);
    console.log(all.slice(0, 400));
    expect(failed).toBe("");
    expect(ready).toBe(true);
    expect(all).toContain("video/x-termix-rustdesk");
  }, 40_000);
});
