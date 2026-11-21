// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteClipboard } from "../../src/frontend/remote-clipboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("remote clipboard", () => {
  it("uses the clipboard API on a secure page", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const clipboard = createRemoteClipboard();
    clipboard.copy("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    clipboard.dispose();
  });

  it("waits for a click to copy on a plain HTTP page", () => {
    vi.stubGlobal("isSecureContext", false);
    const exec = vi.fn(() => true);
    document.execCommand = exec as never;
    const waiting = vi.fn();
    const clipboard = createRemoteClipboard(waiting);
    clipboard.copy("one");
    clipboard.copy("two");
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("pointerup"));
    expect(exec).toHaveBeenCalledWith("copy");
    document.dispatchEvent(new Event("pointerup"));
    expect(exec).toHaveBeenCalledTimes(1);
    clipboard.dispose();
  });

  it("copies right away while the last click still counts", () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const exec = vi.fn(() => true);
    document.execCommand = exec as never;
    const waiting = vi.fn();
    const clipboard = createRemoteClipboard(waiting);
    clipboard.copy("from a right-click");
    expect(exec).toHaveBeenCalledWith("copy");
    expect(waiting).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("pointerup"));
    expect(exec).toHaveBeenCalledTimes(1);
    clipboard.dispose();
  });

  it("still waits when the quick copy is refused", () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const exec = vi.fn(() => false);
    document.execCommand = exec as never;
    const waiting = vi.fn();
    const clipboard = createRemoteClipboard(waiting);
    clipboard.copy("text");
    expect(waiting).toHaveBeenCalledTimes(1);
    clipboard.dispose();
  });
});
