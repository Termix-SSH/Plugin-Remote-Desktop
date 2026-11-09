/** Resume Guacamole's shared audio context within a browser user gesture. */
export function bindAudioUnlock(
  element: HTMLElement,
  getContext: () => AudioContext | null,
): () => void {
  const unlock = () => {
    const context = getContext();
    if (context?.state === "suspended") {
      // A denied attempt must not interfere with remote keyboard/pointer input.
      void context.resume().catch(() => {});
    }
  };
  element.addEventListener("pointerup", unlock, true);
  element.addEventListener("keydown", unlock, true);
  return () => {
    element.removeEventListener("pointerup", unlock, true);
    element.removeEventListener("keydown", unlock, true);
  };
}
