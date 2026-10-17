import dgram from "node:dgram";

/** A Wake-on-LAN magic packet: six 0xff bytes, then the MAC 16 times. */
export function magicPacket(mac: string): Buffer | null {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return null;
  const address = Buffer.from(hex, "hex");
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) address.copy(packet, 6 + i * 6);
  return packet;
}

export function sendMagicPacket(
  mac: string,
  address = "255.255.255.255",
  port = 9,
): Promise<void> {
  const packet = magicPacket(mac);
  if (!packet) return Promise.reject(new Error(`Invalid MAC address ${mac}`));
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, address, (error) => {
        socket.close();
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

/** guacd's normalize-clipboard: preserve, unix or windows line endings. */
export function normalizeLineEndings(text: string, mode: string): string {
  if (mode === "unix") return text.replace(/\r\n?/g, "\n");
  if (mode === "windows") return text.replace(/\r\n?|\n/g, "\r\n");
  return text;
}
