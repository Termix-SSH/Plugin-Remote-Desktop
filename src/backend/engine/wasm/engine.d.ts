/* tslint:disable */
/* eslint-disable */
export function engine_version(): string;
/**
 * Decodes a JPEG into the surface at (x, y). Returns false when it can't.
 */
export function decode_jpeg_into(surface: Surface, x: number, y: number, jpeg: Uint8Array): boolean;
/**
 * Encodes raw RGBA pixels (a cursor, a glyph) that are not in a surface.
 */
export function encode_rgba_png(pixels: Uint8Array, width: number, height: number): Uint8Array;
export class Inflater {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  reset(): void;
  /**
   * Inflates `input` with a sync flush. `expected` sizes the first buffer.
   */
  inflate(input: Uint8Array, expected: number): Uint8Array;
}
export class RdpClient {
  free(): void;
  [Symbol.dispose](): void;
  encode_png(x: number, y: number, w: number, h: number): Uint8Array;
  sync_locks(scroll: boolean, num: boolean, caps: boolean): void;
  encode_jpeg(x: number, y: number, w: number, h: number, quality: number): Uint8Array;
  /**
   * Drains the events produced since the last call.
   */
  take_events(): Array<any>;
  /**
   * Text from the browser's clipboard, offered to the server.
   */
  clipboard_set(text: string): void;
  /**
   * A key by scancode. Bit 8 set means an extended (0xE0) key.
   */
  key(scancode: number, down: boolean): void;
  /**
   * `host` is an object of functions this client calls back synchronously:
   * `network(protocol, url, data)` for Kerberos and the drive's `fs_*`.
   */
  constructor(config_json: string, host: object);
  /**
   * Bytes read from the socket (plaintext, after any TLS).
   */
  feed(data: Uint8Array): void;
  /**
   * Timers: clipboard lock timeouts and deferred drive replies.
   */
  tick(): void;
  /**
   * A Guacamole mouse state: bit 0 left, 1 middle, 2 right, 3 wheel up, 4 wheel down.
   */
  mouse(x: number, y: number, mask: number): void;
  /**
   * Starts the connection sequence. The first "send" event is the X.224 request.
   */
  start(): void;
  width(): number;
  height(): number;
  /**
   * Asks the server to resize through Display Control. Returns false when
   * the channel isn't there, so the caller can reconnect instead.
   */
  resize(width: number, height: number, scale: number): boolean;
  /**
   * A key by UTF-16 code unit, for characters the layout has no key for.
   */
  unicode(unit: number, down: boolean): void;
  shutdown(): void;
  /**
   * The socket is now TLS. `public_key` is the server certificate's
   * SubjectPublicKeyInfo key bytes, which CredSSP binds to.
   */
  tls_done(public_key: Uint8Array): void;
}
export class Surface {
  free(): void;
  [Symbol.dispose](): void;
  encode_png(x: number, y: number, w: number, h: number, alpha: boolean): Uint8Array;
  encode_jpeg(x: number, y: number, w: number, h: number, quality: number): Uint8Array;
  len(): number;
  constructor(width: number, height: number);
  /**
   * Byte offset of pixel (0, 0) in the module's memory.
   */
  ptr(): number;
  fill(x: number, y: number, w: number, h: number, rgba: number): void;
  width(): number;
  height(): number;
  /**
   * Resizes, keeping the overlapping top-left part.
   */
  resize(width: number, height: number): void;
  is_empty(): boolean;
  /**
   * Moves a rectangle within the surface, like a VNC CopyRect.
   */
  copy_rect(sx: number, sy: number, w: number, h: number, dx: number, dy: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_inflater_free: (a: number, b: number) => void;
  readonly __wbg_rdpclient_free: (a: number, b: number) => void;
  readonly __wbg_surface_free: (a: number, b: number) => void;
  readonly decode_jpeg_into: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly encode_rgba_png: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly engine_version: (a: number) => void;
  readonly inflater_inflate: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly inflater_new: () => number;
  readonly inflater_reset: (a: number) => void;
  readonly rdpclient_clipboard_set: (a: number, b: number, c: number) => void;
  readonly rdpclient_encode_jpeg: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly rdpclient_encode_png: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly rdpclient_feed: (a: number, b: number, c: number) => void;
  readonly rdpclient_height: (a: number) => number;
  readonly rdpclient_key: (a: number, b: number, c: number) => void;
  readonly rdpclient_mouse: (a: number, b: number, c: number, d: number) => void;
  readonly rdpclient_new: (a: number, b: number, c: number, d: number) => void;
  readonly rdpclient_resize: (a: number, b: number, c: number, d: number) => number;
  readonly rdpclient_shutdown: (a: number) => void;
  readonly rdpclient_start: (a: number) => void;
  readonly rdpclient_sync_locks: (a: number, b: number, c: number, d: number) => void;
  readonly rdpclient_take_events: (a: number) => number;
  readonly rdpclient_tick: (a: number) => void;
  readonly rdpclient_tls_done: (a: number, b: number, c: number) => void;
  readonly rdpclient_unicode: (a: number, b: number, c: number) => void;
  readonly rdpclient_width: (a: number) => number;
  readonly surface_copy_rect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly surface_encode_jpeg: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly surface_encode_png: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly surface_fill: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly surface_height: (a: number) => number;
  readonly surface_is_empty: (a: number) => number;
  readonly surface_len: (a: number) => number;
  readonly surface_new: (a: number, b: number) => number;
  readonly surface_ptr: (a: number) => number;
  readonly surface_resize: (a: number, b: number, c: number) => void;
  readonly surface_width: (a: number) => number;
  readonly __wbindgen_export_0: (a: number) => void;
  readonly __wbindgen_export_1: (a: number, b: number) => number;
  readonly __wbindgen_export_2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
