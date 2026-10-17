export type Rgb = [number, number, number];

// guacd's terminal palette for the first 16 colors.
const BASE: Rgb[] = [
  [0x00, 0x00, 0x00],
  [0x99, 0x3e, 0x3e],
  [0x3e, 0x99, 0x3e],
  [0x99, 0x99, 0x3e],
  [0x3e, 0x3e, 0x99],
  [0x99, 0x3e, 0x99],
  [0x3e, 0x99, 0x99],
  [0x99, 0x99, 0x99],
  [0x3e, 0x3e, 0x3e],
  [0xff, 0x67, 0x67],
  [0x67, 0xff, 0x67],
  [0xff, 0xff, 0x67],
  [0x67, 0x67, 0xff],
  [0xff, 0x67, 0xff],
  [0x67, 0xff, 0xff],
  [0xff, 0xff, 0xff],
];

/** The 256 color xterm palette, starting from guacd's first 16. */
export function defaultPalette(): Rgb[] {
  const palette: Rgb[] = BASE.map((c) => [...c] as Rgb);
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) palette.push([steps[r], steps[g], steps[b]]);
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push([v, v, v]);
  }
  return palette;
}

export interface ColorScheme {
  foreground: Rgb;
  background: Rgb;
  palette: Rgb[];
}

const NAMED: Record<string, [number, number]> = {
  "black-white": [0, 15],
  "gray-black": [7, 0],
  "green-black": [2, 0],
  "white-black": [15, 0],
};

function parseColor(value: string, palette: Rgb[]): Rgb | null {
  const v = value.trim().toLowerCase();
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/.exec(v);
  if (rgb) {
    return rgb.slice(1, 4).map((part) => {
      const n = Number.parseInt(part, 16);
      return Math.round((n / (16 ** part.length - 1)) * 255);
    }) as Rgb;
  }
  const index = /^color(\d+)$/.exec(v);
  if (index && palette[Number(index[1])])
    return [...palette[Number(index[1])]] as Rgb;
  return null;
}

/**
 * guacd's color-scheme value: a name like "gray-black", or
 * "foreground: rgb:ff/ff/ff; background: color0; color9: rgb:..".
 */
export function parseColorScheme(value: string): ColorScheme {
  const palette = defaultPalette();
  const named = NAMED[value.trim().toLowerCase() || "gray-black"];
  if (named) {
    return {
      foreground: palette[named[0]],
      background: palette[named[1]],
      palette,
    };
  }
  let foreground = palette[7];
  let background = palette[0];
  for (const part of value.split(";")) {
    const [name, color] = part.split(":").map((s) => s?.trim() ?? "");
    if (!name || !color) continue;
    const rest = part.slice(part.indexOf(":") + 1);
    const parsed = parseColor(rest, palette);
    if (!parsed) continue;
    const key = name.toLowerCase();
    if (key === "foreground") foreground = parsed;
    else if (key === "background") background = parsed;
    else {
      const index = /^color(\d+)$/.exec(key);
      if (index && Number(index[1]) < 256) palette[Number(index[1])] = parsed;
    }
  }
  return { foreground, background, palette };
}
