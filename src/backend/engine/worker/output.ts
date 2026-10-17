import { encode, type Arg } from "../protocol.js";
import type { Port } from "../messages.js";

/**
 * Batches outgoing instructions so one display frame is one message to the
 * main thread (and one WebSocket frame per user) instead of hundreds.
 */
export class Output {
  private broadcast: string[] = [];
  private scheduled = false;
  private nextStream = 1;
  private readonly liveStreams = new Set<number>();

  constructor(private readonly port: Port) {}

  send(opcode: string, ...args: Arg[]): void {
    this.broadcast.push(encode(opcode, ...args));
    this.schedule();
  }

  raw(data: string): void {
    this.broadcast.push(data);
    this.schedule();
  }

  /** To one user, ahead of anything still queued for everyone. */
  to(user: string, data: string): void {
    this.flush();
    this.port.post({ t: "out", data, to: user });
  }

  except(user: string, opcode: string, ...args: Arg[]): void {
    this.flush();
    this.port.post({ t: "out", data: encode(opcode, ...args), except: user });
  }

  flush(): void {
    if (this.broadcast.length === 0) return;
    const data = this.broadcast.join("");
    this.broadcast = [];
    this.port.post({ t: "out", data });
  }

  /** A server stream index that no live stream uses. */
  openStream(): number {
    for (let i = 0; i < 4096; i++) {
      const index = this.nextStream;
      this.nextStream = this.nextStream >= 4095 ? 1 : this.nextStream + 1;
      if (!this.liveStreams.has(index)) {
        this.liveStreams.add(index);
        return index;
      }
    }
    return 0;
  }

  closeStream(index: number): void {
    this.liveStreams.delete(index);
  }

  /** Sends bytes as a stream: blobs of base64, then end. */
  blobs(index: number, bytes: Uint8Array, chunk = 6048): void {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let offset = 0; offset < buffer.length; offset += chunk) {
      this.send(
        "blob",
        index,
        buffer.subarray(offset, offset + chunk).toString("base64"),
      );
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.flush();
    });
  }
}
