/**
 * A small protobuf reader and writer, enough for the RustDesk messages this
 * client sends and reads. Field numbers live in messages.ts.
 */

const VARINT = 0;
const FIXED64 = 1;
const BYTES = 2;
const FIXED32 = 5;

export class PbWriter {
  private readonly parts: number[] = [];
  private readonly chunks: Uint8Array[] = [];

  private flushBytes(): void {
    if (this.parts.length === 0) return;
    this.chunks.push(Uint8Array.from(this.parts));
    this.parts.length = 0;
  }

  private varint(value: number | bigint): void {
    let v = BigInt.asUintN(64, BigInt(value));
    while (v > 0x7fn) {
      this.parts.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.parts.push(Number(v));
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  /** int32, int64, uint32, uint64, enum. Zero is left out, as proto3 does. */
  uint(field: number, value: number | bigint | undefined): this {
    if (!value) return this;
    this.tag(field, VARINT);
    this.varint(value);
    return this;
  }

  sint(field: number, value: number | undefined): this {
    if (!value) return this;
    this.tag(field, VARINT);
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
    return this;
  }

  bool(field: number, value: boolean | undefined): this {
    if (!value) return this;
    this.tag(field, VARINT);
    this.varint(1);
    return this;
  }

  bytes(field: number, value: Uint8Array | undefined): this {
    if (!value || value.length === 0) return this;
    this.tag(field, BYTES);
    this.varint(value.length);
    this.flushBytes();
    this.chunks.push(value);
    return this;
  }

  string(field: number, value: string | undefined): this {
    if (!value) return this;
    return this.bytes(field, Buffer.from(value, "utf8"));
  }

  /** A nested message, written even when empty (a set oneof). */
  message(field: number, value: PbWriter | undefined): this {
    if (!value) return this;
    const body = value.finish();
    this.tag(field, BYTES);
    this.varint(body.length);
    this.flushBytes();
    if (body.length) this.chunks.push(body);
    return this;
  }

  /** A packed repeated enum or int. */
  packed(field: number, values: number[]): this {
    if (values.length === 0) return this;
    const inner = new PbWriter();
    for (const v of values) inner.varint(v);
    return this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    this.flushBytes();
    if (this.chunks.length === 1) return this.chunks[0];
    return Buffer.concat(this.chunks);
  }
}

export type PbValue = bigint | Uint8Array;

/** Every field of one message, by number, in wire order. */
export class PbMessage {
  constructor(readonly fields: Map<number, PbValue[]>) {}

  static decode(data: Uint8Array): PbMessage {
    const fields = new Map<number, PbValue[]>();
    let pos = 0;
    const readVarint = (): bigint => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (pos >= data.length) throw new Error("Truncated protobuf");
        const b = data[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return result;
        shift += 7n;
        if (shift > 70n) throw new Error("Bad protobuf varint");
      }
    };
    while (pos < data.length) {
      const key = Number(readVarint());
      const field = key >>> 3;
      const wire = key & 7;
      let value: PbValue;
      if (wire === VARINT) {
        value = readVarint();
      } else if (wire === BYTES) {
        const length = Number(readVarint());
        if (pos + length > data.length) throw new Error("Truncated protobuf");
        value = data.subarray(pos, pos + length);
        pos += length;
      } else if (wire === FIXED64) {
        value = data.subarray(pos, pos + 8);
        pos += 8;
      } else if (wire === FIXED32) {
        value = data.subarray(pos, pos + 4);
        pos += 4;
      } else {
        throw new Error(`Unsupported protobuf wire type ${wire}`);
      }
      const list = fields.get(field);
      if (list) list.push(value);
      else fields.set(field, [value]);
    }
    return new PbMessage(fields);
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  private last(field: number): PbValue | undefined {
    const list = this.fields.get(field);
    return list ? list[list.length - 1] : undefined;
  }

  /** Signed 32 bit (int32 and enums). */
  int(field: number): number {
    const v = this.last(field);
    return typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : 0;
  }

  uint(field: number): number {
    const v = this.last(field);
    return typeof v === "bigint" ? Number(BigInt.asUintN(32, v)) : 0;
  }

  big(field: number): bigint {
    const v = this.last(field);
    return typeof v === "bigint" ? v : 0n;
  }

  sint(field: number): number {
    const v = this.last(field);
    if (typeof v !== "bigint") return 0;
    const n = Number(BigInt.asUintN(32, v));
    return (n >>> 1) ^ -(n & 1);
  }

  bool(field: number): boolean {
    return this.big(field) !== 0n;
  }

  bytes(field: number): Uint8Array {
    const v = this.last(field);
    return v instanceof Uint8Array ? v : new Uint8Array(0);
  }

  string(field: number): string {
    return Buffer.from(this.bytes(field)).toString("utf8");
  }

  message(field: number): PbMessage | null {
    const v = this.last(field);
    return v instanceof Uint8Array ? PbMessage.decode(v) : null;
  }

  messages(field: number): PbMessage[] {
    return (this.fields.get(field) ?? [])
      .filter((v): v is Uint8Array => v instanceof Uint8Array)
      .map((v) => PbMessage.decode(v));
  }

  /** The first field of a oneof that is present, from the given numbers. */
  which(numbers: number[]): number | null {
    for (const [field] of this.fields) {
      if (numbers.includes(field)) return field;
    }
    return null;
  }
}
