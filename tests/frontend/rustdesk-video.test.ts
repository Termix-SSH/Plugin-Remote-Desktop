import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rustdeskVideoPlayer,
  supportedRustdeskCodecs,
} from "../../src/frontend/rustdesk-video";
import { rustdeskPromptFor } from "../../src/frontend/RustdeskLoginPrompt";

type Chunk = { type: string; data: Uint8Array };

function installDecoder(supported: string[] = ["vp09.00.10.08"]) {
  const decoded: Chunk[] = [];
  const configs: unknown[] = [];
  class FakeDecoder {
    state = "configured";
    decodeQueueSize = 0;
    static isConfigSupported = async ({ codec }: { codec: string }) => ({
      supported: supported.includes(codec),
    });
    constructor(_init: unknown) {}
    configure(config: unknown) {
      configs.push(config);
    }
    decode(chunk: Chunk) {
      decoded.push(chunk);
    }
    close() {
      this.state = "closed";
    }
  }
  class FakeChunk {
    type: string;
    data: Uint8Array;
    constructor(init: { type: string; data: Uint8Array }) {
      this.type = init.type;
      this.data = init.data;
    }
  }
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", FakeChunk);
  return { decoded, configs };
}

afterEach(() => vi.unstubAllGlobals());

function stream() {
  return {
    onblob: null as null | ((data: string) => void),
    onend: null as null | (() => void),
    sendAck: () => {},
  };
}

const layer = {
  getCanvas: () => document.createElement("canvas"),
  width: 0,
  height: 0,
};

const blob = (flags: number, bytes: number[]) =>
  Buffer.from([flags, ...bytes]).toString("base64");

describe("rustdeskVideoPlayer", () => {
  it("leaves other video types alone", () => {
    installDecoder();
    const s = stream();
    expect(
      rustdeskVideoPlayer(s as never, layer as never, "video/mp4", () => {}),
    ).toBeNull();
  });

  it("joins chunks and waits for a key frame", () => {
    const { decoded, configs } = installDecoder();
    const s = stream();
    const player = rustdeskVideoPlayer(
      s as never,
      layer as never,
      "video/x-termix-rustdesk;codec=vp9",
      () => {},
    );
    expect(player).not.toBeNull();
    expect(configs[0]).toMatchObject({ codec: "vp09.00.10.08" });
    s.onblob!(blob(2, [9]));
    expect(decoded).toHaveLength(0);
    s.onblob!(blob(1, [1, 2]));
    s.onblob!(blob(3, [3]));
    s.onblob!(blob(2, [4]));
    expect(decoded.map((c) => c.type)).toEqual(["key", "delta"]);
    expect([...decoded[0].data]).toEqual([1, 2, 3]);
  });

  it("reports a browser with no WebCodecs", () => {
    const onError = vi.fn();
    const s = stream();
    expect(
      rustdeskVideoPlayer(
        s as never,
        layer as never,
        "video/x-termix-rustdesk;codec=vp9",
        onError,
      ),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith("unsupported");
  });

  it("lists the codecs the browser decodes", async () => {
    installDecoder(["vp09.00.10.08", "vp8"]);
    expect(await supportedRustdeskCodecs()).toBe("vp9,vp8");
  });
});

describe("rustdeskPromptFor", () => {
  it("knows the engine's login errors", () => {
    expect(rustdeskPromptFor("rustdesk-password-wrong")).toEqual({
      kind: "password",
      wrong: true,
    });
    expect(rustdeskPromptFor("rustdesk-2fa-required")).toEqual({
      kind: "code",
      wrong: false,
    });
    expect(rustdeskPromptFor("Something else")).toBeNull();
  });
});
