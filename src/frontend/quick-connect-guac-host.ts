import type { GuacamoleQuickHost } from "./GuacamoleApp";
import {
  hostRemoteOptions,
  type Protocol,
  type RemoteHostLogin,
} from "./host-remote";

/** The slice of a quick-connect host that GuacamoleApp mints a token from. */
export function quickConnectGuacHost(
  host: RemoteHostLogin,
): GuacamoleQuickHost {
  const options = hostRemoteOptions(host);
  const connectionType: Protocol = options.enableVnc
    ? "vnc"
    : options.enableArd
      ? "ard"
      : "rdp";
  const login =
    host.quickConnectLogin?.protocol === connectionType
      ? host.quickConnectLogin
      : undefined;
  return {
    name: host.name ?? undefined,
    ip: host.ip ?? "",
    connectionType,
    domain: login?.fields?.domain,
    port:
      connectionType === "vnc"
        ? options.vncPort
        : connectionType === "ard"
          ? options.ardPort
          : options.rdpPort,
    rdpAuthType: "direct",
    username: login?.username,
    password: login?.password,
    // Newer than the SDK types: Termix 26.11.3 carries it.
    credentialId: credentialIdOf(login),
    viewOnly: (login as { viewOnly?: unknown } | undefined)?.viewOnly === true,
  };
}

function credentialIdOf(login: unknown): number | undefined {
  const id = (login as { credentialId?: unknown } | undefined)?.credentialId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : undefined;
}
