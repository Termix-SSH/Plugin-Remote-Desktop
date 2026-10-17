/**
 * The Guacamole wire format: `LENGTH.VALUE,LENGTH.VALUE;` where each length
 * counts Unicode code points, not UTF-16 units.
 */

const SURROGATE = /[\uD800-\uDBFF]/;

/** Code point length, cheap for the ASCII base64 that makes up most traffic. */
export function codePointLength(value: string): number {
  if (!SURROGATE.test(value)) return value.length;
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) i++;
    length++;
  }
  return length;
}

export type Arg = string | number | boolean;

export function encode(opcode: string, ...args: Arg[]): string {
  let out = `${codePointLength(opcode)}.${opcode}`;
  for (const arg of args) {
    const value = String(arg);
    out += `,${codePointLength(value)}.${value}`;
  }
  return `${out};`;
}

export interface Instruction {
  opcode: string;
  args: string[];
}

/**
 * Streaming parser for what clients send. A WebSocket message may hold
 * several instructions or end halfway through one.
 */
export class Parser {
  private buffer = "";

  /** Max bytes buffered for one instruction before the peer is cut off. */
  constructor(private readonly limit = 16 * 1024 * 1024) {}

  receive(data: string): Instruction[] {
    this.buffer += data;
    const out: Instruction[] = [];
    let pos = 0;
    const buf = this.buffer;
    for (;;) {
      const start = pos;
      const elements: string[] = [];
      let done = false;
      let complete = false;
      while (!done) {
        const dot = buf.indexOf(".", pos);
        if (dot === -1) {
          done = true;
          break;
        }
        const length = Number(buf.slice(pos, dot));
        if (!Number.isInteger(length) || length < 0) {
          throw new Error("Malformed Guacamole instruction");
        }
        // Walk `length` code points.
        let end = dot + 1;
        for (let n = 0; n < length; n++) {
          if (end >= buf.length) {
            done = true;
            break;
          }
          const code = buf.charCodeAt(end);
          end += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
        }
        if (done || end >= buf.length) {
          done = true;
          break;
        }
        elements.push(buf.slice(dot + 1, end));
        const terminator = buf[end];
        pos = end + 1;
        if (terminator === ";") {
          complete = true;
          break;
        }
        if (terminator !== ",") {
          throw new Error("Malformed Guacamole instruction");
        }
      }
      if (!complete) {
        pos = start;
        break;
      }
      const [opcode = "", ...args] = elements;
      out.push({ opcode, args });
    }
    this.buffer = buf.slice(pos);
    if (this.buffer.length > this.limit) {
      throw new Error("Guacamole instruction too large");
    }
    return out;
  }
}

/** Guacamole status codes, as guacd sends them in `error`. */
export const Status = {
  SUCCESS: 0x0000,
  UNSUPPORTED: 0x0100,
  SERVER_ERROR: 0x0200,
  SERVER_BUSY: 0x0201,
  UPSTREAM_TIMEOUT: 0x0202,
  UPSTREAM_ERROR: 0x0203,
  RESOURCE_NOT_FOUND: 0x0204,
  RESOURCE_CONFLICT: 0x0205,
  RESOURCE_CLOSED: 0x0206,
  UPSTREAM_NOT_FOUND: 0x0207,
  UPSTREAM_UNAVAILABLE: 0x0208,
  SESSION_CONFLICT: 0x0209,
  SESSION_TIMEOUT: 0x020a,
  SESSION_CLOSED: 0x020b,
  CLIENT_BAD_REQUEST: 0x0300,
  CLIENT_UNAUTHORIZED: 0x0301,
  CLIENT_FORBIDDEN: 0x0303,
  CLIENT_TIMEOUT: 0x0308,
  CLIENT_OVERRUN: 0x030d,
  CLIENT_BAD_TYPE: 0x030f,
  CLIENT_TOO_MANY: 0x031d,
} as const;
