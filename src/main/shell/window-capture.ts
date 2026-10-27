// Screenshots of the app window for the REST API: switch the window to a view (Feeds, or one feed's chart) and capture
// it whether it is visible, minimised or hidden in the tray, without showing or focusing it, and leave it as it was.
// Electron comes in as a port.
// `capturePage` fails on a hidden window, and a minimised one runs no animation frames, so its page never paints the new
// view (a chart's canvas least of all): either is made transparent and shown without focus for the capture. Chromium
// still renders a transparent window as hidden unless its background throttling is off (seen on Electron 44).
import { CAPTURE_DEADLINE_MS, type CaptureErrorCode, type PageReady, type ScreenshotTarget, type WindowCapture, type WindowState } from "../../shared/server-host-protocol.js";

export type { PageReady };

/** The app window, as the capture needs it. */
export interface CaptureTarget {
  /** Why there is nothing to capture now (main starting, renderer being recreated), or null. */
  unavailable(): string | null;
  state(): WindowState;
  getOpacity(): number;
  setOpacity(value: number): void;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  /** Shows a hidden window, or restores a minimised one, without focusing it. */
  showInactive(): void;
  hide(): void;
  minimize(): void;
  /** The display scale of the window's screen. */
  scale(): number;
  /** Asks the page to switch to the target unless a dialog is open, and to answer once it has drawn. */
  prepare(target: ScreenshotTarget): Promise<PageReady>;
  /** The window's page as PNG bytes; empty when nothing has been drawn yet. */
  capture(): Promise<Uint8Array>;
}

export class CaptureFailure extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type WindowCapturerOptions = {
  now?: () => number;
  deadlineMs?: number;
  /** How long to wait before capturing again after an empty image. */
  retryMs?: number;
};

export class WindowCapturer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly window: CaptureTarget,
    private readonly options: WindowCapturerOptions = {},
  ) {}

  /** One capture at a time; each is given its deadline from when its turn comes. */
  capture(target: ScreenshotTarget): Promise<WindowCapture> {
    const turn = this.queue.then(() => this.once(target));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private once(target: ScreenshotTarget): Promise<WindowCapture> {
    const { window } = this;
    const why = window.unavailable();
    if (why) return Promise.reject(new CaptureFailure("window-unavailable", why));
    const deadlineMs = this.options.deadlineMs ?? CAPTURE_DEADLINE_MS;
    const state = window.state();
    let done = false;
    let restore = () => {};
    if (state !== "visible") {
      const opacity = window.getOpacity();
      const throttling = window.getBackgroundThrottling();
      const putBack = state === "hidden" ? () => window.hide() : () => window.minimize();
      // Set before showing, so a failure part-way still puts the window back and gives its opacity and throttling back.
      restore = () => {
        restore = () => {};
        for (const step of [putBack, () => window.setOpacity(opacity), () => window.setBackgroundThrottling(throttling)]) {
          try {
            step();
          } catch (e) {
            console.error(`[QuoteBridge] screenshot: the app window could not be put back: ${(e as Error)?.message ?? e}`);
          }
        }
      };
      try {
        window.setOpacity(0);
        window.setBackgroundThrottling(false);
        window.showInactive();
      } catch (e) {
        restore();
        return Promise.reject(new CaptureFailure("window-unavailable", `The app window could not be prepared for capture: ${(e as Error)?.message ?? e}`));
      }
    }
    return new Promise<WindowCapture>((resolve, reject) => {
      const finish = (error: CaptureFailure | null, capture?: WindowCapture) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Never throws, so the capture always settles and the queue moves on.
        restore();
        if (error) reject(error);
        else resolve(capture!);
      };
      const timer = setTimeout(() => finish(new CaptureFailure("screenshot-timeout", `The app window was not captured within ${deadlineMs / 1000} seconds.`)), deadlineMs);
      this.take(target, state, () => done).then(
        (capture) => finish(null, capture),
        (e) => finish(e instanceof CaptureFailure ? e : new CaptureFailure("window-unavailable", `The app window could not be captured: ${(e as Error)?.message ?? e}`)),
      );
    });
  }

  /** Switches, waits for the drawing and captures; stops early once the capture has `ended` (deadline). */
  private async take(target: ScreenshotTarget, state: WindowState, ended: () => boolean): Promise<WindowCapture> {
    const { window } = this;
    const page = await window.prepare(target);
    // Past the deadline the window is already as it was; a hidden or minimised one would not capture anyway.
    if (ended()) throw new CaptureFailure("screenshot-timeout", "The app window answered after the deadline.");
    if ("busy" in page) throw new CaptureFailure("window-busy", `The app window has a dialog open ("${page.busy}"). Close it and try again.`);
    if ("unavailable" in page) throw new CaptureFailure("window-unavailable", page.unavailable);
    let image = await window.capture();
    while (!image.length && !ended()) {
      await new Promise((r) => setTimeout(r, this.options.retryMs ?? 50));
      if (!ended()) image = await window.capture();
    }
    const { width, height } = pngSize(image);
    return { view: target.view, window: state, width, height, scale: window.scale(), live: page.live, capturedAt: (this.options.now ?? Date.now)(), png: Buffer.from(image).toString("base64") };
  }
}

/** A PNG's size from its IHDR chunk (bytes 16–23). */
function pngSize(png: Uint8Array) {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
