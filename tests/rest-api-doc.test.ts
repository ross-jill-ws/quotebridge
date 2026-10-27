// The REST API manual's fixtures (docs/rest-api.md), replayed over HTTP against one scenario (approved seam): each
// request block and the response block after it, in page order. A response's JSON must equal the server's, but for
// "<any>" (any value) and "<$name>" (any value, kept as {name} for later paths and bodies); a file response's headers
// and text must match exactly. Real server and database, a fake EA over real ZeroMQ, an HST fixture, a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountId, marketId } from "../src/server/identity/index.js";
import { conditionsWire, deliver, LOGIN, orderRow, pageWire } from "./account-fixtures.js";
import { bars, writeHst } from "./hst-fixtures.js";
import { DEMO, HOUR, MIDNIGHT, NOW, REAL, startRest, tempFolder, TERMINAL } from "./rest-fixtures.js";

const page = await readFile(new URL("../docs/rest-api.md", import.meta.url), "utf8");

type Exchange = { line: number; method: string; path: string; key: "readonly" | "trader" | "none"; body: string | null; status: number; headers: Record<string, string>; response: string };

/** Each request block (```http starting with a method) with the response block (```http starting HTTP/1.1) after it. */
function exchanges(): Exchange[] {
  const blocks = [...page.matchAll(/^```http\n([^]*?)^```$/gm)].map((m) => ({ text: m[1], line: page.slice(0, m.index).split("\n").length }));
  const out: Exchange[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const request = /^(GET|POST|HEAD) (\S+)\n/.exec(blocks[i].text);
    if (!request) continue;
    const response = blocks[i + 1];
    assert.ok(response && /^HTTP\/1\.1 \d{3}/.test(response.text), `line ${blocks[i].line}: a request block is followed by its response block`);
    const [requestHead, requestBody = null] = split(blocks[i].text);
    const auth = /^Authorization: Bearer <(readonly|trader) key>$/m.exec(requestHead);
    const [responseHead, responseBody = ""] = split(response.text);
    const headers = Object.fromEntries(responseHead.split("\n").slice(1).filter(Boolean).map((h) => [h.slice(0, h.indexOf(":")).toLowerCase(), h.slice(h.indexOf(":") + 1).trim()]));
    out.push({ line: blocks[i].line, method: request[1], path: request[2], key: auth ? (auth[1] as "readonly" | "trader") : "none", body: requestBody, status: Number(response.text.slice(9, 12)), headers, response: responseBody });
    i++;
  }
  return out;
}

/** A block's head (request or status line and headers) and its body after the first blank line. */
function split(text: string): [string, string?] {
  const at = text.indexOf("\n\n");
  return at < 0 ? [text.trimEnd()] : [text.slice(0, at), text.slice(at + 2)];
}

/** Whether `actual` matches `expected`, keeping "<$name>" captures in `vars`; the first mismatch's path otherwise. */
function match(expected: unknown, actual: unknown, vars: Record<string, string>, at = "$"): string | null {
  if (expected === "<any>") return null;
  if (typeof expected === "string" && /^<\$\w+>$/.test(expected)) {
    vars[expected.slice(2, -1)] = String(actual);
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${at}: expected ${expected.length} items, got ${JSON.stringify(actual)}`;
    for (let i = 0; i < expected.length; i++) {
      const miss = match(expected[i], actual[i], vars, `${at}[${i}]`);
      if (miss) return miss;
    }
    return null;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return `${at}: expected an object, got ${JSON.stringify(actual)}`;
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
    for (const key of keys) {
      if (!(key in expected)) return `${at}.${key}: not documented (${JSON.stringify((actual as Record<string, unknown>)[key])})`;
      if (!(key in actual)) return `${at}.${key}: documented but not answered`;
      const miss = match((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], vars, `${at}.${key}`);
      if (miss) return miss;
    }
    return null;
  }
  return expected === actual ? null : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

test("every request and response the REST API manual prints is what the server does", { timeout: 60000 }, async (t) => {
  const cases = exchanges();
  assert.ok(cases.length >= 20, "the manual prints its fixtures");
  const data = await tempFolder(t, "rest-doc-data");
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT + 7 * HOUR, HOUR, 3) });
  const app = await startRest(t, await tempFolder(t, "rest-doc-db"), { dataFolders: { [TERMINAL]: data }, trading: true, overrides: { captureWindow: async (view) => ({ view, window: "hidden", width: 1800, height: 1200, scale: 1.5, live: "live", capturedAt: NOW, png: "iVBORw0KGgo=" }) } });
  const ea = await app.connect();
  await app.connect({ terminal: "mt4-bbbbbbbbbbbb", broker: REAL });
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: true });
  await app.quote(ea, [{ seq: 1, bid: 1.1, ask: 1.10015, quoteTime: MIDNIGHT + 10 * HOUR }]);
  await app.announce(ea, { enabled: true });
  // The EA answers every account and contract read with one open position and one pending order.
  let answering = true;
  const now = Math.floor(NOW / 1000) + 2 * HOUR;
  const responder = (async () => {
    while (answering) {
      const wire = await ea.receive().catch(() => "");
      const f = wire.split("|");
      if (f[0] === "V") await deliver(app.server.bridge, ea, pageWire(ea, f[3], { capturedAt: now, rows: [orderRow(12345, 0), orderRow(12346, 2)], total: 2 }));
      if (f[0] === "P") await deliver(app.server.bridge, ea, conditionsWire(ea, f[3], f[6], LOGIN).replace("|0|1700000002|", `|1|${now}|`));
    }
  })();
  t.after(async () => {
    answering = false;
    await responder;
  });

  const vars: Record<string, string> = {
    market: marketId(DEMO, "EURUSD"),
    realMarket: marketId(REAL, "EURUSD"),
    account: accountId(DEMO, LOGIN),
    terminal: TERMINAL,
    feed: encodeURIComponent(ea.feedKey()),
  };
  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
  const keys = { readonly: app.readonlyKey, trader: app.traderKey, none: undefined };
  for (const c of cases) {
    const key = keys[c.key];
    const res = await fetch(`${app.origin}${fill(c.path)}`, {
      method: c.method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(c.body ? { "content-type": "application/json" } : {}) },
      body: c.body ? fill(c.body) : undefined,
    });
    const text = await res.text();
    const where = `docs/rest-api.md:${c.line} ${c.method} ${c.path}`;
    assert.equal(res.status, c.status, `${where}: ${text}`);
    for (const [name, value] of Object.entries(c.headers)) assert.equal(res.headers.get(name), value, `${where}: ${name}`);
    if ((c.headers["content-type"] ?? "application/json").startsWith("application/json")) {
      const miss = match(JSON.parse(fill(c.response)), JSON.parse(text), vars);
      assert.equal(miss, null, `${where}: ${miss}\n${JSON.stringify(JSON.parse(text), null, 2)}`);
    } else assert.equal(text, c.response, where);
  }
});
