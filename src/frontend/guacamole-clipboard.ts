import Guacamole from "guacamole-common-js";

const CONTROL_LEFT_KEYSYM = 0xffe3;
const V_KEYSYM = 0x76;

interface ClipboardOutputStream {
  sendBlob(data: string): void;
  sendEnd(): void;
}

export interface GuacamoleClipboardClient {
  createClipboardStream(mimetype: string): ClipboardOutputStream;
  sendKeyEvent(pressed: number, keysym: number): void;
}

export function isPasteShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
): boolean {
  return (
    !event.altKey &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "v"
  );
}

export function pasteTextToRemote(
  client: GuacamoleClipboardClient,
  text: string,
): void {
  const stream = client.createClipboardStream("text/plain");
  const writer = new Guacamole.StringWriter(stream);
  writer.sendText(text);
  writer.sendEnd();

  client.sendKeyEvent(1, CONTROL_LEFT_KEYSYM);
  client.sendKeyEvent(1, V_KEYSYM);
  client.sendKeyEvent(0, V_KEYSYM);
  client.sendKeyEvent(0, CONTROL_LEFT_KEYSYM);
}

/**
 * Firefox only fires `paste` on editable elements, so a paste shortcut on the
 * display moves focus to this hidden textarea long enough for the browser to
 * paste into it, then hands the text over and puts focus back.
 */
export function createPasteCatcher(
  displayElement: HTMLElement,
  onText: (text: string) => void,
): { element: HTMLTextAreaElement; capture: () => void } {
  const element = document.createElement("textarea");
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;
  Object.assign(element.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
  });

  const restore = () => {
    element.value = "";
    if (document.activeElement === element) {
      displayElement.focus({ preventScroll: true });
    }
  };

  element.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    restore();
    if (text) onText(text);
  });

  return {
    element,
    capture() {
      element.value = "";
      element.focus({ preventScroll: true });
      // No paste event follows when the clipboard has nothing the page may read.
      setTimeout(restore, 200);
    },
  };
}
