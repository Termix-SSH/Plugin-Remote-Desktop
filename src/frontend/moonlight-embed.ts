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
