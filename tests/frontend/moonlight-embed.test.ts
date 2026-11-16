import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canPlayH264,
  keyboardLockRequest,
} from "../../src/frontend/moonlight-embed";

const STREAM = "https://moonlight.example.com/stream.html?hostId=1&appId=2";

describe("keyboardLockRequest", () => {
  const frame = {} as Window;
  const origin = "https://moonlight.example.com";
  const data = { type: "REQUEST_KEYBOARD_LOCK", keys: ["Escape", 3] };

  it("reads a request from the stream frame", () => {
    expect(
      keyboardLockRequest(
        { data, origin, source: frame as never },
        frame,
        STREAM,
      ),
    ).toEqual(["Escape"]);
  });

  it("locks every key when none are named", () => {
    expect(
      keyboardLockRequest(
        {
          data: { type: "REQUEST_KEYBOARD_LOCK" },
          origin,
          source: frame as never,
        },
        frame,
        STREAM,
      ),
    ).toBeUndefined();
  });

  it("ignores other frames, origins and messages", () => {
    const other = {} as Window;
    expect(
      keyboardLockRequest(
        { data, origin, source: other as never },
        frame,
        STREAM,
      ),
    ).toBeNull();
    expect(
      keyboardLockRequest(
        { data, origin: "https://evil.example", source: frame as never },
        frame,
        STREAM,
      ),
    ).toBeNull();
    expect(
      keyboardLockRequest(
        { data: { type: "other" }, origin, source: frame as never },
        frame,
        STREAM,
      ),
    ).toBeNull();
    expect(
      keyboardLockRequest(
        { data, origin, source: frame as never },
        null,
        STREAM,
      ),
    ).toBeNull();
  });
});

describe("canPlayH264", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true when WebCodecs can decode H.264", async () => {
    vi.stubGlobal("VideoDecoder", {
      isConfigSupported: async () => ({ supported: true }),
    });
    expect(await canPlayH264()).toBe(true);
  });

  it("falls back to media source", async () => {
    vi.stubGlobal("VideoDecoder", {
      isConfigSupported: async () => ({ supported: false }),
    });
    vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
    expect(await canPlayH264()).toBe(true);
  });

  it("is false when neither can", async () => {
    vi.stubGlobal("VideoDecoder", {
      isConfigSupported: async () => {
        throw new Error("no");
      },
    });
    vi.stubGlobal("MediaSource", { isTypeSupported: () => false });
    expect(await canPlayH264()).toBe(false);
  });
});
