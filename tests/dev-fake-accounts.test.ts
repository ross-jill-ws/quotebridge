// The dev run's simulated trading account (scripts/dev/fake-accounts.ts) through the real server: it announces itself,
// answers Funds, conditions and executions, so the Trading page and the CLI can be tried without MetaTrader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeAccount } from "../scripts/dev/fake-accounts.js";
import { marketId } from "../src/server/identity/index.js";
import { deliver } from "./account-fixtures.js";
import type { FakeEA } from "./fake-ea.js";
import { DEMO, HOUR, startRest, tempFolder, type Json } from "./rest-fixtures.js";

test("a simulated account previews, executes and shows the trade it placed", { timeout: 30000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "fake-account"), { trading: true });
  const brokerNow = () => Math.floor(app.clock.now() / 1000) + 2 * HOUR;
  const account = new FakeAccount(
    { login: "50012345", currency: "USD", demo: true, enabled: true, ready: true, maxLots: "0.5", balance: 10000, leverage: 100,
      trades: [{ kind: 0, symbol: "EURUSD", lots: 0.2, openPrice: 1.0815, stopLoss: 1.0765, takeProfit: 0, expiration: 0, magic: 0 }] },
    (symbol) => (symbol === "EURUSD" ? { bid: 1.1, ask: 1.10012, digits: 5 } : undefined), brokerNow, 81_000_000);
  let chart: FakeEA | undefined;
  chart = await app.connect({ bars: () => "loading", commands: (message) => account.handle(chart!, message) });
  await deliver(app.server.bridge, chart, account.announceWire(chart));

  const [listed] = (await app.read("/api/v1/accounts")).data as Json[];
  assert.deepEqual([listed.login, listed.demo, listed.executor.state, listed.sources[0].maxLots], ["50012345", true, "ready", "0.5"]);
  const funds = (await app.read(`/api/v1/accounts/${listed.id}/funds`)).data;
  assert.deepEqual([funds.currency, funds.balance, funds.state, funds.leverage], ["USD", "10000", "fresh", 100]);
  const [outside] = (await app.read(`/api/v1/accounts/${listed.id}/positions`)).data as Json[];
  assert.deepEqual([outside.symbol, outside.side, outside.lots, outside.magic], ["EURUSD", "buy", "0.2", 0]);

  const place = { accountId: listed.id, action: "place", marketId: marketId(DEMO, "EURUSD"), side: "sell", type: "market", lots: "0.10" };
  const preview = (await app.send("/api/v1/requests/preview", place, 201)).data;
  assert.equal(preview.normalizedIntent.price, "1.1");
  await app.send(`/api/v1/requests/${preview.requestId}/execute`, { confirm: true }, 202);
  let record: Json = {};
  for (let i = 0; i < 100 && record.status !== "succeeded"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    record = (await app.read(`/api/v1/requests/${preview.requestId}`)).data;
  }
  assert.equal(record.status, "succeeded");
  const positions = (await app.read(`/api/v1/accounts/${listed.id}/positions`)).data as Json[];
  const placed = positions.find((p) => p.ticket === record.result.ticket);
  assert.deepEqual([placed?.side, placed?.lots, placed?.magic], ["sell", "0.1", 27012026]);

  // The seeded trade counts as placed outside QuoteBridge.
  const close = (await app.send("/api/v1/requests/preview", { accountId: listed.id, action: "close", ticket: outside.ticket }, 201)).data;
  assert.ok(close.warnings.includes("This trade was created outside QuoteBridge."));
});
