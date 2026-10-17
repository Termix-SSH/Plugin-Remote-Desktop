import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Status } from "../../protocol.js";
import type { RemoteClient, RemoteHost } from "../remote.js";
import { TerminalView } from "./terminal.js";
import { TelnetCodec } from "./protocol.js";
import { isModifier, keyBytes } from "./keys.js";

// guacd's defaults.
const USERNAME_REGEX = "[Ll]ogin:";
const PASSWORD_REGEX = "[Pp]assword:";

function regex(value: string, fallback: string | null): RegExp | null {
  const source = value || fallback;
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/** Telnet with guacd's terminal: auto login, selection, scrollback, paste. */
export class TelnetClient implements RemoteClient {
  private socket: net.Socket | null = null;
  private view: TerminalView | null = null;
  private codec: TelnetCodec | null = null;
  private readonly decoder = new StringDecoder("utf8");
  private recent = "";
  private usernameRegex: RegExp | null = null;
  private passwordRegex: RegExp | null = null;
  private successRegex: RegExp | null = null;
  private failureRegex: RegExp | null = null;
  private pressed = new Set<number>();
  private buttons = 0;
  private clipboardText = "";
  private connected = false;
  private stopped = false;
  private readOnly = false;

  constructor(private readonly host: RemoteHost) {}

  start(): void {
    const s = this.host.settings;
    const width = s.int("width", 1024);
    const height = s.int("height", 768);
    this.readOnly = s.bool("read-only");
    const username = s.get("username");
    const password = s.get("password");
    this.usernameRegex = username
      ? regex(s.get("username-regex"), USERNAME_REGEX)
      : null;
    this.passwordRegex = password
      ? regex(s.get("password-regex"), PASSWORD_REGEX)
      : null;
    this.successRegex = regex(s.get("login-success-regex"), null);
    this.failureRegex = regex(s.get("login-failure-regex"), null);

    const view = new TerminalView(this.host, width, height);
    this.view = view;
    this.host.display.setSource(view);
    this.host.display.cursorDefault();
    view.term.onData((data) => this.send(data));
    view.term.onBinary((data) => this.send(Buffer.from(data, "binary")));

    const socket = net.connect({
      host: s.get("hostname"),
      port: s.int("port", 23),
    });
    socket.setNoDelay(true);
    this.socket = socket;
    this.codec = new TelnetCodec(
      {
        terminalType: s.get("terminal-type", "linux"),
        username,
        size: () => ({ cols: view.term.cols, rows: view.term.rows }),
      },
      (bytes) => socket.write(bytes),
    );
    socket.setTimeout(15000, () => {
      if (!this.connected) socket.destroy(new Error("timeout"));
    });
    socket.once("connect", () => {
      this.connected = true;
      socket.setTimeout(0);
      this.host.ready();
    });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (this.stopped) return;
      if (!this.connected) {
        this.host.fail(
          error.message === "timeout"
            ? "The Telnet server did not answer"
            : "Could not reach the Telnet server",
          error.message === "timeout"
            ? Status.UPSTREAM_TIMEOUT
            : Status.UPSTREAM_NOT_FOUND,
        );
      }
    });
    socket.on("close", () => {
      if (!this.stopped && this.connected) this.host.closed();
    });
  }

  private receive(chunk: Buffer): void {
    const data = this.codec!.receive(chunk);
    if (data.length === 0) return;
    this.view!.write(data);
    this.watchLogin(this.decoder.write(data));
  }

  private watchLogin(text: string): void {
    if (
      !this.usernameRegex &&
      !this.passwordRegex &&
      !this.successRegex &&
      !this.failureRegex
    ) {
      return;
    }
    this.recent = (this.recent + text).slice(-4096);
    const s = this.host.settings;
    if (this.usernameRegex?.test(this.recent)) {
      this.usernameRegex = null;
      this.recent = "";
      this.send(`${s.get("username")}\r`);
    } else if (this.passwordRegex?.test(this.recent)) {
      this.passwordRegex = null;
      this.recent = "";
      this.send(`${s.get("password")}\r`);
    }
    if (this.failureRegex?.test(this.recent)) {
      this.host.fail("Telnet login failed", Status.CLIENT_UNAUTHORIZED);
      return;
    }
    if (this.successRegex?.test(this.recent)) {
      this.successRegex = null;
      this.failureRegex = null;
      this.usernameRegex = null;
      this.passwordRegex = null;
    }
  }

  private send(data: string | Buffer): void {
    if (!this.socket || !this.codec) return;
    let bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    // NVT: a bare CR is followed by NUL unless in binary mode.
    if (!this.codec.binary && bytes.includes(13)) {
      const out: number[] = [];
      for (let i = 0; i < bytes.length; i++) {
        out.push(bytes[i]);
        if (bytes[i] === 13 && bytes[i + 1] !== 10) out.push(0);
      }
      bytes = Buffer.from(out);
    }
    this.socket.write(this.codec.encode(bytes));
  }

  private paste(): void {
    if (!this.clipboardText || !this.view) return;
    const text = this.clipboardText.replace(/\r?\n/g, "\r");
    this.view.scrollToBottom();
    this.send(
      this.view.term.modes.bracketedPasteMode
        ? `\x1b[200~${text}\x1b[201~`
        : text,
    );
  }

  key(keysym: number, pressed: boolean): void {
    if (pressed) this.pressed.add(keysym);
    else this.pressed.delete(keysym);
    if (!pressed || this.readOnly || isModifier(keysym) || !this.view) return;
    const ctrl = this.pressed.has(0xffe3) || this.pressed.has(0xffe4);
    const shift = this.pressed.has(0xffe1) || this.pressed.has(0xffe2);
    const alt =
      this.pressed.has(0xffe9) ||
      this.pressed.has(0xffea) ||
      this.pressed.has(0xffe7);
    // Shift+Insert and Ctrl+Shift+V paste, like guacd.
    if (
      (shift && keysym === 0xff63) ||
      (ctrl && shift && (keysym === 0x56 || keysym === 0x76))
    ) {
      this.paste();
      return;
    }
    // Shift+PageUp/PageDown scroll the scrollback.
    if (shift && (keysym === 0xff55 || keysym === 0xff56)) {
      this.view.scroll(
        keysym === 0xff55 ? -this.view.term.rows + 1 : this.view.term.rows - 1,
      );
      return;
    }
    const bytes = keyBytes(keysym, {
      ctrl,
      alt,
      shift,
      applicationCursor: this.view.term.modes.applicationCursorKeysMode,
      backspace: this.host.settings.int("backspace", 127),
    });
    if (bytes === null) return;
    this.view.scrollToBottom();
    this.send(bytes);
  }

  mouse(x: number, y: number, mask: number): void {
    const view = this.view;
    if (!view) return;
    const pressed = mask & ~this.buttons;
    const released = this.buttons & ~mask;
    this.buttons = mask;
    if (pressed & 8) view.scroll(-3);
    if (pressed & 16) view.scroll(3);
    if (pressed & 1) view.selectStart(x, y);
    else if (mask & 1) view.selectMove(x, y);
    if (released & 1) {
      const text = view.selectEnd();
      if (text) {
        this.clipboardText = text;
        this.host.clipboard(text);
      }
    }
    if (pressed & 2 && !this.readOnly) this.paste();
  }

  resize(width: number, height: number): void {
    if (!this.view || width <= 0 || height <= 0) return;
    this.view.resizePixels(width, height);
    this.codec?.sendSize();
  }

  clipboard(text: string): void {
    this.clipboardText = text;
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    this.view?.dispose();
    this.view = null;
  }
}
