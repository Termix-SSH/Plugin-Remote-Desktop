import { describe, expect, it, vi } from "vitest";
import {
  createPasteCatcher,
  isPasteShortcut,
  pasteModifierFor,
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

  it.each([
    [0xffe3, 0xffe3],
    [0xffe3, 0xffe4],
    [0xffeb, 0xffe7],
    [0xffeb, 0xffe8],
    [0xffeb, 0xffeb],
    [0xffeb, 0xffec],
  ])("preserves held modifier %i while pasting with %i", (modifier, held) => {
    const keys: string[] = [];
    const client: GuacamoleClipboardClient = {
      createClipboardStream: () => ({ sendBlob: () => {}, sendEnd: () => {} }),
      sendKeyEvent: (pressed, keysym) => keys.push(`${pressed}:${keysym}`),
    };
    const pressed = { [held]: true };
    pasteTextToRemote(client, "new clipboard", modifier, pressed);
    expect(keys).toEqual(["1:118", "0:118"]);
    expect(pressed[held]).toBe(true);
  });

  it("does not release a physically held modifier when sending V fails", () => {
    const keys: string[] = [];
    const client: GuacamoleClipboardClient = {
      createClipboardStream: () => ({ sendBlob: () => {}, sendEnd: () => {} }),
      sendKeyEvent: (pressed, keysym) => {
        keys.push(`${pressed}:${keysym}`);
        throw new Error("Disconnected");
      },
    };
    expect(() =>
      pasteTextToRemote(client, "text", 0xffe3, { [0xffe4]: true }),
    ).toThrow("Disconnected");
    expect(keys).toEqual(["1:118"]);
  });

  it("does not press keys when the clipboard stream fails", () => {
    const client: GuacamoleClipboardClient = {
      createClipboardStream: () => ({
        sendBlob: () => {
          throw new Error("Disconnected");
        },
        sendEnd: () => {},
      }),
      sendKeyEvent: vi.fn(),
    };
    expect(() => pasteTextToRemote(client, "text")).toThrow("Disconnected");
    expect(client.sendKeyEvent).not.toHaveBeenCalled();
  });

  it("releases only its temporary modifier if sending V fails", () => {
    const keys: string[] = [];
    const client: GuacamoleClipboardClient = {
      createClipboardStream: () => ({ sendBlob: () => {}, sendEnd: () => {} }),
      sendKeyEvent: (pressed, keysym) => {
        keys.push(`${pressed}:${keysym}`);
        if (keysym === 0x76) throw new Error("Disconnected");
      },
    };
    expect(() => pasteTextToRemote(client, "new clipboard")).toThrow(
      "Disconnected",
    );
    expect(keys).toEqual(["1:65507", "1:118", "0:65507"]);
  });
});

describe("paste modifier", () => {
  it("pastes with Command on a Mac and Ctrl everywhere else", () => {
    expect(pasteModifierFor("ard")).toBe(0xffeb);
    for (const protocol of ["rdp", "vnc", "telnet", undefined]) {
      expect(pasteModifierFor(protocol)).toBe(0xffe3);
    }
  });

  it("sends the chosen modifier around V", () => {
    const keys: string[] = [];
    const client: GuacamoleClipboardClient = {
      createClipboardStream: () => ({ sendBlob: () => {}, sendEnd: () => {} }),
      sendKeyEvent: (pressed, keysym) => keys.push(`${pressed}:${keysym}`),
    };

    pasteTextToRemote(client, "from the browser", pasteModifierFor("ard"));

    expect(keys).toEqual(["1:65515", "1:118", "0:118", "0:65515"]);
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
