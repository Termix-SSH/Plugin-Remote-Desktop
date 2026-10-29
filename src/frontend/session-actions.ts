import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginApi } from "@termix-ssh/plugin-sdk/frontend";

/** Keysyms for printable ASCII are the character codes. */
export const ENTER_KEYSYM = 0xff0d;
const R_KEYSYM = 0x0072;

type SendKey = (key: number, pressed: boolean) => void;

/** Presses and releases each character of plain ASCII text. */
export function typeText(sendKey: SendKey, text: string): void {
  for (const char of text) {
    const key = char.charCodeAt(0);
    sendKey(key, true);
    sendKey(key, false);
  }
}

/**
 * Signs out of a Windows session the way a person would: Win+R, then the
 * logoff command. Needs the session open and the desktop showing.
 */
export function signOutOfWindows(
  sendKey: SendKey,
  meta: number,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  sendKey(meta, true);
  sendKey(R_KEYSYM, true);
  sendKey(R_KEYSYM, false);
  sendKey(meta, false);
  return wait(800).then(() => {
    typeText(sendKey, "logoff");
    sendKey(ENTER_KEYSYM, true);
    sendKey(ENTER_KEYSYM, false);
  });
}

/**
 * Whether the session can be recorded from the toolbar, and a toggle. Only
 * the built-in engine can start a recording partway through.
 */
export function useSessionRecording(sessionId: string | null | undefined) {
  // The client can be a new object each render; only the session id matters.
  const apiRef = useRef(usePluginApi());
  const [state, setState] = useState({ available: false, recording: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setState({ available: false, recording: false });
      return;
    }
    let cancelled = false;
    void apiRef.current
      .get<{ available: boolean; recording: boolean }>(
        `sessions/${encodeURIComponent(sessionId)}/recording`,
      )
      .then(({ data }) => {
        if (!cancelled) setState(data);
      })
      .catch(() => {
        if (!cancelled) setState({ available: false, recording: false });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const toggle = useCallback(async (): Promise<boolean> => {
    if (!sessionId || busy) return false;
    setBusy(true);
    try {
      const { data } = await apiRef.current.post<{ recording: boolean }>(
        `sessions/${encodeURIComponent(sessionId)}/recording`,
        { on: !state.recording },
      );
      setState((current) => ({ ...current, recording: data.recording }));
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, sessionId, state.recording]);

  return { ...state, busy, toggle };
}
