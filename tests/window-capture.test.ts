// Main's screenshot of the app window (seam 4), behind a port with a fake window: it is switched and captured whether
// visible, minimised or hidden in the tray, never seen or focused, and left as it was; refusals, deadline, one at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowCapturer, type CaptureTarget, type PageReady } from "../src/main/shell/window-capture.js";
import type { ScreenshotTarget, WindowState } from "../src/shared/server-host-protocol.js";

/** The start of a PNG: signature and IHDR with this size, which is all the capturer reads. */
function png(width: number, height: number) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

const NOW = Date.UTC(2027, 0, 15, 8);

class FakeWindow implements CaptureTarget {
  calls: string[] = [];
  opacity = 1;
  throttling = true;
  shown: boolean;
  minimised: boolean;
  why: string | null = null;
  ready: () => Promise<PageReady> = async () => ({ ready: true, live: "live" });
  images: Uint8Array[] = [];

  constructor(private readonly initial: WindowState) {
    this.shown = initial !== "hidden";
    this.minimised = initial === "minimised";
  }
  unavailable() {
    return this.why;
  }
  state(): WindowState {
    return this.minimised ? "minimised" : this.shown ? "visible" : "hidden";
  }
  getOpacity() {
    return this.opacity;
  }
  setOpacity(value: number) {
    this.calls.push(`opacity ${value}`);
    this.opacity = value;
  }
  getBackgroundThrottling() {
    return this.throttling;
  }
  setBackgroundThrottling(allowed: boolean) {
    this.calls.push(`throttling ${allowed}`);
    this.throttling = allowed;
  }
  setSkipTaskbar(skip: boolean) {
    this.calls.push(`skip taskbar ${skip}`);
  }
  /** Shows a hidden window and restores a minimised one, as Windows does. */
  showInactive() {
    this.calls.push("showInactive");
    this.shown = true;
    this.minimised = false;
  }
  minimize() {
    this.calls.push("minimize");
    this.minimised = true;
  }
  hide() {
    this.calls.push("hide");
    this.shown = false;
  }
  scale() {
    return 1.5;
  }
  prepare(target: ScreenshotTarget) {
    this.calls.push(`prepare ${target.view}${target.view === "chart" ? ` ${target.feed}` : ""}`);
    return this.ready();
  }
  async capture() {
    this.calls.push(!this.shown ? "capture while hidden" : this.minimised ? "capture while minimised" : `capture at opacity ${this.opacity}`);
    return this.images.shift() ?? png(1800, 1200);
  }
}

const FEEDS: ScreenshotTarget = { view: "feeds" };

const capturer = (window: FakeWindow, deadlineMs = 1000) => new WindowCapturer(window, { now: () => NOW, deadlineMs, retryMs: 5, settleMs: 0 });

// Seen on the real app: a shown window that other windows covered was captured one view behind, because Chromium
// stops rendering a covered window as it does a hidden one, unless its background throttling is off.
test("a visible window is switched to Feeds and captured as it is, rendering even if covered, with its size from the image", async () => {
  const window = new FakeWindow("visible");
  const capture = await capturer(window).capture(FEEDS);
  assert.deepEqual(window.calls, ["throttling false", "prepare feeds", "capture at opacity 1", "throttling true"]);
  assert.deepEqual(capture, { view: "feeds", window: "visible", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: NOW, png: Buffer.from(png(1800, 1200)).toString("base64") });
});

test("a chart target asks the page for that feed's chart and is answered as the chart view", async () => {
  const window = new FakeWindow("visible");
  const capture = await capturer(window).capture({ view: "chart", feed: "feed-1" });
  assert.deepEqual(window.calls, ["throttling false", "prepare chart feed-1", "capture at opacity 1", "throttling true"]);
  assert.deepEqual([capture.view, capture.window], ["chart", "visible"]);
});

// A minimised window runs no animation frames, so the page would never paint the view (the chart's canvas least of all).
test("a minimised window is restored transparent without focus and rendering, captured, minimised again and put back", async () => {
  const window = new FakeWindow("minimised");
  const capture = await capturer(window).capture(FEEDS);
  assert.deepEqual(window.calls, ["opacity 0", "throttling false", "showInactive", "prepare feeds", "capture at opacity 0", "minimize", "opacity 1", "throttling true"]);
  assert.equal(capture.window, "minimised");
  assert.equal(window.state(), "minimised");
});

// Seen on the real app: shown for the capture, a window in the tray had a taskbar button for half a second each time.
test("a window hidden in the tray is shown transparent, off the taskbar, without focus and rendering, captured, hidden again and put back", async () => {
  const window = new FakeWindow("hidden");
  window.opacity = 0.9;
  const capture = await capturer(window).capture(FEEDS);
  assert.deepEqual(window.calls, ["opacity 0", "throttling false", "skip taskbar true", "showInactive", "prepare feeds", "capture at opacity 0", "hide", "skip taskbar false", "opacity 0.9", "throttling true"]);
  assert.equal(capture.window, "hidden");
  assert.equal(window.state(), "hidden");
});

// Seen on the real app: a Feeds capture straight after a chart, of a window in the tray, showed Charts still current in
// the sidebar in half the captures. The page's frames are in before Chromium has painted all of them.
test("the window is captured a settle time after the page says it has drawn, not at once", async () => {
  const window = new FakeWindow("hidden");
  let answered = 0;
  window.ready = async () => {
    answered = performance.now();
    return { ready: true, live: "live" };
  };
  let capturedAt = 0;
  const capture = window.capture.bind(window);
  window.capture = () => {
    capturedAt = performance.now();
    return capture();
  };
  await new WindowCapturer(window, { deadlineMs: 1000, settleMs: 40 }).capture(FEEDS);
  assert.ok(capturedAt - answered >= 35, `captured ${capturedAt - answered} ms after the page answered`);
});

test("a capture whose deadline passes while it settles takes no image, and the window is put back", async () => {
  const window = new FakeWindow("hidden");
  await assert.rejects(new WindowCapturer(window, { deadlineMs: 20, settleMs: 60 }).capture(FEEDS), { code: "screenshot-timeout" });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!window.calls.some((c) => c.startsWith("capture")));
  assert.equal(window.state(), "hidden");
});

test("an empty image (the window not drawn yet) is captured again", async () => {
  const window = new FakeWindow("hidden");
  window.images = [new Uint8Array(), new Uint8Array(), png(10, 20)];
  const capture = await capturer(window).capture(FEEDS);
  assert.deepEqual([capture.width, capture.height], [10, 20]);
  assert.equal(window.calls.filter((c) => c.startsWith("capture")).length, 3);
});

test("an open dialog refuses with window-busy naming it; nothing is taken and a hidden window is hidden again", async () => {
  const window = new FakeWindow("hidden");
  window.ready = async () => ({ busy: "Close position 12345" });
  await assert.rejects(capturer(window).capture(FEEDS), (e: { code: string; message: string }) => {
    assert.equal(e.code, "window-busy");
    assert.match(e.message, /"Close position 12345"/);
    return true;
  });
  assert.ok(!window.calls.some((c) => c.startsWith("capture")));
  assert.equal(window.state(), "hidden");
  assert.equal(window.opacity, 1);
});

test("no window, or a page that cannot answer yet, refuses with window-unavailable in its words", async () => {
  const gone = new FakeWindow("hidden");
  gone.why = "The app window is being recreated after a crash.";
  await assert.rejects(capturer(gone).capture(FEEDS), { code: "window-unavailable", message: "The app window is being recreated after a crash." });
  assert.deepEqual(gone.calls, []);

  const loading = new FakeWindow("visible");
  loading.ready = async () => ({ unavailable: "The app window is still loading." });
  await assert.rejects(capturer(loading).capture(FEEDS), { code: "window-unavailable", message: "The app window is still loading." });
});

test("a page that never says it has drawn times out with screenshot-timeout, and the hidden window is hidden again at once", async () => {
  const window = new FakeWindow("hidden");
  let drawn!: (ready: PageReady) => void;
  window.ready = () => new Promise((resolve) => (drawn = resolve));
  await assert.rejects(capturer(window, 50).capture(FEEDS), { code: "screenshot-timeout" });
  assert.equal(window.state(), "hidden");
  assert.equal(window.opacity, 1);
  drawn({ ready: true, live: "live" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!window.calls.some((c) => c.startsWith("capture")), "a late answer takes no image");
});

test("captures run one at a time", async () => {
  const window = new FakeWindow("visible");
  let open = 0;
  let most = 0;
  window.ready = async () => {
    most = Math.max(most, ++open);
    await new Promise((r) => setTimeout(r, 10));
    open--;
    return { ready: true, live: "reconnecting" };
  };
  const shared = capturer(window);
  const captures = await Promise.all([shared.capture(FEEDS), shared.capture(FEEDS), shared.capture(FEEDS)]);
  assert.equal(most, 1);
  assert.deepEqual(captures.map((c) => c.live), ["reconnecting", "reconnecting", "reconnecting"]);
});

test("a window that fails while being put back still settles the capture, and the next capture runs", async () => {
  const window = new FakeWindow("hidden");
  window.hide = () => {
    window.calls.push("hide");
    throw Error("Object has been destroyed");
  };
  const shared = capturer(window);
  const error = console.error;
  console.error = () => {};
  try {
    await shared.capture(FEEDS);
    assert.equal(window.opacity, 1, "its opacity is given back even so");
    assert.equal(window.throttling, true, "and its background throttling");
    window.ready = async () => ({ busy: "Buy EURUSD" });
    await assert.rejects(shared.capture(FEEDS), { code: "window-busy" });
  } finally {
    console.error = error;
  }
});

test("a window that cannot be shown is refused as window-unavailable and its taskbar button and opacity given back", async () => {
  const window = new FakeWindow("hidden");
  window.showInactive = () => {
    throw Error("Object has been destroyed");
  };
  await assert.rejects(capturer(window).capture(FEEDS), { code: "window-unavailable" });
  assert.equal(window.opacity, 1);
  assert.equal(window.throttling, true);
  assert.deepEqual(window.calls.filter((c) => c.startsWith("skip taskbar")), ["skip taskbar true", "skip taskbar false"], "back on the taskbar");
  assert.equal(window.state(), "hidden");
});
