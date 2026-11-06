import { describe, expect, it } from "vitest";
import {
  keyboardLockRequest,
  moonlightEmbed,
} from "../../src/frontend/moonlight-embed";

const STREAM = "https://moonlight.example.com/stream.html?hostId=1&appId=2";

describe("moonlightEmbed", () => {
  it("frames a stream on a sibling subdomain", () => {
    expect(moonlightEmbed(STREAM, "https://termix.example.com/", false)).toBe(
      "iframe",
    );
  });

  it("opens a window on the desktop", () => {
    expect(moonlightEmbed(STREAM, "https://termix.example.com/", true)).toBe(
      "window",
    );
  });

  it("opens a window across sites", () => {
    expect(moonlightEmbed(STREAM, "https://termix.other.net/", false)).toBe(
      "window",
    );
  });

  it("opens a window for mixed schemes", () => {
    expect(moonlightEmbed(STREAM, "http://termix.example.com/", false)).toBe(
      "window",
    );
  });

  it("never frames the same hostname, since Termix cookies would go along", () => {
    expect(
      moonlightEmbed(
        "https://example.com:8443/stream.html",
        "https://example.com/",
        false,
      ),
    ).toBe("window");
  });

  it("opens a window for IP addresses and bare names", () => {
    expect(
      moonlightEmbed(
        "http://10.0.0.2:8080/stream.html",
        "http://10.0.0.1/",
        false,
      ),
    ).toBe("window");
    expect(
      moonlightEmbed(
        "http://moonlight:8080/stream.html",
        "http://termix/",
        false,
      ),
    ).toBe("window");
  });
});

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
