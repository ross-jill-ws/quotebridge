// Screenshots of the app window for the REST API. Only main owns the window, so the server asks it over the host
// protocol (the `capture` port); here captures are taken one at a time, each within its deadline.
import type { CaptureError, CaptureErrorCode, ScreenshotView, WindowCapture } from "../../shared/server-host-protocol.js";

/** Asks main for a capture; rejects with a ScreenshotError when main refuses. */
export type CaptureWindow = (view: ScreenshotView) => Promise<WindowCapture>;

export const SCREENSHOT_DEADLINE_MS = 10_000;

export class ScreenshotError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
  }

  static from(error: CaptureError) {
    return new ScreenshotError(error.code, error.message);
  }
}

export class Screenshots {
  /** The capture before the next one; captures never overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Without `capture` there is no app window (a server run without the app, e.g. a dev run in a browser tab). */
  constructor(
    private readonly capture: CaptureWindow | undefined,
    private readonly deadlineMs = SCREENSHOT_DEADLINE_MS,
  ) {}

  /** The app window switched to `view` and captured, after any capture already asked for. */
  take(view: ScreenshotView): Promise<WindowCapture> {
    const turn = this.queue.then(() => this.once(view));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private once(view: ScreenshotView): Promise<WindowCapture> {
    const capture = this.capture;
    if (!capture) {
      return Promise.reject(new ScreenshotError("window-unavailable", "There is no app window to capture: this server runs without the app (a dev run in a browser tab)."));
    }
    return new Promise<WindowCapture>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ScreenshotError("screenshot-timeout", `The app window was not captured within ${this.deadlineMs / 1000} seconds.`)),
        this.deadlineMs,
      );
      capture(view).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}
