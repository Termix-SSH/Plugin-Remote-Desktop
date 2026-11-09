import type { ClientFactory } from "./core.js";
import { RdpClient } from "./rdp/client.js";
import { VncClient } from "./vnc/client.js";
import { TelnetClient } from "./telnet/client.js";
import { RustDeskClient } from "./rustdesk/client.js";

export const CLIENTS: Record<string, ClientFactory> = {
  rdp: (host) => new RdpClient(host),
  vnc: (host) => new VncClient(host),
  telnet: (host) => new TelnetClient(host),
  rustdesk: (host) => new RustDeskClient(host),
};
