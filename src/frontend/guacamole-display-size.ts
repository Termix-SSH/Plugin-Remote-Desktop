const DEFAULT_RDP_DPI = 96;
const MAX_DEVICE_PIXEL_RATIO = 3;

/**
 * Reads a guacamoleConfig display field. The UI stores these as strings, and
 * leaves them empty when the size should follow the browser window.
 */
export function readConfiguredDimension(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface GuacamoleDisplaySize {
  width: number;
  height: number;
  dpi?: number;
  pixelRatio: number;
}

/**
 * RDP renders at native pixels on HiDPI screens unless the host pins the
 * size or DPI. A pinned value is sent as entered, since older servers ignore
 * the DPI and would show a native-pixel desktop at half size.
 */
export function getGuacamoleDisplaySize(
  cssWidth: number,
  cssHeight: number,
  protocol: string | undefined,
  devicePixelRatio: number,
  configuredDpi?: number,
  configuredSize = false,
): GuacamoleDisplaySize {
  const isRdp = protocol === "rdp";
  const hasDpi =
    !!configuredDpi && Number.isFinite(configuredDpi) && configuredDpi > 0;
  const pixelRatio =
    isRdp && !hasDpi && !configuredSize
      ? Math.min(
          MAX_DEVICE_PIXEL_RATIO,
          Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1),
        )
      : 1;

  const size = {
    width: Math.max(1, Math.round(cssWidth * pixelRatio)),
    height: Math.max(1, Math.round(cssHeight * pixelRatio)),
    pixelRatio,
  };

  if (!isRdp) return size;

  const baseDpi = hasDpi ? configuredDpi : DEFAULT_RDP_DPI;
  return { ...size, dpi: Math.round(baseDpi * pixelRatio) };
}
