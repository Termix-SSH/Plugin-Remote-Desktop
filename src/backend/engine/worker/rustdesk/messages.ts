import { PbMessage, PbWriter } from "./pb.js";

/** RendezvousMessage oneof fields (hbbs and hbbr). */
export const RV = {
  punchHoleRequest: 8,
  punchHoleResponse: 11,
  localAddr: 13,
  requestRelay: 18,
  relayResponse: 19,
  keyExchange: 25,
} as const;

/** Message oneof fields (the peer). */
export const MSG = {
  signedId: 3,
  publicKey: 4,
  testDelay: 5,
  videoFrame: 6,
  loginRequest: 7,
  loginResponse: 8,
  hash: 9,
  mouseEvent: 10,
  audioFrame: 11,
  cursorData: 12,
  cursorPosition: 13,
  cursorId: 14,
  keyEvent: 15,
  clipboard: 16,
  misc: 19,
  messageBox: 21,
  peerInfo: 25,
  auth2fa: 27,
  multiClipboards: 28,
} as const;

/** Misc oneof fields. */
export const MISC = {
  switchDisplay: 5,
  permissionInfo: 6,
  option: 7,
  audioFormat: 8,
  closeReason: 9,
  refreshVideo: 10,
  restartRemoteDevice: 14,
  changeResolution: 24,
  refreshVideoDisplay: 31,
} as const;

/** VideoFrame codec fields. */
export const VIDEO = { vp9: 6, h264: 10, h265: 11, vp8: 12, av1: 13 } as const;
export type VideoCodec = keyof typeof VIDEO;

export const NAT_SYMMETRIC = 2;
export const CONN_DEFAULT = 0;
export const KEYBOARD_LEGACY = 0;

export const PUNCH_FAILURE: Record<number, string> = {
  0: "This RustDesk ID does not exist",
  2: "The remote device is offline",
  3: "The RustDesk server key does not match",
  4: "The RustDesk server key is used by too many devices",
};

export function rendezvous(field: number, body: PbWriter): Uint8Array {
  return new PbWriter().message(field, body).finish();
}

export function message(field: number, body: PbWriter): Uint8Array {
  return new PbWriter().message(field, body).finish();
}

export function punchHoleRequest(
  id: string,
  key: string,
  version: string,
): Uint8Array {
  return rendezvous(
    RV.punchHoleRequest,
    new PbWriter()
      .string(1, id)
      .uint(2, NAT_SYMMETRIC)
      .string(3, key)
      .uint(4, CONN_DEFAULT)
      .string(6, version)
      .bool(8, true),
  );
}

export function requestRelay(fields: {
  id: string;
  uuid: string;
  relayServer?: string;
  secure?: boolean;
  key?: string;
}): Uint8Array {
  return rendezvous(
    RV.requestRelay,
    new PbWriter()
      .string(1, fields.id)
      .string(2, fields.uuid)
      .string(4, fields.relayServer)
      .bool(5, fields.secure)
      .string(6, fields.key)
      .uint(7, CONN_DEFAULT),
  );
}

export interface PunchHoleResponse {
  socketAddr: Uint8Array;
  pk: Uint8Array;
  failure: number;
  relayServer: string;
  otherFailure: string;
}

export function readPunchHoleResponse(m: PbMessage): PunchHoleResponse {
  return {
    socketAddr: m.bytes(1),
    pk: m.bytes(2),
    failure: m.int(3),
    relayServer: m.string(4),
    otherFailure: m.string(7),
  };
}

export interface RelayResponse {
  uuid: string;
  relayServer: string;
  pk: Uint8Array;
  refuseReason: string;
}

export function readRelayResponse(m: PbMessage): RelayResponse {
  return {
    uuid: m.string(2),
    relayServer: m.string(3),
    pk: m.bytes(5),
    refuseReason: m.string(6),
  };
}

export interface IdPk {
  id: string;
  pk: Uint8Array;
  kxVersion: number;
}

export function readIdPk(data: Uint8Array): IdPk {
  const m = PbMessage.decode(data);
  return { id: m.string(1), pk: m.bytes(2), kxVersion: m.uint(4) };
}

export function publicKey(
  asymmetric: Uint8Array,
  symmetric: Uint8Array,
  kxVersion: number,
): Uint8Array {
  return message(
    MSG.publicKey,
    new PbWriter().bytes(1, asymmetric).bytes(2, symmetric).uint(3, kxVersion),
  );
}

export interface Decodings {
  vp9: boolean;
  vp8: boolean;
  av1: boolean;
}

export function loginRequest(fields: {
  peerId: string;
  password: Uint8Array;
  myId: string;
  myName: string;
  version: string;
  decodings: Decodings;
  prefer: VideoCodec | null;
  disableAudio: boolean;
  disableClipboard: boolean;
  viewOnly: boolean;
}): Uint8Array {
  const prefer = { vp9: 1, h264: 2, h265: 3, vp8: 4, av1: 5 };
  const decoding = new PbWriter()
    .uint(1, fields.decodings.vp9 ? 1 : 0)
    .uint(4, fields.prefer ? prefer[fields.prefer] : 0)
    .uint(5, fields.decodings.vp8 ? 1 : 0)
    .uint(6, fields.decodings.av1 ? 1 : 0);
  // BoolOption Yes is 2.
  const option = new PbWriter()
    .uint(7, fields.disableAudio ? 2 : 0)
    .uint(8, fields.disableClipboard ? 2 : 0)
    .message(10, decoding)
    .uint(12, fields.viewOnly ? 2 : 0);
  return message(
    MSG.loginRequest,
    new PbWriter()
      .string(1, fields.peerId)
      .bytes(2, fields.password)
      .string(4, fields.myId)
      .string(5, fields.myName)
      .message(6, option)
      .string(11, fields.version)
      .string(13, "Linux"),
  );
}

export function auth2fa(code: string): Uint8Array {
  return message(MSG.auth2fa, new PbWriter().string(1, code));
}

export interface DisplayInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  cursorEmbedded: boolean;
}

function readDisplay(m: PbMessage): DisplayInfo {
  return {
    x: m.sint(1),
    y: m.sint(2),
    width: m.int(3),
    height: m.int(4),
    name: m.string(5),
    cursorEmbedded: m.bool(7),
  };
}

export interface PeerInfo {
  username: string;
  hostname: string;
  platform: string;
  displays: DisplayInfo[];
  currentDisplay: number;
  version: string;
}

export function readPeerInfo(m: PbMessage): PeerInfo {
  return {
    username: m.string(1),
    hostname: m.string(2),
    platform: m.string(3),
    displays: m.messages(4).map(readDisplay),
    currentDisplay: m.int(5),
    version: m.string(7),
  };
}

export interface SwitchDisplay {
  display: number;
  width: number;
  height: number;
  cursorEmbedded: boolean;
}

export function readSwitchDisplay(m: PbMessage): SwitchDisplay {
  return {
    display: m.int(1),
    width: m.int(4),
    height: m.int(5),
    cursorEmbedded: m.bool(6),
  };
}

export interface EncodedFrame {
  data: Uint8Array;
  key: boolean;
  pts: number;
}

export function readVideoFrame(m: PbMessage): {
  codec: VideoCodec | "other";
  frames: EncodedFrame[];
  display: number;
} {
  const display = m.int(14);
  for (const [codec, field] of Object.entries(VIDEO) as [
    VideoCodec,
    number,
  ][]) {
    const frames = m.message(field);
    if (!frames) continue;
    return {
      codec,
      display,
      frames: frames.messages(1).map((f) => ({
        data: f.bytes(1),
        key: f.bool(2),
        pts: Number(BigInt.asIntN(64, f.big(3))),
      })),
    };
  }
  return { codec: "other", frames: [], display };
}

export interface CursorData {
  id: bigint;
  hotx: number;
  hoty: number;
  width: number;
  height: number;
  colors: Uint8Array;
}

export function readCursorData(m: PbMessage): CursorData {
  return {
    id: m.big(1),
    hotx: m.sint(2),
    hoty: m.sint(3),
    width: m.int(4),
    height: m.int(5),
    colors: m.bytes(6),
  };
}

export function mouseEvent(
  mask: number,
  x: number,
  y: number,
  modifiers: number[],
): Uint8Array {
  return message(
    MSG.mouseEvent,
    new PbWriter().uint(1, mask).sint(2, x).sint(3, y).packed(4, modifiers),
  );
}

export type KeyTarget =
  { controlKey: number } | { chr: number } | { unicode: number };

export function keyEvent(
  target: KeyTarget,
  down: boolean,
  modifiers: number[],
  press = false,
): Uint8Array {
  const w = new PbWriter().bool(1, down).bool(2, press);
  if ("controlKey" in target) w.uint(3, target.controlKey);
  else if ("chr" in target) w.uint(4, target.chr);
  else w.uint(5, target.unicode);
  w.packed(8, modifiers).uint(9, KEYBOARD_LEGACY);
  return message(MSG.keyEvent, w);
}

export function clipboardText(text: string): Uint8Array {
  return message(
    MSG.clipboard,
    new PbWriter().bytes(2, Buffer.from(text, "utf8")),
  );
}

export function misc(body: PbWriter): Uint8Array {
  return message(MSG.misc, body);
}

export function refreshVideo(): Uint8Array {
  return misc(new PbWriter().bool(MISC.refreshVideo, true));
}

export function switchDisplay(display: number): Uint8Array {
  return misc(
    new PbWriter().message(MISC.switchDisplay, new PbWriter().uint(1, display)),
  );
}

export function changeResolution(width: number, height: number): Uint8Array {
  return misc(
    new PbWriter().message(
      MISC.changeResolution,
      new PbWriter().uint(1, width).uint(2, height),
    ),
  );
}

export function closeReason(reason: string): Uint8Array {
  return misc(new PbWriter().string(MISC.closeReason, reason));
}

export function restartRemoteDevice(): Uint8Array {
  return misc(new PbWriter().bool(MISC.restartRemoteDevice, true));
}
