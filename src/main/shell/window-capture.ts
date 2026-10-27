// Screenshots of the app window for the REST API: switch the window to a view (Feeds, or one feed's chart) and capture
// it whether it is visible, minimised or hidden in the tray, without showing or focusing it, and leave it as it was.
// Electron comes in as a port.
// `capturePage` fails on a hidden window, and a minimised one runs no animation frames, so its page never paints the new
// view (a chart's canvas least of all): either is made transparent and shown without focus for the capture. Chromium
// still renders a transparent window as hidden unless its background throttling is off (seen on Electron 44), and so
// too a shown window that other windows cover: throttling is off for every capture.
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
  /** Keeps the window off the taskbar while shown (the app's window is otherwise always on it). */
  setSkipTaskbar(skip: boolean): void;
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
  /** How long to wait after the page says it has drawn, before capturing; SETTLE_MS by default. */
  settleMs?: number;
};

/**
 * The page's frames are in before Chromium has painted every part of them: on the real app, a Feeds capture straight
 * after a chart showed Charts still current in the sidebar in half the captures without this wait, and none with it.
 */
export const SETTLE_MS = 300;

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
    const shown = state === "visible";
    const opacity = window.getOpacity();
    const throttling = window.getBackgroundThrottling();
    // A shown window that other windows cover renders no more than a hidden one, so throttling is off for every capture.
    // A minimised window keeps its taskbar button; a hidden one is kept off the taskbar while it is shown.
    const putBack = shown
      ? []
      : state === "hidden"
        ? [() => window.hide(), () => window.setSkipTaskbar(false), () => window.setOpacity(opacity)]
        : [() => window.minimize(), () => window.setOpacity(opacity)];
    // Set before showing, so a failure part-way still puts the window back and gives its taskbar button, opacity and
    // throttling back.
    let restore = () => {
      restore = () => {};
      for (const step of [...putBack, () => window.setBackgroundThrottling(throttling)]) {
        try {
          step();
        } catch (e) {
          console.error(`[QuoteBridge] screenshot: the app window could not be put back: ${(e as Error)?.message ?? e}`);
        }
      }
    };
    try {
      if (!shown) window.setOpacity(0);
      window.setBackgroundThrottling(false);
      if (state === "hidden") window.setSkipTaskbar(true);
      if (!shown) window.showInactive();
    } catch (e) {
      restore();
      return Promise.reject(new CaptureFailure("window-unavailable", `The app window could not be prepared for capture: ${(e as Error)?.message ?? e}`));
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
    await new Promise((r) => setTimeout(r, this.options.settleMs ?? SETTLE_MS));
    if (ended()) throw new CaptureFailure("screenshot-timeout", "The app window was not captured within the deadline.");
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
