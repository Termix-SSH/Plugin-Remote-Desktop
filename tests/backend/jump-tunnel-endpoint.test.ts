import { describe, expect, it } from "vitest";
import { resolveJumpTunnelEndpoint } from "../../src/backend/jump-tunnel-endpoint.js";

describe("resolveJumpTunnelEndpoint", () => {
  it("keeps an in-process guacd tunnel on loopback", () => {
    expect(resolveJumpTunnelEndpoint("localhost")).toEqual({
      bindHost: "127.0.0.1",
      advertisedHost: "127.0.0.1",
    });
  });

  it("exposes the tunnel to a separate guacd container", () => {
    expect(resolveJumpTunnelEndpoint("guacd", undefined, {})).toEqual({
      bindHost: "0.0.0.0",
      advertisedHost: "termix",
    });
  });

  it("supports a custom backend hostname for external guacd", () => {
    expect(
      resolveJumpTunnelEndpoint("guacd.example", "termix-backend"),
    ).toEqual({
      bindHost: "0.0.0.0",
      advertisedHost: "termix-backend",
    });
  });

  it("advertises the pod IP in Kubernetes, where termix is the Service", () => {
    const interfaces = {
      lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      eth0: [{ family: "IPv4", internal: false, address: "10.42.0.17" }],
    } as never;
    expect(
      resolveJumpTunnelEndpoint(
        "guacd",
        undefined,
        { KUBERNETES_SERVICE_HOST: "10.43.0.1" },
        interfaces,
      ),
    ).toEqual({ bindHost: "0.0.0.0", advertisedHost: "10.42.0.17" });
    expect(
      resolveJumpTunnelEndpoint(
        "guacd",
        "termix-backend",
        { KUBERNETES_SERVICE_HOST: "10.43.0.1" },
        interfaces,
      ).advertisedHost,
    ).toBe("termix-backend");
  });
});
