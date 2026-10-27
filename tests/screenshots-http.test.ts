// GET /api/v1/screenshots/feeds over real HTTP (seam 2): a real server and database, the main process's window
// capture replaced by a fake. Scope, the JSON and PNG answers, the refusals, one capture at a time and the deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScreenshotView, WindowCapture } from "../src/shared/server-host-protocol.js";
import { ScreenshotError } from "../src/server/screenshots/index.js";
import { startRest, tempFolder } from "./rest-fixtures.js";

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const CAPTURE: WindowCapture = { view: "feeds", window: "hidden", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: Date.UTC(2027, 0, 15, 8), png: PNG };

async function start(t: Parameters<typeof startRest>[0], captureWindow?: (view: ScreenshotView) => Promise<WindowCapture>, screenshotDeadlineMs?: number) {
  return startRest(t, await tempFolder(t, "screenshots-db"), { overrides: { captureWindow, screenshotDeadlineMs } });
}

test("a trader key gets the Feeds screenshot with the window's health fields and the base64 PNG", { timeout: 30000 }, async (t) => {
  const views: string[] = [];
  const app = await start(t, async (view) => (views.push(view), CAPTURE));
  const body = await app.read("/api/v1/screenshots/feeds", {}, 200, app.traderKey);
  assert.deepEqual(body, {
    data: { view: "feeds", window: "hidden", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: "2027-01-15T08:00:00.000Z", contentType: "image/png", png: PNG },
    meta: {},
  });
  assert.deepEqual(views, ["feeds"]);
});

test("?format=png answers the raw PNG with the health fields in X-QuoteBridge headers", { timeout: 30000 }, async (t) => {
  const app = await start(t, async () => CAPTURE);
  const res = await app.cli("/api/v1/screenshots/feeds", { format: "png" }, { key: app.traderKey });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG, "base64"));
  assert.equal(res.headers.get("x-quotebridge-view"), "feeds");
  assert.equal(res.headers.get("x-quotebridge-window"), "hidden");
  assert.equal(res.headers.get("x-quotebridge-width"), "1800");
  assert.equal(res.headers.get("x-quotebridge-height"), "1200");
  assert.equal(res.headers.get("x-quotebridge-scale"), "1.5");
  assert.equal(res.headers.get("x-quotebridge-live"), "live");
  assert.equal(res.headers.get("x-quotebridge-captured-at"), "2027-01-15T08:00:00.000Z");
});

test("a readonly key is refused with insufficient-scope and nothing is captured", { timeout: 30000 }, async (t) => {
  let captures = 0;
  const app = await start(t, async () => (captures++, CAPTURE));
  const body = await app.read("/api/v1/screenshots/feeds", {}, 403);
  assert.equal(body.error.code, "insufficient-scope");
  assert.equal(captures, 0);
});

test("an unknown format or parameter is refused before anything is captured", { timeout: 30000 }, async (t) => {
  let captures = 0;
  const app = await start(t, async () => (captures++, CAPTURE));
  assert.equal((await app.read("/api/v1/screenshots/feeds", { format: "jpeg" }, 400, app.traderKey)).error.code, "invalid-format");
  assert.equal((await app.read("/api/v1/screenshots/feeds", { view: "charts" }, 400, app.traderKey)).error.code, "unknown-parameter");
  assert.equal(captures, 0);
});

test("main's refusals answer window-busy 409 and window-unavailable 503 with its words", { timeout: 30000 }, async (t) => {
  let next: ScreenshotError = new ScreenshotError("window-busy", 'The app window has a dialog open ("Buy EURUSD"). Close it and try again.');
  const app = await start(t, async () => {
    throw next;
  });
  const busy = await app.read("/api/v1/screenshots/feeds", {}, 409, app.traderKey);
  assert.deepEqual(busy.error, { code: "window-busy", message: 'The app window has a dialog open ("Buy EURUSD"). Close it and try again.', details: null });
  next = new ScreenshotError("window-unavailable", "The app window is still starting.");
  const unavailable = await app.read("/api/v1/screenshots/feeds", {}, 503, app.traderKey);
  assert.equal(unavailable.error.code, "window-unavailable");
  assert.equal(unavailable.error.message, "The app window is still starting.");
});

test("a server without an app window (a dev run in a browser tab) answers window-unavailable", { timeout: 30000 }, async (t) => {
  const app = await start(t);
  const body = await app.read("/api/v1/screenshots/feeds", {}, 503, app.traderKey);
  assert.equal(body.error.code, "window-unavailable");
  assert.match(body.error.message, /no app window/i);
});

test("captures run one at a time, in order", { timeout: 30000 }, async (t) => {
  let running = 0;
  let most = 0;
  let n = 0;
  const app = await start(t, async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 50));
    running--;
    return { ...CAPTURE, capturedAt: CAPTURE.capturedAt + ++n };
  });
  const answers = await Promise.all([1, 2, 3].map(() => app.read("/api/v1/screenshots/feeds", {}, 200, app.traderKey)));
  assert.equal(most, 1);
  assert.deepEqual(answers.map((a) => a.data.capturedAt).sort(), ["2027-01-15T08:00:00.001Z", "2027-01-15T08:00:00.002Z", "2027-01-15T08:00:00.003Z"]);
});

test("a capture that misses the deadline answers screenshot-timeout 504, and the next one still runs", { timeout: 30000 }, async (t) => {
  let calls = 0;
  const app = await start(t, (async () => (++calls === 1 ? new Promise<never>(() => {}) : CAPTURE)), 200);
  const late = await app.read("/api/v1/screenshots/feeds", {}, 504, app.traderKey);
  assert.equal(late.error.code, "screenshot-timeout");
  assert.equal((await app.read("/api/v1/screenshots/feeds", {}, 200, app.traderKey)).data.view, "feeds");
});
