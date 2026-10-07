import { describe, expect, it, vi } from "vitest";
import {
  createPasteCatcher,
  isPasteShortcut,
  pasteTextToRemote,
  type GuacamoleClipboardClient,
} from "../../src/frontend/guacamole-clipboard.js";

describe("Guacamole clipboard paste", () => {
  it("recognizes Ctrl+V and Command+V without intercepting Alt+V", () => {
    expect(
      isPasteShortcut({
        key: "v",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isPasteShortcut({
        key: "V",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isPasteShortcut({
        key: "v",
        ctrlKey: true,
        metaKey: false,
        altKey: true,
      }),
    ).toBe(false);
  });

  it("updates the remote clipboard before sending Ctrl+V", () => {
    const events: string[] = [];
    const client: GuacamoleClipboardClient = {
      createClipboardStream: vi.fn((mimetype: string) => {
        events.push(`stream:${mimetype}`);
        return {
          sendBlob: () => events.push("blob"),
          sendEnd: () => events.push("end"),
        };
      }),
      sendKeyEvent: vi.fn((pressed: number, keysym: number) => {
        events.push(`key:${pressed}:${keysym}`);
      }),
    };

    pasteTextToRemote(client, "Firefox clipboard");

    expect(events).toEqual([
      "stream:text/plain",
      "blob",
      "end",
      "key:1:65507",
      "key:1:118",
      "key:0:118",
      "key:0:65507",
    ]);
  });
});

describe("paste catcher", () => {
  function pasteEvent(text: string) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { getData: () => text } });
    return event;
  }

  it("takes the paste on a hidden textarea and gives focus back", () => {
    const display = document.createElement("div");
    display.tabIndex = 0;
    document.body.appendChild(display);
    const onText = vi.fn();
    const catcher = createPasteCatcher(display, onText);
    document.body.appendChild(catcher.element);

    display.focus();
    catcher.capture();
    expect(document.activeElement).toBe(catcher.element);

    const event = pasteEvent("hello world");
    catcher.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onText).toHaveBeenCalledWith("hello world");
    expect(document.activeElement).toBe(display);
    document.body.innerHTML = "";
  });

  it("returns focus when no paste event arrives", () => {
    vi.useFakeTimers();
    const display = document.createElement("div");
    display.tabIndex = 0;
    document.body.appendChild(display);
    const onText = vi.fn();
    const catcher = createPasteCatcher(display, onText);
    document.body.appendChild(catcher.element);

    catcher.capture();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(display);
    expect(onText).not.toHaveBeenCalled();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });
});
