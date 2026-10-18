/** Built-in cursor images, as straight RGBA. */

export interface CursorImage {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  rgba: Uint8Array;
}

function fromArt(art: string[], hotspotX = 0, hotspotY = 0): CursorImage {
  const height = art.length;
  const width = Math.max(...art.map((row) => row.length));
  const rgba = new Uint8Array(width * height * 4);
  art.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const i = (y * width + x) * 4;
      if (row[x] === "#") {
        rgba.set([0, 0, 0, 255], i);
      } else if (row[x] === ".") {
        rgba.set([255, 255, 255, 255], i);
      }
    }
  });
  return { width, height, hotspotX, hotspotY, rgba };
}

/** The arrow guacd shows when the server asks for its default pointer. */
export const ARROW = fromArt([
  "#",
  "##",
  "#.#",
  "#..#",
  "#...#",
  "#....#",
  "#.....#",
  "#......#",
  "#.......#",
  "#........#",
  "#.........#",
  "#......####",
  "#...#..#",
  "#..##..#",
  "#.#  #..#",
  "##   #..#",
  "#     #..#",
  "      #..#",
  "       ##",
]);

/** A small dot, for when the remote side draws its own cursor. */
export const DOT = fromArt([" ### ", "#...#", "#...#", "#...#", " ### "], 2, 2);

export const BLANK: CursorImage = {
  width: 1,
  height: 1,
  hotspotX: 0,
  hotspotY: 0,
  rgba: new Uint8Array(4),
};

/** RDP software pointers come premultiplied; PNG wants straight alpha. */
export function unpremultiply(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0 || a === 255) {
      out[i] = rgba[i];
      out[i + 1] = rgba[i + 1];
      out[i + 2] = rgba[i + 2];
    } else {
      out[i] = Math.min(255, Math.round((rgba[i] * 255) / a));
      out[i + 1] = Math.min(255, Math.round((rgba[i + 1] * 255) / a));
      out[i + 2] = Math.min(255, Math.round((rgba[i + 2] * 255) / a));
    }
    out[i + 3] = a;
  }
  return out;
}
