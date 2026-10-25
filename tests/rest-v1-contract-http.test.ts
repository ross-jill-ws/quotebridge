// The REST v1 contract as a whole over HTTP (approved seam): every route's authentication and scope, the structured
// error shape, retired legacy routes, and no administration through the public API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountId, marketId } from "../src/server/identity/index.js";
import { LOGIN } from "./account-fixtures.js";
import { DEMO, startRest, tempFolder, TERMINAL, type Json } from "./rest-fixtures.js";

const MARKET = marketId(DEMO, "EURUSD");
const ACCOUNT = accountId(DEMO, LOGIN);
const REQUEST = "c".repeat(32);

/** Every read route, with its path parameters filled in. */
const READS = [
  "/api/v1/markets",
  `/api/v1/markets/${MARKET}`,
  `/api/v1/markets/${MARKET}/quote`,
  `/api/v1/markets/${MARKET}/candles?timeframe=H1`,
  `/api/v1/markets/${MARKET}/samples`,
  `/api/v1/markets/${MARKET}/indicators/quotebridge.ma?timeframe=H1`,
  `/api/v1/markets/${MARKET}/history`,
  `/api/v1/markets/${MARKET}/export?timeframe=H1&format=csv`,
  "/api/v1/accounts",
  `/api/v1/accounts/${ACCOUNT}`,
  `/api/v1/accounts/${ACCOUNT}/funds`,
  `/api/v1/accounts/${ACCOUNT}/positions`,
  `/api/v1/accounts/${ACCOUNT}/positions/1`,
  `/api/v1/accounts/${ACCOUNT}/orders`,
  `/api/v1/accounts/${ACCOUNT}/orders/1`,
  `/api/v1/accounts/${ACCOUNT}/markets/${MARKET}/conditions`,
  "/api/v1/indicators",
  "/api/v1/indicators/quotebridge.ma",
  "/api/v1/terminals",
  `/api/v1/terminals/${TERMINAL}`,
  `/api/v1/terminals/${TERMINAL}/feeds`,
  `/api/v1/terminals/${TERMINAL}/feeds/x`,
  "/api/v1/requests",
  `/api/v1/requests/${REQUEST}`,
];
const MUTATIONS = ["/api/v1/requests/preview", `/api/v1/requests/${REQUEST}/execute`, `/api/v1/requests/${REQUEST}/review`];

/** A structured error: `{ error: { code, message, details } }` and nothing else. */
function assertError(body: Json, code?: string) {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "details", "message"]);
  assert.match(body.error.code, /^[a-z]+(-[a-z]+)*$/);
  assert.equal(typeof body.error.message, "string");
  if (code) assert.equal(body.error.code, code);
}

test("every route needs a key; readonly reads every route and changes none; errors are structured", { timeout: 30000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"), { trading: true });
  for (const path of [...READS, ...MUTATIONS]) {
    const anonymous = await fetch(`${app.origin}${path}`, { method: MUTATIONS.includes(path) ? "POST" : "GET" });
    assert.equal(anonymous.status, 401, path);
    assertError((await anonymous.json()) as Json, "unauthenticated");
  }
  for (const path of READS) {
    for (const key of [app.readonlyKey, app.traderKey]) {
      const res = await fetch(`${app.origin}${path}`, { headers: { authorization: `Bearer ${key}` } });
      assert.ok(![401, 403, 405, 500].includes(res.status), `${path}: ${res.status}`);
      if (!res.ok) assertError((await res.json()) as Json);
    }
  }
  for (const path of MUTATIONS) {
    const res = await app.cli(path, {}, { method: "POST", body: "{}" });
    assert.equal(res.status, 403, path);
    assertError((await res.json()) as Json, "insufficient-scope");
  }
  const head = await app.cli("/api/v1/markets", {}, { method: "HEAD" });
  assert.equal(head.status, 200, "HEAD is a read");
});

test("info is public and enveloped; methods and unknown routes answer structured 405 and 404", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  assert.deepEqual(await (await fetch(`${app.origin}/api/v1/info`)).json(), { data: { service: "mt4-quote-bridge", apiVersion: 1 }, meta: {} });
  const post = await app.cli("/api/v1/markets", {}, { method: "POST", key: app.traderKey, body: "{}" });
  assert.equal(post.status, 405);
  assertError((await post.json()) as Json, "method-not-allowed");
  const get = await app.cli("/api/v1/requests/preview", {}, { key: app.traderKey });
  assert.equal(get.status, 405, "preview is a POST");
  assertError((await get.json()) as Json, "method-not-allowed");
});

test("the legacy routes and selectors are retired, with no adapters", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  await app.connect();
  for (const path of [
    "/api/v1/symbols",
    "/api/v1/symbols/EURUSD/quote",
    "/api/v1/symbols/EURUSD/candles",
    "/api/v1/symbols/EURUSD/samples",
    "/api/v1/symbols/EURUSD/info",
    "/api/v1/history",
    "/api/v1/history/EURUSD",
    "/api/v1/history/files",
    "/api/v1/history/files/csv",
    "/api/v1/indicators/macd/EURUSD",
    "/api/v1/positions",
    "/api/v1/budget",
    "/api/v1/orders",
    "/api/v1/orders/preview",
  ]) {
    const res = await app.cli(path);
    assert.equal(res.status, 404, path);
    assertError((await res.json()) as Json, "unknown-route");
  }
  // Readable symbols, broker substrings, terminal and feed overrides select nothing.
  for (const parameter of ["symbol", "broker", "terminal", "feed", "source"]) {
    const res = await app.read(`/api/v1/markets/${MARKET}/quote`, { [parameter]: "EURUSD" }, 400);
    assert.equal(res.error.code, "unknown-parameter", parameter);
  }
});

test("administration stays out of the public API: trader keys reach no settings, keys, terminals setup or recordings", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  for (const path of ["/api/v1/settings", "/api/v1/api-keys", "/api/v1/terminals/install", `/api/v1/terminals/${TERMINAL}/install`, "/api/v1/clock-rules", "/api/v1/recordings/delete", "/api/v1/markets/recording"]) {
    const res = await app.cli(path, {}, { method: "POST", key: app.traderKey, body: "{}" });
    assert.ok([404, 405].includes(res.status), `${path}: ${res.status}`);
  }
  for (const path of ["/api/settings", "/api/api-keys", "/api/clock-rules", "/api/recordings/delete", "/api/markets/recording"]) {
    assert.equal((await app.cli(path, {}, { method: "POST", key: app.traderKey, body: "{}" })).status, 403, path);
  }
  const settings = await app.windowGet("/api/settings");
  assert.equal(settings.trading.enabled, false, "trading stays off: only the app window turns it on");
});
