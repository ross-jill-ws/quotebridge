// GET /api/v1/screenshots/feeds and /charts/{marketId} over real HTTP (seam 2): a real server and database, the main
// process's window capture replaced by a fake. Scope, the JSON and PNG answers, the chart's feed, the refusals, one
// capture at a time and the deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScreenshotTarget, WindowCapture } from "../src/shared/server-host-protocol.js";
import { ScreenshotError } from "../src/server/screenshots/index.js";
import { marketId } from "../src/server/identity/index.js";
import { bars, writeHst } from "./hst-fixtures.js";
import { DEMO, HOUR, MIDNIGHT, OTHER_TERMINAL, startRest, tempFolder, TERMINAL } from "./rest-fixtures.js";

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const CAPTURE: WindowCapture = { view: "feeds", window: "hidden", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: Date.UTC(2027, 0, 15, 8), png: PNG };

async function start(t: Parameters<typeof startRest>[0], captureWindow?: (target: ScreenshotTarget) => Promise<WindowCapture>, screenshotDeadlineMs?: number) {
  return startRest(t, await tempFolder(t, "screenshots-db"), { overrides: { captureWindow, screenshotDeadlineMs } });
}

test("a trader key gets the Feeds screenshot with the window's health fields and the base64 PNG", { timeout: 30000 }, async (t) => {
  const views: string[] = [];
  const app = await start(t, async (target) => (views.push(target.view), CAPTURE));
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

// GET /api/v1/screenshots/charts/{marketId}: the market's best source feed, switched to and captured.
const EURUSD = marketId(DEMO, "EURUSD");
const CHART: WindowCapture = { ...CAPTURE, view: "chart" };

test("a market's chart screenshot shows its best source feed and names the market", { timeout: 30000 }, async (t) => {
  const targets: ScreenshotTarget[] = [];
  const app = await start(t, async (target) => (targets.push(target), CHART));
  const a = await app.connect();
  const b = await app.connect({ terminal: OTHER_TERMINAL });
  await app.quote(a, [{ seq: 1, bid: 1.1, ask: 1.10015, quoteTime: MIDNIGHT + 10 * HOUR - 1 }]);
  await app.quote(b, [{ seq: 1, bid: 1.1001, ask: 1.1003, quoteTime: MIDNIGHT + 10 * HOUR }]);
  const body = await app.read(`/api/v1/screenshots/charts/${EURUSD}`, {}, 200, app.traderKey);
  assert.deepEqual(body, {
    data: { view: "chart", marketId: EURUSD, brokerServer: DEMO, symbol: "EURUSD", window: "hidden", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: "2027-01-15T08:00:00.000Z", contentType: "image/png", png: PNG },
    meta: {},
  });
  assert.deepEqual(targets, [{ view: "chart", feed: b.feedKey() }], "the newest broker quote's terminal, as for the market's quote");

  const res = await app.cli(`/api/v1/screenshots/charts/${EURUSD}`, { format: "png" }, { key: app.traderKey });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG, "base64"));
  assert.equal(res.headers.get("x-quotebridge-view"), "chart");
  assert.equal(res.headers.get("x-quotebridge-market-id"), EURUSD);
  assert.equal(res.headers.get("x-quotebridge-broker-server"), DEMO);
  assert.equal(res.headers.get("x-quotebridge-symbol"), "EURUSD");
});

test("a listed feed whose terminal has gone quiet is still captured, as the chart shows it", { timeout: 30000 }, async (t) => {
  const targets: ScreenshotTarget[] = [];
  const app = await start(t, async (target) => (targets.push(target), CHART));
  const ea = await app.connect();
  await app.quote(ea, [{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: MIDNIGHT + 10 * HOUR }]);
  app.clock.advance(60_000);
  assert.equal((await app.read(`/api/v1/markets/${EURUSD}/quote`)).data.state, "last-known");
  await app.read(`/api/v1/screenshots/charts/${EURUSD}`, {}, 200, app.traderKey);
  assert.deepEqual(targets, [{ view: "chart", feed: ea.feedKey() }]);
});

test("a market no terminal streams (known from HST alone) answers no-feed 409 and nothing is captured", { timeout: 30000 }, async (t) => {
  let captures = 0;
  const data = await tempFolder(t, "screenshots-hst");
  await writeHst(data, DEMO, { version: 401, symbol: "GBPUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT - 10 * HOUR, HOUR, 10) });
  const app = await startRest(t, await tempFolder(t, "screenshots-db"), { dataFolders: { [TERMINAL]: data }, overrides: { captureWindow: async () => (captures++, CHART) } });
  // The terminal's EURUSD chart makes its HST folder known; it streams no GBPUSD.
  await app.connect();
  const gbpusd = marketId(DEMO, "GBPUSD");
  assert.equal((await app.read(`/api/v1/markets/${gbpusd}`)).data.id, gbpusd, "a known market");
  const body = await app.read(`/api/v1/screenshots/charts/${gbpusd}`, {}, 409, app.traderKey);
  assert.equal(body.error.code, "no-feed");
  assert.match(body.error.message, /no terminal/i);
  assert.equal(captures, 0);
});

test("an unknown market answers 404 unknown-market, and a readonly key insufficient-scope, before anything is captured", { timeout: 30000 }, async (t) => {
  let captures = 0;
  const app = await start(t, async () => (captures++, CHART));
  await app.connect();
  assert.equal((await app.read(`/api/v1/screenshots/charts/${marketId(DEMO, "eurusd")}`, {}, 404, app.traderKey)).error.code, "unknown-market");
  assert.equal((await app.read(`/api/v1/screenshots/charts/${EURUSD}`, {}, 403)).error.code, "insufficient-scope");
  assert.equal((await app.read(`/api/v1/screenshots/charts/${EURUSD}`, { timeframe: "H1" }, 400, app.traderKey)).error.code, "unknown-parameter");
  assert.equal(captures, 0);
});
