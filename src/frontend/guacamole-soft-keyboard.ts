/** Helpers that turn a mobile software keyboard into Guacamole keysyms. */

export function charToKeysym(codePoint: number): number {
  return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
}

export function textToKeysyms(text: string): number[] {
  return Array.from(text)
    .map((ch) => ch.codePointAt(0))
    .filter((cp): cp is number => cp != null && cp !== 0)
    .map(charToKeysym);
}

/**
 * Keysyms for keys that must come from keydown, not from the input event,
 * so they are not sent twice. Letters and other printable characters return
 * null and should go through beforeinput/input instead.
 */
export function specialKeysymFromKeyboardEvent(event: {
  key: string;
  code?: string;
}): number | null {
  switch (event.key) {
    case "Backspace":
      return 0xff08;
    case "Tab":
      return 0xff09;
    case "Enter":
      return 0xff0d;
    case "Escape":
      return 0xff1b;
    case "Home":
      return 0xff50;
    case "ArrowLeft":
      return 0xff51;
    case "ArrowUp":
      return 0xff52;
    case "ArrowRight":
      return 0xff53;
    case "ArrowDown":
      return 0xff54;
    case "PageUp":
      return 0xff55;
    case "PageDown":
      return 0xff56;
    case "End":
      return 0xff57;
    case "Delete":
      return 0xffff;
    default:
      return null;
  }
}
