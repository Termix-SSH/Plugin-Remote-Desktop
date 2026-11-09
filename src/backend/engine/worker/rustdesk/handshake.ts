import crypto from "node:crypto";
import nacl from "tweetnacl";
import { Status } from "../../protocol.js";
import { PbMessage } from "./pb.js";
import {
  MSG,
  PUNCH_FAILURE,
  RV,
  publicKey,
  punchHoleRequest,
  readIdPk,
  readPunchHoleResponse,
  readRelayResponse,
  requestRelay,
} from "./messages.js";
import {
  Cipher,
  connect,
  kxVersionFor,
  parseAddress,
  splitKey,
  type Connection,
  type Dialer,
} from "./transport.js";

export const RENDEZVOUS_PORT = 21116;
export const RELAY_PORT = 21117;
export const DIRECT_PORT = 21118;
/** RustDesk's public server and its key, used when nothing is set. */
export const PUBLIC_SERVER = "rs-ny.rustdesk.com";
export const PUBLIC_KEY = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";
/** The RustDesk version this client says it is. Peers gate features on it. */
export const CLIENT_VERSION = "1.4.3";

export class RustDeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const {
  UPSTREAM_NOT_FOUND,
  UPSTREAM_UNAVAILABLE,
  UPSTREAM_ERROR,
  UPSTREAM_TIMEOUT,
} = Status;

export interface RouteOptions {
  peerId: string;
  /** hbbs as host or host:port. Blank means RustDesk's public server. */
  idServer: string;
  /** hbbr as host or host:port. Blank means what hbbs says. */
  relayServer: string;
  /** hbbs public key, base64. */
  key: string;
  dial?: Dialer;
  timeoutMs?: number;
}

function serverKey(key: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(key.trim(), "base64");
    return bytes.length === 32 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

/** The rendezvous message, skipping hbbs key exchange offers. */
async function nextRendezvous(
  conn: Connection,
  timeoutMs: number,
): Promise<PbMessage> {
  for (let i = 0; i < 4; i++) {
    const m = PbMessage.decode(await conn.next(timeoutMs));
    if (!m.has(RV.keyExchange)) return m;
  }
  throw new RustDeskError(
    "The RustDesk server did not answer",
    UPSTREAM_TIMEOUT,
  );
}

function relayAddress(fromServer: string, configured: string, idHost: string) {
  return parseAddress(configured || fromServer || idHost, RELAY_PORT);
}

export interface Route {
  conn: Connection;
  /** The peer's signing key from hbbs, signed by the server key. */
  signedPk: Uint8Array;
}

/**
 * Asks hbbs for the peer and meets it on hbbr. Termix never hole punches:
 * it runs on a server, so it always asks for the relay.
 */
export async function relayRoute(options: RouteOptions): Promise<Route> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const idServer = parseAddress(
    options.idServer || PUBLIC_SERVER,
    RENDEZVOUS_PORT,
  );
  const key = options.key || (options.idServer ? "" : PUBLIC_KEY);
  const hbbs = await connect(
    idServer.host,
    idServer.port,
    timeoutMs,
    options.dial,
  ).catch((error: Error) => {
    throw new RustDeskError(
      `Could not reach the RustDesk ID server: ${error.message}`,
      UPSTREAM_UNAVAILABLE,
    );
  });
  try {
    hbbs.send(punchHoleRequest(options.peerId, key, CLIENT_VERSION));
    for (let i = 0; i < 6; i++) {
      const m = await nextRendezvous(hbbs, timeoutMs).catch(() => {
        throw new RustDeskError(
          "The RustDesk ID server did not answer",
          UPSTREAM_TIMEOUT,
        );
      });
      const relayField = m.message(RV.relayResponse);
      if (relayField) {
        const rr = readRelayResponse(relayField);
        if (rr.refuseReason) {
          throw new RustDeskError(rr.refuseReason, UPSTREAM_ERROR);
        }
        const conn = await openRelay(options, rr.uuid, {
          address: relayAddress(
            rr.relayServer,
            options.relayServer,
            idServer.host,
          ),
          key,
          timeoutMs,
        });
        return { conn, signedPk: rr.pk };
      }
      const punchField = m.message(RV.punchHoleResponse);
      if (punchField) {
        const ph = readPunchHoleResponse(punchField);
        if (ph.socketAddr.length === 0) {
          if (ph.otherFailure) {
            throw new RustDeskError(ph.otherFailure, UPSTREAM_ERROR);
          }
          throw new RustDeskError(
            PUNCH_FAILURE[ph.failure] ?? "The RustDesk ID server refused",
            ph.failure === 2 ? UPSTREAM_UNAVAILABLE : UPSTREAM_NOT_FOUND,
          );
        }
        // hbbs found the peer; ask for a relay with our own uuid.
        const address = relayAddress(
          ph.relayServer,
          options.relayServer,
          idServer.host,
        );
        const conn = await requestOwnRelay(options, idServer, {
          address,
          relayServerName: ph.relayServer || `${address.host}:${address.port}`,
          key,
          secure: ph.pk.length > 0,
          timeoutMs,
        });
        return { conn, signedPk: ph.pk };
      }
    }
    throw new RustDeskError(
      "The RustDesk ID server sent nothing useful",
      UPSTREAM_ERROR,
    );
  } finally {
    hbbs.close();
  }
}

async function requestOwnRelay(
  options: RouteOptions,
  idServer: { host: string; port: number },
  relay: {
    address: { host: string; port: number };
    relayServerName: string;
    key: string;
    secure: boolean;
    timeoutMs: number;
  },
): Promise<Connection> {
  const uuid = crypto.randomUUID();
  const hbbs = await connect(
    idServer.host,
    idServer.port,
    relay.timeoutMs,
    options.dial,
  );
  try {
    hbbs.send(
      requestRelay({
        id: options.peerId,
        uuid,
        relayServer: relay.relayServerName,
        secure: relay.secure,
      }),
    );
    const m = await nextRendezvous(hbbs, relay.timeoutMs);
    const field = m.message(RV.relayResponse);
    if (field) {
      const rr = readRelayResponse(field);
      if (rr.refuseReason) {
        throw new RustDeskError(rr.refuseReason, UPSTREAM_ERROR);
      }
    }
  } finally {
    hbbs.close();
  }
  return openRelay(options, uuid, relay);
}

async function openRelay(
  options: RouteOptions,
  uuid: string,
  relay: {
    address: { host: string; port: number };
    key: string;
    timeoutMs: number;
  },
): Promise<Connection> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uuid)) {
    throw new RustDeskError("Bad relay id from the server", UPSTREAM_ERROR);
  }
  const conn = await connect(
    relay.address.host,
    relay.address.port,
    relay.timeoutMs,
    options.dial,
  ).catch((error: Error) => {
    throw new RustDeskError(
      `Could not reach the RustDesk relay server: ${error.message}`,
      UPSTREAM_UNAVAILABLE,
    );
  });
  conn.send(requestRelay({ id: options.peerId, uuid, key: relay.key }));
  return conn;
}

/** A peer with direct IP access on, at host:port (21118 by default). */
export async function directRoute(
  host: string,
  port: number,
  dial?: Dialer,
  timeoutMs = 10_000,
): Promise<Route> {
  const conn = await connect(host, port, timeoutMs, dial).catch(
    (error: Error) => {
      throw new RustDeskError(
        `Could not reach the remote device: ${error.message}`,
        UPSTREAM_UNAVAILABLE,
      );
    },
  );
  return { conn, signedPk: new Uint8Array(0) };
}

/** Opens a message signed with ed25519 (signature, then the message). */
export function openSigned(
  signed: Uint8Array,
  pk: Uint8Array | null,
): Uint8Array | null {
  if (signed.length < nacl.sign.signatureLength) return null;
  if (!pk) return signed.subarray(nacl.sign.signatureLength);
  return nacl.sign.open(signed, pk);
}

/**
 * Checks who the peer is and sets up encryption. Through an ID server the
 * peer's key is checked against the server's signature. Direct IP has no one
 * to vouch for the peer, so its key is taken as given: still encrypted, but
 * not proof of who answered.
 */
export async function secure(
  conn: Connection,
  peerId: string,
  route: Route,
  options: { key: string; direct: boolean; idServer: string },
  timeoutMs = 10_000,
): Promise<{ verified: boolean }> {
  let peerSignPk: Uint8Array | null = null;
  if (!options.direct) {
    const rsKey = serverKey(
      options.key || (options.idServer ? "" : PUBLIC_KEY),
    );
    if (!rsKey) {
      throw new RustDeskError(
        "Set the RustDesk server key to connect securely",
        UPSTREAM_ERROR,
      );
    }
    const idPkBytes =
      route.signedPk.length > 0 ? openSigned(route.signedPk, rsKey) : null;
    const idPk = idPkBytes ? readIdPk(idPkBytes) : null;
    if (!idPk || idPk.id !== peerId || idPk.pk.length !== 32) {
      throw new RustDeskError(
        "The RustDesk server key does not match the server",
        UPSTREAM_ERROR,
      );
    }
    peerSignPk = idPk.pk;
  }

  const first = PbMessage.decode(await conn.next(timeoutMs));
  const signedId = first.message(MSG.signedId);
  if (!signedId) {
    throw new RustDeskError(
      "The remote device did not start a secure session",
      UPSTREAM_ERROR,
    );
  }
  const opened = openSigned(signedId.bytes(1), peerSignPk);
  const theirs = opened ? readIdPk(opened) : null;
  if (!theirs || theirs.pk.length !== 32) {
    throw new RustDeskError(
      "The remote device's key could not be checked",
      UPSTREAM_ERROR,
    );
  }
  if (!options.direct && theirs.id !== peerId) {
    throw new RustDeskError(
      "The remote device answered with another ID",
      UPSTREAM_ERROR,
    );
  }

  const ours = nacl.box.keyPair();
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const sealed = nacl.box(
    key,
    new Uint8Array(nacl.box.nonceLength),
    theirs.pk,
    ours.secretKey,
  );
  const picked = kxVersionFor(theirs.kxVersion);
  conn.send(publicKey(ours.publicKey, sealed, picked));
  if (picked === 0) {
    conn.setCipher(new Cipher(key));
  } else {
    const t = {
      initiatorPk: ours.publicKey,
      responderPk: theirs.pk,
      advertised: theirs.kxVersion,
      picked,
    };
    conn.setCipher(new Cipher(splitKey(key, 1, t), splitKey(key, 2, t)));
  }
  return { verified: !options.direct };
}

/** sha256(sha256(password + salt) + challenge), the RustDesk login hash. */
export function passwordHash(
  password: string,
  salt: string,
  challenge: string,
): Uint8Array {
  if (!password) return new Uint8Array(0);
  const first = crypto
    .createHash("sha256")
    .update(password)
    .update(salt)
    .digest();
  return crypto.createHash("sha256").update(first).update(challenge).digest();
}
