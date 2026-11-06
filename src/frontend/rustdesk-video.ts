import type Guacamole from "guacamole-common-js";

/** What the built-in engine sends RustDesk video as; matches the worker. */
export const RUSTDESK_VIDEO_MIMETYPE = "video/x-termix-rustdesk";
export const RUSTDESK_DISPLAYS_ARGUMENT = "rustdesk-display";
const FRAME_KEY = 1;
const FRAME_END = 2;
/** Delta frames are dropped while this many wait to be decoded. */
const MAX_QUEUE = 6;

const CODECS: Record<string, string> = {
  vp9: "vp09.00.10.08",
  av1: "av01.0.08M.08",
  vp8: "vp8",
};

/** Codecs this browser can decode, best first, for the connect request. */
export async function supportedRustdeskCodecs(): Promise<string> {
  if (typeof VideoDecoder === "undefined") return "";
  const out: string[] = [];
  for (const [name, codec] of Object.entries(CODECS)) {
    try {
      const result = await VideoDecoder.isConfigSupported({ codec });
      if (result.supported) out.push(name);
    } catch {
      // Not this one.
    }
  }
  return out.join(",");
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function join(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Plays one RustDesk video stream into a layer with WebCodecs. Returns null
 * for anything that is not RustDesk video, so other players still get it.
 */
export function rustdeskVideoPlayer(
  stream: Guacamole.InputStream,
  layer: Guacamole.Layer,
  mimetype: string,
  onError: (reason: "unsupported" | "decode") => void,
): Guacamole.VideoPlayer | null {
  if (!mimetype.startsWith(RUSTDESK_VIDEO_MIMETYPE)) return null;
  const name = /codec=(\w+)/.exec(mimetype)?.[1] ?? "";
  const codec = CODECS[name];
  if (!codec || typeof VideoDecoder === "undefined") {
    onError("unsupported");
    return null;
  }
  const canvas = layer.getCanvas();
  const context = canvas.getContext("2d");
  let pending: Uint8Array[] = [];
  let needKey = true;
  let timestamp = 0;
  let closed = false;

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (context && canvas.width > 0 && canvas.height > 0) {
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      }
      frame.close();
    },
    error: () => {
      needKey = true;
      if (!closed) onError("decode");
    },
  });
  decoder.configure({ codec, optimizeForLatency: true });

  stream.onblob = (data) => {
    if (closed || decoder.state === "closed") return;
    const bytes = base64Bytes(data);
    if (bytes.length === 0) return;
    const flags = bytes[0];
    pending.push(bytes.subarray(1));
    if (!(flags & FRAME_END)) return;
    const frame = join(pending);
    pending = [];
    const key = (flags & FRAME_KEY) !== 0;
    if (!key && (needKey || decoder.decodeQueueSize > MAX_QUEUE)) {
      needKey = true;
      return;
    }
    if (key) needKey = false;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp: (timestamp += 16_000),
          data: frame,
        }),
      );
    } catch {
      needKey = true;
    }
  };
  stream.onend = () => {
    closed = true;
    if (decoder.state !== "closed") decoder.close();
  };

  return { sync: () => {} };
}

export interface RustdeskDisplays {
  current: number;
  list: Array<{ index: number; name: string; width: number; height: number }>;
}

/** The monitor list the engine sends as an argv stream. */
export function readRustdeskDisplays(
  stream: Guacamole.InputStream,
  StringReader: typeof Guacamole.StringReader,
  onDisplays: (displays: RustdeskDisplays) => void,
): void {
  const reader = new StringReader(stream);
  let text = "";
  reader.ontext = (chunk) => {
    text += chunk;
  };
  reader.onend = () => {
    try {
      const parsed = JSON.parse(text) as RustdeskDisplays;
      if (Array.isArray(parsed.list)) onDisplays(parsed);
    } catch {
      // Ignore a bad list.
    }
  };
}
