// Main's screenshot of the app window (seam 4), behind a port with a fake window: it is switched and captured whether
// visible, minimised or hidden in the tray, never shown or focused, and left as it was; refusals, deadline, one at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowCapturer, type CaptureTarget, type PageReady } from "../src/main/shell/window-capture.js";
import type { WindowState } from "../src/shared/server-host-protocol.js";

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
  shown: boolean;
  why: string | null = null;
  ready: () => Promise<PageReady> = async () => ({ ready: true, live: "live" });
  images: Uint8Array[] = [];

  constructor(private readonly initial: WindowState) {
    this.shown = initial !== "hidden";
  }
  unavailable() {
    return this.why;
  }
  state(): WindowState {
    return this.shown ? this.initial === "minimised" ? "minimised" : "visible" : "hidden";
  }
  getOpacity() {
    return this.opacity;
  }
  setOpacity(value: number) {
    this.calls.push(`opacity ${value}`);
    this.opacity = value;
  }
  showInactive() {
    this.calls.push("showInactive");
    this.shown = true;
  }
  hide() {
    this.calls.push("hide");
    this.shown = false;
  }
  scale() {
    return 1.5;
  }
  prepare(view: string) {
    this.calls.push(`prepare ${view}`);
    return this.ready();
  }
  async capture() {
    this.calls.push(this.shown ? `capture at opacity ${this.opacity}` : "capture while hidden");
    return this.images.shift() ?? png(1800, 1200);
  }
}

const capturer = (window: FakeWindow, deadlineMs = 1000) => new WindowCapturer(window, { now: () => NOW, deadlineMs, retryMs: 5 });

test("a visible window is switched to Feeds and captured as it is, with its size from the image", async () => {
  const window = new FakeWindow("visible");
  const capture = await capturer(window).capture("feeds");
  assert.deepEqual(window.calls, ["prepare feeds", "capture at opacity 1"]);
  assert.deepEqual(capture, { view: "feeds", window: "visible", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: NOW, png: Buffer.from(png(1800, 1200)).toString("base64") });
});

test("a minimised window is captured minimised, never shown or restored", async () => {
  const window = new FakeWindow("minimised");
  const capture = await capturer(window).capture("feeds");
  assert.deepEqual(window.calls, ["prepare feeds", "capture at opacity 1"]);
  assert.equal(capture.window, "minimised");
});

test("a window hidden in the tray is shown transparent without focus, captured, hidden again and its opacity restored", async () => {
  const window = new FakeWindow("hidden");
  window.opacity = 0.9;
  const capture = await capturer(window).capture("feeds");
  assert.deepEqual(window.calls, ["opacity 0", "showInactive", "prepare feeds", "capture at opacity 0", "hide", "opacity 0.9"]);
  assert.equal(capture.window, "hidden");
  assert.equal(window.state(), "hidden");
});

test("an empty image (the window not drawn yet) is captured again", async () => {
  const window = new FakeWindow("hidden");
  window.images = [new Uint8Array(), new Uint8Array(), png(10, 20)];
  const capture = await capturer(window).capture("feeds");
  assert.deepEqual([capture.width, capture.height], [10, 20]);
  assert.equal(window.calls.filter((c) => c.startsWith("capture")).length, 3);
});

test("an open dialog refuses with window-busy naming it; nothing is taken and a hidden window is hidden again", async () => {
  const window = new FakeWindow("hidden");
  window.ready = async () => ({ busy: "Close position 12345" });
  await assert.rejects(capturer(window).capture("feeds"), (e: { code: string; message: string }) => {
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
  await assert.rejects(capturer(gone).capture("feeds"), { code: "window-unavailable", message: "The app window is being recreated after a crash." });
  assert.deepEqual(gone.calls, []);

  const loading = new FakeWindow("visible");
  loading.ready = async () => ({ unavailable: "The app window is still loading." });
  await assert.rejects(capturer(loading).capture("feeds"), { code: "window-unavailable", message: "The app window is still loading." });
});

test("a page that never says it has drawn times out with screenshot-timeout, and the hidden window is hidden again at once", async () => {
  const window = new FakeWindow("hidden");
  let drawn!: (ready: PageReady) => void;
  window.ready = () => new Promise((resolve) => (drawn = resolve));
  await assert.rejects(capturer(window, 50).capture("feeds"), { code: "screenshot-timeout" });
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
  const captures = await Promise.all([shared.capture("feeds"), shared.capture("feeds"), shared.capture("feeds")]);
  assert.equal(most, 1);
  assert.deepEqual(captures.map((c) => c.live), ["reconnecting", "reconnecting", "reconnecting"]);
});
