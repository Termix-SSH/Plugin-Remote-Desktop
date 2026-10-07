/**
 * RDP shows its first frame before the desktop is drawn, so a session counts
 * as ready on the second sync. Some servers send one full frame and then
 * nothing until the screen changes, so after the first sync it waits at most
 * `waitMs` for the second.
 */
export function createRdpReadyGate(onReady: () => void, waitMs = 1500) {
  let syncs = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    onReady();
  };

  return {
    sync() {
      if (done) return;
      syncs += 1;
      if (syncs === 1) timer = setTimeout(fire, waitMs);
      else fire();
    },
    cancel() {
      done = true;
      if (timer) clearTimeout(timer);
    },
  };
}
