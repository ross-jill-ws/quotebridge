// REST v1 terminal diagnostics over HTTP (approved seam): read-only terminals and their own feeds' health and quotes,
// never another terminal's quote and never execution routing. Real server, fake EAs, fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketId } from "../src/server/identity/index.js";
import { brokerIso, DEMO, HOUR, MIDNIGHT, NOW, OTHER_TERMINAL, startRest, tempFolder, TERMINAL, utcIso, type Json } from "./rest-fixtures.js";

test("terminals list each terminal with its broker server and EA; feeds are its own, with their health and quotes", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const a = await app.connect();
  const b = await app.connect({ terminal: OTHER_TERMINAL });
  await app.quote(a, [{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: MIDNIGHT + 10 * HOUR }]);
  await app.quote(b, [{ seq: 1, bid: 1.2, ask: 1.2002, quoteTime: MIDNIGHT + 10 * HOUR + 1 }]);

  const { data, meta } = await app.read("/api/v1/terminals");
  assert.deepEqual(meta, { count: 2, limit: 100, nextCursor: null });
  assert.deepEqual(data[0], { id: TERMINAL, name: TERMINAL, brokerServer: DEMO, eaVersion: data[0].eaVersion, connected: true, lastHelloAt: new Date(NOW).toISOString(), feeds: 1 });
  assert.deepEqual((await app.read(`/api/v1/terminals/${TERMINAL}`)).data, data[0]);

  const feeds = await app.read(`/api/v1/terminals/${TERMINAL}/feeds`);
  assert.deepEqual(feeds.data, [{
    id: a.feedKey(),
    terminalId: TERMINAL,
    marketId: marketId(DEMO, "EURUSD"),
    brokerServer: DEMO,
    symbol: "EURUSD",
    digits: 5,
    timeframe: feeds.data[0].timeframe,
    online: true,
    stale: false,
    instances: 1,
    quoteStatus: "ok",
    recording: false,
    bid: "1.10000",
    ask: "1.10020",
    time: utcIso(MIDNIGHT + 10 * HOUR),
    brokerTime: brokerIso(MIDNIGHT + 10 * HOUR),
    receivedAt: new Date(NOW).toISOString(),
  }], "terminal A's own quote, although B's is newer");
  assert.deepEqual((await app.read(`/api/v1/terminals/${TERMINAL}/feeds/${encodeURIComponent(a.feedKey())}`)).data, feeds.data[0]);
  assert.equal((await app.read(`/api/v1/terminals/${TERMINAL}/feeds/${encodeURIComponent(b.feedKey())}`, {}, 404)).error.code, "unknown-feed", "B's feed is not A's");
  assert.equal((await app.read("/api/v1/terminals/mt4-000000000000", {}, 404)).error.code, "unknown-terminal");
  for (const path of ["/api/v1/terminals", `/api/v1/terminals/${TERMINAL}/feeds`]) {
    assert.equal((await app.cli(path, {}, { method: "POST", key: app.traderKey, body: "{}" })).status, 405, `${path} is read-only`);
  }
  app.clock.advance(8000);
  const quiet = (await app.read(`/api/v1/terminals/${TERMINAL}`)).data as Json;
  assert.equal(quiet.connected, false);
});
