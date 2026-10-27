// Screenshots of the app window for the REST API: switch the window to a view and capture it whether it is visible,
// minimised or hidden in the tray, without showing or focusing it, and leave it as it was. Electron comes in as a port.
// `capturePage` fails on a hidden window, so a hidden one is made transparent and shown without focus for the capture.
import type { CaptureErrorCode, LiveLinkState, ScreenshotView, WindowCapture, WindowState } from "../../shared/server-host-protocol.js";

/** The page's answer to "switch to this view and say when it has drawn". */
export type PageReady = { ready: true; live: LiveLinkState } | { busy: string } | { unavailable: string };

/** The app window, as the capture needs it. */
export interface CaptureTarget {
  /** Why there is nothing to capture now (main starting, renderer being recreated), or null. */
  unavailable(): string | null;
  state(): WindowState;
  getOpacity(): number;
  setOpacity(value: number): void;
  showInactive(): void;
  hide(): void;
  /** The display scale of the window's screen. */
  scale(): number;
  /** Asks the page to switch to `view` unless a dialog is open, and to answer once it has drawn. */
  prepare(view: ScreenshotView): Promise<PageReady>;
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
  capture(view: ScreenshotView): Promise<WindowCapture> {
    const turn = this.queue.then(() => this.once(view));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private once(view: ScreenshotView): Promise<WindowCapture> {
    const { window } = this;
    const why = window.unavailable();
    if (why) return Promise.reject(new CaptureFailure("window-unavailable", why));
    const deadlineMs = this.options.deadlineMs ?? 10_000;
    const state = window.state();
    let done = false;
    let restore = () => {};
    if (state === "hidden") {
      const opacity = window.getOpacity();
      window.setOpacity(0);
      window.showInactive();
      restore = () => {
        restore = () => {};
        window.hide();
        window.setOpacity(opacity);
      };
    }
    return new Promise<WindowCapture>((resolve, reject) => {
      const finish = (error: CaptureFailure | null, capture?: WindowCapture) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        restore();
        if (error) reject(error);
        else resolve(capture!);
      };
      const timer = setTimeout(() => finish(new CaptureFailure("screenshot-timeout", `The app window was not captured within ${deadlineMs / 1000} seconds.`)), deadlineMs);
      this.take(view, state, () => done).then(
        (capture) => finish(null, capture),
        (e) => finish(e instanceof CaptureFailure ? e : new CaptureFailure("window-unavailable", `The app window could not be captured: ${(e as Error)?.message ?? e}`)),
      );
    });
  }

  /** Switches, waits for the drawing and captures; stops early once the capture has `ended` (deadline). */
  private async take(view: ScreenshotView, state: WindowState, ended: () => boolean): Promise<WindowCapture> {
    const { window } = this;
    const page = await window.prepare(view);
    // Past the deadline the window is already as it was; a hidden one would not capture anyway.
    if (ended()) throw new CaptureFailure("screenshot-timeout", "The app window answered after the deadline.");
    if ("busy" in page) throw new CaptureFailure("window-busy", `The app window has a dialog open ("${page.busy}"). Close it and try again.`);
    if ("unavailable" in page) throw new CaptureFailure("window-unavailable", page.unavailable);
    let image = await window.capture();
    while (!image.length && !ended()) {
      await new Promise((r) => setTimeout(r, this.options.retryMs ?? 50));
      if (!ended()) image = await window.capture();
    }
    const { width, height } = pngSize(image);
    return { view, window: state, width, height, scale: window.scale(), live: page.live, capturedAt: (this.options.now ?? Date.now)(), png: Buffer.from(image).toString("base64") };
  }
}

/** A PNG's size from its IHDR chunk (bytes 16–23). */
function pngSize(png: Uint8Array) {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
