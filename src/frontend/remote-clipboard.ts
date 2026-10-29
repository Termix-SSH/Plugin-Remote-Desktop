/**
 * Puts text from the remote session on the local clipboard. The async
 * clipboard API only exists on HTTPS (and wants focus), so over plain HTTP
 * the text waits for the next click or key press in the page, where the old
 * execCommand copy is allowed.
 */

function copyWithCommand(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

export function createRemoteClipboard(onWaiting?: () => void) {
  let pending: string | null = null;

  const flush = () => {
    if (pending === null) return;
    const text = pending;
    pending = null;
    copyWithCommand(text);
  };
  const events = ["pointerup", "keyup"] as const;
  for (const event of events)
    document.addEventListener(event, flush, { capture: true });

  const wait = (text: string) => {
    const first = pending === null;
    pending = text;
    if (first) onWaiting?.();
  };

  return {
    copy(text: string) {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => wait(text));
        return;
      }
      wait(text);
    },
    dispose() {
      for (const event of events)
        document.removeEventListener(event, flush, { capture: true });
    },
  };
}
