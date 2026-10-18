import crypto from "node:crypto";
import { desEncryptBlock } from "./des.js";

/**
 * Apple Remote Desktop authentication (security type 30): Diffie-Hellman,
 * then the username and password AES-128 encrypted with MD5 of the secret.
 */
export function ardResponse(
  generator: Buffer,
  prime: Buffer,
  serverKey: Buffer,
  username: string,
  password: string,
): Buffer {
  const dh = crypto.createDiffieHellman(prime, generator);
  const publicKey = pad(dh.generateKeys(), prime.length);
  const secret = pad(dh.computeSecret(serverKey), prime.length);
  const key = crypto.createHash("md5").update(secret).digest();

  const credentials = crypto.randomBytes(128);
  writeCString(credentials, 0, username, 64);
  writeCString(credentials, 64, password, 64);
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(credentials), cipher.final()]);
  return Buffer.concat([encrypted, publicKey]);
}

function writeCString(
  target: Buffer,
  offset: number,
  value: string,
  size: number,
) {
  const bytes = Buffer.from(value, "utf8").subarray(0, size - 1);
  bytes.copy(target, offset);
  target[offset + bytes.length] = 0;
}

function pad(value: Buffer, length: number): Buffer {
  if (value.length >= length) return value;
  return Buffer.concat([Buffer.alloc(length - value.length), value]);
}

/** VeNCrypt Plain: lengths, then username and password. */
export function plainCredentials(username: string, password: string): Buffer {
  const user = Buffer.from(username, "utf8");
  const pass = Buffer.from(password, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(user.length, 0);
  header.writeUInt32BE(pass.length, 4);
  return Buffer.concat([header, user, pass]);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function mirror(byte: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) out = (out << 1) | ((byte >> i) & 1);
  return out;
}

/**
 * UltraVNC's DES-CBC: the key doubles as the IV, and its bits are mirrored
 * like a VncAuth password.
 */
export function ultraEncrypt(data: Buffer, key: Buffer): Buffer {
  const desKey = Uint8Array.from(key, mirror);
  const out = Buffer.from(data);
  let previous: Uint8Array = key;
  for (let i = 0; i < out.length; i += 8) {
    for (let j = 0; j < 8; j++) out[i + j] ^= previous[j];
    const block = desEncryptBlock(desKey, out.subarray(i, i + 8));
    out.set(block, i);
    previous = block;
  }
  return out;
}

/**
 * MS-Logon II (security type 113): Diffie-Hellman on 64 bit numbers, then
 * the username (256 bytes) and password (64 bytes) DES encrypted with the
 * shared key. Returns what the client sends.
 */
export function msLogonResponse(
  generator: Buffer,
  modulus: Buffer,
  serverKey: Buffer,
  username: string,
  password: string,
  privateKey: bigint = BigInt(`0x${crypto.randomBytes(8).toString("hex")}`),
): Buffer {
  const g = generator.readBigUInt64BE(0);
  const m = modulus.readBigUInt64BE(0);
  const r = serverKey.readBigUInt64BE(0);
  const priv = privateKey % m;
  const publicKey = Buffer.alloc(8);
  publicKey.writeBigUInt64BE(modPow(g, priv, m));
  const key = Buffer.alloc(8);
  key.writeBigUInt64BE(modPow(r, priv, m));
  const user = Buffer.alloc(256);
  user.write(username.slice(0, 255), "latin1");
  const pass = Buffer.alloc(64);
  pass.write(password.slice(0, 63), "latin1");
  return Buffer.concat([
    publicKey,
    ultraEncrypt(user, key),
    ultraEncrypt(pass, key),
  ]);
}
