export type MoonlightEmbed = "iframe" | "window";

function isIpAddress(hostname: string): boolean {
  return hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

function parentDomain(hostname: string): string | null {
  const labels = hostname.split(".");
  return labels.length < 2 ? null : labels.slice(-2).join(".");
}

/**
 * Picks how to show a stream. Moonlight Web's cookie is SameSite=Strict, so a
 * frame only stays signed in on a site sharing Termix's parent domain. The
 * same hostname is refused because Termix's own cookies would go to the page.
 */
export function moonlightEmbed(
  streamUrl: string,
  pageUrl: string,
  desktop: boolean,
): MoonlightEmbed {
  if (desktop) return "window";
  const stream = new URL(streamUrl);
  const page = new URL(pageUrl);
  if (stream.protocol !== page.protocol) return "window";
  if (stream.hostname === page.hostname) return "window";
  if (isIpAddress(stream.hostname) || isIpAddress(page.hostname)) {
    return "window";
  }
  const parent = parentDomain(stream.hostname);
  return parent && parent === parentDomain(page.hostname) ? "iframe" : "window";
}

/** The keys a framed stream asks to lock, or null if the message is not one. */
export function keyboardLockRequest(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  frame: Window | null | undefined,
  streamUrl: string,
): string[] | undefined | null {
  if (!frame || event.source !== frame) return null;
  if (event.origin !== new URL(streamUrl).origin) return null;
  const data = event.data as { type?: unknown; keys?: unknown } | null;
  if (data?.type !== "REQUEST_KEYBOARD_LOCK") return null;
  return Array.isArray(data.keys)
    ? data.keys.filter((key): key is string => typeof key === "string")
    : undefined;
}

/** Whether this browser can decode H.264, the one codec every Sunshine has. */
export async function canPlayH264(): Promise<boolean> {
  try {
    if (typeof VideoDecoder !== "undefined") {
      const result = await VideoDecoder.isConfigSupported({
        codec: "avc1.42E01E",
      });
      if (result.supported) return true;
    }
  } catch {
    // fall through to the media source check
  }
  try {
    return (
      typeof MediaSource !== "undefined" &&
      MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
    );
  } catch {
    return false;
  }
}
