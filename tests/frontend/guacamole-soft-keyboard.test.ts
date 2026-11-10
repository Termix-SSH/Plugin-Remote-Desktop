import { describe, expect, it } from "vitest";
import {
  charToKeysym,
  isComposingKeyboardEvent,
  keysymsForBeforeInput,
  specialKeysymFromKeyboardEvent,
  textToKeysyms,
} from "../../src/frontend/guacamole-soft-keyboard.js";

describe("guacamole soft keyboard", () => {
  it("maps ASCII and Unicode code points to Guacamole keysyms", () => {
    expect(charToKeysym(0x61)).toBe(0x61);
    expect(charToKeysym(0xff)).toBe(0xff);
    expect(charToKeysym(0x10ffff)).toBe(0x01000000 | 0x10ffff);
    expect(charToKeysym("č".codePointAt(0)!)).toBe(
      0x01000000 | "č".codePointAt(0)!,
    );
  });

  it("turns inserted text into a keysym for each character", () => {
    expect(textToKeysyms("Ab")).toEqual([0x41, 0x62]);
  });

  it("maps special keys and leaves letters to the input event", () => {
    expect(specialKeysymFromKeyboardEvent({ key: "Enter" })).toBe(0xff0d);
    expect(specialKeysymFromKeyboardEvent({ key: "Backspace" })).toBe(0xff08);
    expect(specialKeysymFromKeyboardEvent({ key: "Tab" })).toBe(0xff09);
    expect(specialKeysymFromKeyboardEvent({ key: "ArrowLeft" })).toBe(0xff51);
    expect(specialKeysymFromKeyboardEvent({ key: "a" })).toBeNull();
    expect(specialKeysymFromKeyboardEvent({ key: " " })).toBeNull();
  });

  it("detects IME composition keyboard events", () => {
    expect(isComposingKeyboardEvent({ key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(isComposingKeyboardEvent({ key: "Process" })).toBe(true);
    expect(isComposingKeyboardEvent({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isComposingKeyboardEvent({ key: "Enter" })).toBe(false);
  });

  it("maps beforeinput types to keysyms and ignores composition", () => {
    expect(
      keysymsForBeforeInput({ inputType: "insertText", data: "Ab" }),
    ).toEqual([0x41, 0x62]);
    expect(keysymsForBeforeInput({ inputType: "", data: "A" })).toEqual([0x41]);
    expect(keysymsForBeforeInput({ data: "A" })).toEqual([0x41]);
    expect(
      keysymsForBeforeInput({ inputType: "insertFromPaste", data: "B" }),
    ).toEqual([0x42]);
    expect(keysymsForBeforeInput({ inputType: "insertLineBreak" })).toEqual([
      0xff0d,
    ]);
    expect(keysymsForBeforeInput({ inputType: "insertParagraph" })).toEqual([
      0xff0d,
    ]);
    expect(
      keysymsForBeforeInput({ inputType: "deleteContentBackward" }),
    ).toEqual([0xff08]);
    expect(
      keysymsForBeforeInput({ inputType: "deleteContentForward" }),
    ).toEqual([0xffff]);
    expect(
      keysymsForBeforeInput({ inputType: "insertText", data: "" }),
    ).toBeNull();
    expect(keysymsForBeforeInput({ inputType: "historyUndo" })).toBeNull();
    expect(
      keysymsForBeforeInput({
        inputType: "insertText",
        data: "A",
        isComposing: true,
      }),
    ).toBeNull();
    expect(
      keysymsForBeforeInput({
        inputType: "insertCompositionText",
        data: "あ",
        isComposing: true,
      }),
    ).toBeNull();
    expect(
      keysymsForBeforeInput({
        inputType: "insertCompositionText",
        data: "あ",
        isComposing: false,
      }),
    ).toEqual([0x01000000 | "あ".codePointAt(0)!]);
  });
});
