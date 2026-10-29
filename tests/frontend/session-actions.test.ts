import { describe, expect, it } from "vitest";
import {
  ENTER_KEYSYM,
  signOutOfWindows,
  typeText,
} from "../../src/frontend/session-actions";

describe("sign out of Windows", () => {
  it("opens Run, types logoff and presses Enter", async () => {
    const keys: Array<[number, boolean]> = [];
    const send = (key: number, pressed: boolean) => keys.push([key, pressed]);
    await signOutOfWindows(send, 0xffeb, async () => undefined);
    expect(keys.slice(0, 4)).toEqual([
      [0xffeb, true],
      [0x72, true],
      [0x72, false],
      [0xffeb, false],
    ]);
    const typed = keys
      .slice(4, -2)
      .filter(([, pressed]) => pressed)
      .map(([key]) => String.fromCharCode(key))
      .join("");
    expect(typed).toBe("logoff");
    expect(keys.slice(-2)).toEqual([
      [ENTER_KEYSYM, true],
      [ENTER_KEYSYM, false],
    ]);
  });

  it("releases each key it types", () => {
    const keys: Array<[number, boolean]> = [];
    typeText((key, pressed) => keys.push([key, pressed]), "ab");
    expect(keys).toEqual([
      [0x61, true],
      [0x61, false],
      [0x62, true],
      [0x62, false],
    ]);
  });
});
