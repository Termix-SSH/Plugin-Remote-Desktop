/**
 * Awaitable reads over a socket's data. Reads that the buffer can already
 * satisfy resolve without waiting for new data.
 */
export class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private waiter: { need: number; resolve: () => void } | null = null;
  private closedWith: Error | null = null;

  push(data: Buffer): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.length += data.length;
    if (this.waiter && this.length >= this.waiter.need) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  close(error: Error): void {
    this.closedWith = error;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve();
  }

  get available(): number {
    return this.length;
  }

  /** Whatever is buffered, without waiting. */
  takeAll(): Buffer {
    const out =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.length = 0;
    return out;
  }

  async bytes(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    while (this.length < n) {
      if (this.closedWith) throw this.closedWith;
      await new Promise<void>((resolve) => {
        this.waiter = { need: n, resolve };
      });
    }
    if (this.chunks[0].length >= n) {
      const head = this.chunks[0];
      const out = head.subarray(0, n);
      if (head.length === n) this.chunks.shift();
      else this.chunks[0] = head.subarray(n);
      this.length -= n;
      return out;
    }
    const all = Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  async u8(): Promise<number> {
    return (await this.bytes(1))[0];
  }

  async u16(): Promise<number> {
    return (await this.bytes(2)).readUInt16BE(0);
  }

  async u32(): Promise<number> {
    return (await this.bytes(4)).readUInt32BE(0);
  }

  async s32(): Promise<number> {
    return (await this.bytes(4)).readInt32BE(0);
  }
}
