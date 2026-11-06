import crypto from "node:crypto";
import net, { type AddressInfo } from "node:net";
import zlib from "node:zlib";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import {
  RustDeskClient,
  LOGIN_ERRORS,
  VIDEO_MIMETYPE,
} from "../../../../../src/backend/engine/worker/rustdesk/client.js";
import {
  Cipher,
  splitKey,
  wrap,
  type Connection,
} from "../../../../../src/backend/engine/worker/rustdesk/transport.js";
import {
  PbMessage,
  PbWriter,
} from "../../../../../src/backend/engine/worker/rustdesk/pb.js";
import {
  MSG,
  RV,
} from "../../../../../src/backend/engine/worker/rustdesk/messages.js";
import { passwordHash } from "../../../../../src/backend/engine/worker/rustdesk/handshake.js";
import { Output } from "../../../../../src/backend/engine/worker/output.js";
import { Display } from "../../../../../src/backend/engine/worker/display.js";
import {
  Settings,
  type RemoteHost,
} from "../../../../../src/backend/engine/worker/remote.js";
import type { FromWorker } from "../../../../../src/backend/engine/messages.js";

const PEER_ID = "123456789";
const PASSWORD = "s3cret";

function fakeHost(settings: Record<string, string>) {
  const posted: string[] = [];
  const events = {
    ready: false,
    failed: null as null | { message: string; status: number },
    closed: false,
    clipboard: [] as string[],
  };
  const port = {
    post: (m: FromWorker) => {
      if (m.t === "out") posted.push(m.data);
    },
  };
  const out = new Output(port);
  const display = new Display(out, { rgbaPng: () => new Uint8Array(0) });
  const host: RemoteHost = {
    out,
    display,
    wasm: null as never,
    settings: new Settings(settings),
    drive: null,
    log: () => {},
    ready: () => {
      events.ready = true;
    },
    fail: (message, status) => {
      events.failed = { message, status };
    },
    closed: () => {
      events.closed = true;
    },
    clipboard: (text) => {
      events.clipboard.push(text);
    },
    sendFile: () => {},
    audio: () => {},
  };
  return {
    host,
    events,
    output: () => {
      out.flush();
      return posted.join("");
    },
  };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

const servers: net.Server[] = [];
const clients: RustDeskClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) s.close();
});

function listen(onConnection: (conn: Connection) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => onConnection(wrap(socket)));
    servers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

const msg = (field: number, body: PbWriter) =>
  new PbWriter().message(field, body).finish();

interface PeerOptions {
  /** What the peer answers the login with. */
  login: (lr: PbMessage, peer: Connection) => void;
  /** Key exchange version the peer offers. */
  kxVersion?: number;
}

/**
 * hbbs, hbbr and the peer on loopback. hbbs answers the punch hole request
 * with a relay; the relay socket is the peer itself.
 */
async function rustdeskWorld(options: PeerOptions) {
  const serverSign = nacl.sign.keyPair();
  const peerSign = nacl.sign.keyPair();
  const peerBox = nacl.box.keyPair();
  const seen = {
    punch: null as PbMessage | null,
    relay: null as PbMessage | null,
  };
  const peerMessages: PbMessage[] = [];
  let peerConn: Connection | null = null;
  const uuid = crypto.randomUUID();

  const relayPort = await listen((conn) => {
    void (async () => {
      const first = PbMessage.decode(await conn.next());
      seen.relay = first.message(RV.requestRelay);
      peerConn = conn;
      const idPk = new PbWriter()
        .string(1, PEER_ID)
        .bytes(2, peerBox.publicKey)
        .uint(4, options.kxVersion ?? 1)
        .finish();
      conn.send(
        msg(
          MSG.signedId,
          new PbWriter().bytes(1, nacl.sign(idPk, peerSign.secretKey)),
        ),
      );
      const pkMsg = PbMessage.decode(await conn.next()).message(MSG.publicKey)!;
      const theirs = pkMsg.bytes(1);
      const key = nacl.box.open(
        pkMsg.bytes(2),
        new Uint8Array(24),
        theirs,
        peerBox.secretKey,
      )!;
      const picked = pkMsg.uint(3);
      if (picked === 0) conn.setCipher(new Cipher(key));
      else {
        const t = {
          initiatorPk: theirs,
          responderPk: peerBox.publicKey,
          advertised: options.kxVersion ?? 1,
          picked,
        };
        conn.setCipher(new Cipher(splitKey(key, 2, t), splitKey(key, 1, t)));
      }
      conn.send(
        msg(MSG.hash, new PbWriter().string(1, "salt").string(2, "chal")),
      );
      conn.onFrame((frame) => {
        const m = PbMessage.decode(frame);
        peerMessages.push(m);
        const lr = m.message(MSG.loginRequest);
        if (lr) options.login(lr, conn);
        const code = m.message(MSG.auth2fa);
        if (code) options.login(m, conn);
      });
    })().catch(() => {});
  });

  const hbbsPort = await listen((conn) => {
    void (async () => {
      const first = PbMessage.decode(await conn.next());
      seen.punch = first.message(RV.punchHoleRequest);
      const signedPk = nacl.sign(
        new PbWriter().string(1, PEER_ID).bytes(2, peerSign.publicKey).finish(),
        serverSign.secretKey,
      );
      conn.send(
        msg(
          RV.relayResponse,
          new PbWriter()
            .string(2, uuid)
            .string(3, `127.0.0.1:${relayPort}`)
            .bytes(5, signedPk),
        ),
      );
    })().catch(() => {});
  });

  return {
    seen,
    uuid,
    peerMessages,
    peer: () => peerConn,
    settings: {
      "rustdesk-id": "123 456 789",
      "id-server": `127.0.0.1:${hbbsPort}`,
      "server-key": Buffer.from(serverSign.publicKey).toString("base64"),
      password: PASSWORD,
      codecs: "vp9,av1",
    } as Record<string, string>,
  };
}

const peerInfo = () =>
  new PbWriter().message(
    2,
    new PbWriter()
      .string(3, "Windows")
      .message(4, new PbWriter().uint(3, 1920).uint(4, 1080).string(5, "one"))
      .message(4, new PbWriter().sint(1, 1920).uint(3, 1280).uint(4, 1024))
      .string(7, "1.4.3"),
  );

function acceptLogin(lr: PbMessage, peer: Connection) {
  const ok =
    Buffer.from(lr.bytes(2)).equals(
      Buffer.from(passwordHash(PASSWORD, "salt", "chal")),
    ) && lr.string(1) === PEER_ID;
  peer.send(
    msg(
      MSG.loginResponse,
      ok ? peerInfo() : new PbWriter().string(1, "Wrong Password"),
    ),
  );
}

function start(world: Awaited<ReturnType<typeof rustdeskWorld>>, extra = {}) {
  const fake = fakeHost({ ...world.settings, ...extra });
  const client = new RustDeskClient(fake.host);
  clients.push(client);
  client.start();
  return { ...fake, client };
}

describe("RustDeskClient", () => {
  it("relays, secures, logs in and streams video", async () => {
    const world = await rustdeskWorld({ login: acceptLogin });
    const { events, output, client } = start(world);
    await until(() => events.ready || !!events.failed);
    expect(events.failed).toBeNull();
    expect(events.ready).toBe(true);

    expect(world.seen.punch!.string(1)).toBe(PEER_ID);
    expect(world.seen.punch!.bool(8)).toBe(true);
    expect(world.seen.relay!.string(2)).toBe(world.uuid);

    const login = world.peerMessages
      .map((m) => m.message(MSG.loginRequest))
      .find(Boolean)!;
    const decoding = login.message(6)!.message(10)!;
    expect(decoding.int(1)).toBe(1);
    expect(decoding.int(6)).toBe(1);
    expect(decoding.int(5)).toBe(0);

    const peer = world.peer()!;
    peer.send(
      msg(
        MSG.videoFrame,
        new PbWriter().message(
          6,
          new PbWriter().message(
            1,
            new PbWriter().bytes(1, Buffer.from("keyframe")).bool(2, true),
          ),
        ),
      ),
    );
    const probe = msg(MSG.testDelay, new PbWriter().uint(1, 42));
    peer.send(probe);
    peer.send(
      msg(
        MSG.clipboard,
        new PbWriter()
          .bool(1, true)
          .bytes(2, zlib.zstdCompressSync(Buffer.from("from peer"))),
      ),
    );
    await until(() => events.clipboard.length > 0);
    expect(events.clipboard).toEqual(["from peer"]);
    const out = output();
    expect(out).toContain("4.size,1.0,4.1920,4.1080;");
    expect(out).toContain(`${VIDEO_MIMETYPE};codec=vp9`);
    expect(out).toContain(
      Buffer.concat([Buffer.from([3]), Buffer.from("keyframe")]).toString(
        "base64",
      ),
    );
    expect(out).toContain("rustdesk-display");
    await until(() => world.peerMessages.some((m) => m.has(MSG.testDelay)));
    expect(
      world.peerMessages
        .find((m) => m.has(MSG.testDelay))!
        .message(MSG.testDelay)!
        .int(1),
    ).toBe(42);

    client.key(0xffe3, true);
    client.key(0x63, true);
    client.mouse(100, 50, 1);
    client.argument("rustdesk-display", "1");
    client.clipboard("to peer");
    await until(() => world.peerMessages.some((m) => m.has(MSG.clipboard)));
    const keys = world.peerMessages
      .map((m) => m.message(MSG.keyEvent))
      .filter((k): k is PbMessage => !!k);
    expect(keys[0].int(3)).toBe(4);
    expect(keys[1].int(4)).toBe(0x63);
    expect(keys[1].fields.has(8)).toBe(true);
    const mice = world.peerMessages
      .map((m) => m.message(MSG.mouseEvent))
      .filter((k): k is PbMessage => !!k);
    expect(mice.map((m) => m.int(1))).toEqual([0, (1 << 3) | 1]);
    expect(mice[0].sint(2)).toBe(100);
    const misc = world.peerMessages.find((m) => m.has(MSG.misc))!;
    expect(misc.message(MSG.misc)!.message(5)!.int(1)).toBe(1);
    const clip = world.peerMessages.find((m) => m.has(MSG.clipboard))!;
    expect(clip.message(MSG.clipboard)!.string(2)).toBe("to peer");
  });

  it("works with the older single key exchange", async () => {
    const world = await rustdeskWorld({ login: acceptLogin, kxVersion: 0 });
    const { events } = start(world);
    await until(() => events.ready || !!events.failed);
    expect(events.ready).toBe(true);
  });

  it("asks for the password again when it is wrong", async () => {
    const world = await rustdeskWorld({ login: acceptLogin });
    const { events } = start(world, { password: "nope" });
    await until(() => !!events.failed);
    expect(events.failed!.message).toBe(LOGIN_ERRORS.passwordWrong);
  });

  it("sends the 2FA code when the peer asks", async () => {
    const world = await rustdeskWorld({
      login: (m, peer) => {
        const code = m.message(MSG.auth2fa);
        peer.send(
          msg(
            MSG.loginResponse,
            code?.string(1) === "123456"
              ? peerInfo()
              : new PbWriter().string(1, "2FA Required"),
          ),
        );
      },
    });
    const without = start(world);
    await until(() => !!without.events.failed);
    expect(without.events.failed!.message).toBe(LOGIN_ERRORS.codeRequired);

    const world2 = await rustdeskWorld({
      login: (m, peer) => {
        const code = m.message(MSG.auth2fa);
        peer.send(
          msg(
            MSG.loginResponse,
            code?.string(1) === "123456"
              ? peerInfo()
              : new PbWriter().string(1, "2FA Required"),
          ),
        );
      },
    });
    const withCode = start(world2, { code: "123 456" });
    await until(() => withCode.events.ready || !!withCode.events.failed);
    expect(withCode.events.failed).toBeNull();
    expect(withCode.events.ready).toBe(true);
  });

  it("refuses a peer key the server did not sign", async () => {
    const world = await rustdeskWorld({ login: acceptLogin });
    const other = nacl.sign.keyPair();
    const { events } = start(world, {
      "server-key": Buffer.from(other.publicKey).toString("base64"),
    });
    await until(() => !!events.failed);
    expect(events.failed!.message).toMatch(/key does not match/);
    expect(events.ready).toBe(false);
  });

  it("explains an offline peer", async () => {
    const port = await listen((conn) => {
      void conn
        .next()
        .then(() =>
          conn.send(msg(RV.punchHoleResponse, new PbWriter().uint(3, 2))),
        );
    });
    const { events } = start({ settings: {} } as never, {
      "rustdesk-id": PEER_ID,
      "id-server": `127.0.0.1:${port}`,
      "server-key": Buffer.alloc(32).toString("base64"),
    });
    await until(() => !!events.failed);
    expect(events.failed!.message).toBe("The remote device is offline");
  });

  it("needs an ID unless direct", async () => {
    const { events } = start({ settings: {} } as never, {});
    await until(() => !!events.failed);
    expect(events.failed!.message).toMatch(/no RustDesk ID/);
  });
});
