/** Telnet (RFC 854) framing and option negotiation. */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;

export const OPT = {
  BINARY: 0,
  ECHO: 1,
  SGA: 3,
  TTYPE: 24,
  NAWS: 31,
  NEW_ENVIRON: 39,
} as const;

export interface TelnetOptions {
  terminalType: string;
  username: string;
  size: () => { cols: number; rows: number };
}

const enum State {
  Data,
  Iac,
  Command,
  Sub,
  SubIac,
}

/**
 * Splits a Telnet byte stream into terminal data and negotiation, and
 * answers the negotiation. `send` writes raw bytes to the socket.
 */
export class TelnetCodec {
  private state = State.Data;
  private command = 0;
  private sub: number[] = [];
  private readonly accepted = new Set<number>();
  binary = false;

  constructor(
    private readonly options: TelnetOptions,
    private readonly send: (bytes: Buffer) => void,
  ) {}

  /** Returns the terminal data in `chunk`. */
  receive(chunk: Buffer): Buffer {
    const out: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case State.Data:
          if (byte === IAC) this.state = State.Iac;
          else out.push(byte);
          break;
        case State.Iac:
          if (byte === IAC) {
            out.push(IAC);
            this.state = State.Data;
          } else if (byte === SB) {
            this.sub = [];
            this.state = State.Sub;
          } else if (byte >= WILL && byte <= DONT) {
            this.command = byte;
            this.state = State.Command;
          } else {
            this.state = State.Data;
          }
          break;
        case State.Command:
          this.negotiate(this.command, byte);
          this.state = State.Data;
          break;
        case State.Sub:
          if (byte === IAC) this.state = State.SubIac;
          else this.sub.push(byte);
          break;
        case State.SubIac:
          if (byte === SE) {
            this.subnegotiation(this.sub);
            this.state = State.Data;
          } else {
            if (byte === IAC) this.sub.push(IAC);
            this.state = State.Sub;
          }
          break;
      }
    }
    return Buffer.from(out);
  }

  /** Terminal input, with IAC doubled. */
  encode(data: Buffer): Buffer {
    if (!data.includes(IAC)) return data;
    const out: number[] = [];
    for (const byte of data) {
      out.push(byte);
      if (byte === IAC) out.push(IAC);
    }
    return Buffer.from(out);
  }

  /** Tells the server the window size, once it agreed to NAWS. */
  sendSize(): void {
    if (!this.accepted.has(OPT.NAWS)) return;
    const { cols, rows } = this.options.size();
    const body = Buffer.alloc(4);
    body.writeUInt16BE(Math.min(cols, 0xffff), 0);
    body.writeUInt16BE(Math.min(rows, 0xffff), 2);
    this.send(
      Buffer.concat([
        Buffer.from([IAC, SB, OPT.NAWS]),
        this.encode(body),
        Buffer.from([IAC, SE]),
      ]),
    );
  }

  private reply(command: number, option: number) {
    this.send(Buffer.from([IAC, command, option]));
  }

  private negotiate(command: number, option: number): void {
    const weWill = new Set<number>([
      OPT.BINARY,
      OPT.SGA,
      OPT.TTYPE,
      OPT.NAWS,
      ...(this.options.username ? [OPT.NEW_ENVIRON] : []),
    ]);
    const theyMay = new Set<number>([OPT.BINARY, OPT.ECHO, OPT.SGA]);
    if (command === DO) {
      if (weWill.has(option)) {
        if (!this.accepted.has(option)) {
          this.accepted.add(option);
          this.reply(WILL, option);
        }
        if (option === OPT.NAWS) this.sendSize();
        if (option === OPT.BINARY) this.binary = true;
      } else {
        this.reply(WONT, option);
      }
    } else if (command === DONT) {
      this.accepted.delete(option);
      this.reply(WONT, option);
    } else if (command === WILL) {
      this.reply(theyMay.has(option) ? DO : DONT, option);
    } else if (command === WONT) {
      this.reply(DONT, option);
    }
  }

  private subnegotiation(data: number[]): void {
    const [option, verb] = data;
    // SEND is 1, IS is 0.
    if (option === OPT.TTYPE && verb === 1) {
      this.send(
        Buffer.concat([
          Buffer.from([IAC, SB, OPT.TTYPE, 0]),
          Buffer.from(this.options.terminalType, "latin1"),
          Buffer.from([IAC, SE]),
        ]),
      );
    } else if (
      option === OPT.NEW_ENVIRON &&
      verb === 1 &&
      this.options.username
    ) {
      // IS, VAR "USER", VALUE <username>.
      this.send(
        Buffer.concat([
          Buffer.from([IAC, SB, OPT.NEW_ENVIRON, 0, 0]),
          Buffer.from("USER", "latin1"),
          Buffer.from([1]),
          this.encode(Buffer.from(this.options.username, "utf8")),
          Buffer.from([IAC, SE]),
        ]),
      );
    }
  }
}
