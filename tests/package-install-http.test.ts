// Installing and deleting indicator packages over HTTP, from the app window only (ADR 5, ADR 12): a ZIP is checked
// (its files, the manifest, a trial run) and previewed before anything is installed; a newer version replaces the old
// one, an older one needs a second confirmation; the same version with other content, or a bundled package's id, is
// refused; an installed package can be deleted (charts using it read Not available) and installed again. Installed
// packages are kept in the database. Real server, a fake EA, an HST file, and test-only ZIPs.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { openDatabase, startServer } from "../src/server/index.js";
import { brokerToUtc, type ClockRule } from "../src/shared/clock.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst } from "./hst-fixtures.js";
import { packageZip, scaledPackage, zip } from "./package-zip.js";

const TOKEN = "window-token-0123456789";
const REMOTE_TOKEN = "remote-token-0123456789";
const HOUR = 3600;
const BROKER = "EasyForex-Demo";
const TERMINAL = "mt4-aaaaaaaaaaaa";
const NOW = Date.UTC(2027, 0, 15, 8);
const TEN = Date.UTC(2027, 0, 15, 10) / 1000;
const RULE: ClockRule = { winterOffsetMinutes: 120, dst: "us" };
const utc = (broker: number) => brokerToUtc(RULE, broker * 1000) / 1000;
const HST = bars(TEN - 300 * HOUR, HOUR, 300);

type Manifest = { id: string; version: string; name: string; parameters: { id: string }[] };
type PackageRow = { manifest: Manifest; bundled: boolean; enabled: boolean; hash: string };
type PackageList = { manage: boolean; packages: PackageRow[] };
type Preview = { manifest: Manifest; readme: string; licence: string; hash: string; replaces: { manifest: Manifest; hash: string } | null; downgrade: boolean };

async function tempFolder(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-install-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** A server over the database in `folder`; `stop` closes both (also when the test ends). */
async function start(t: TestContext, folder: string) {
  await writeHst(folder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: HST });
  const database = await openDatabase(folder);
  const eaPort = await freePort();
  const server = await startServer({
    eaPort,
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: new FakeClock(NOW).now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => (terminalId === TERMINAL ? folder : undefined),
    database,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await database.checkpointAndClose();
  };
  t.after(stop);
  const origin = server.httpOrigin;
  server.addRemoteToken(REMOTE_TOKEN);
  const signIn = async (token: string) => (await fetch(`${origin}/session?token=${token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
  const cookie = await signIn(TOKEN);
  const rule = await fetch(`${origin}/api/clock-rules`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ brokerServer: BROKER, ...RULE }) });
  assert.equal(rule.status, 200);
  const chart = new FakeEA({ terminal: TERMINAL, broker: BROKER, symbol: "EURUSD" }).connect(`tcp://127.0.0.1:${eaPort}`);
  t.after(() => chart.close());
  await chart.request(chart.helloWire());
  await chart.request(chart.tickWire([{ seq: 1, bid: 1.2, ask: 1.2002, quoteTime: TEN + 60, sampledTime: TEN + 60 }]));

  /** Sends a ZIP to preview or install as `as`'s session; the status and answer. */
  const send = async (path: string, body: Buffer, as = cookie) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { cookie: as, origin, "content-type": "application/zip" }, body: new Uint8Array(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string } };
  };
  const preview = async (body: Buffer) => {
    const res = await send("/api/indicators/packages/preview", body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as unknown as Preview;
  };
  const install = (body: Buffer, query = "", as = cookie) => send(`/api/indicators/packages/install${query}`, body, as);
  const remove = async (id: string, as = cookie) => {
    const res = await fetch(`${origin}/api/indicators/packages/delete`, { method: "POST", headers: { cookie: as, origin, "content-type": "application/json" }, body: JSON.stringify({ id }) });
    return { status: res.status, body: (await res.json()) as PackageList & { error?: string } };
  };
  const list = async () => {
    const res = await fetch(`${origin}/api/indicators/packages`, { headers: { cookie } });
    assert.equal(res.status, 200);
    return (await res.json()) as PackageList;
  };
  const values = (query: Record<string, string | number>) =>
    fetch(`${origin}/api/indicators/values?${new URLSearchParams({ feed: JSON.stringify([TERMINAL, "EURUSD"]), period: "H1", ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })}`, {
      headers: { cookie },
    });
  return { origin, cookie, signIn, send, preview, install, remove, list, values, stop };
}

const installed = (list: PackageList) => list.packages.filter((p) => !p.bundled).map((p) => [p.manifest.id, p.manifest.version, p.enabled]);

test("a package ZIP is previewed (manifest, README, licence) before anything is installed; Install puts it on the chart", { timeout: 30000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const body = packageZip(scaledPackage());

  const preview = await app.preview(body);
  assert.equal(preview.manifest.id, "acme.scaled");
  assert.equal(preview.manifest.version, "1.0.0");
  assert.match(preview.readme, /^# Scaled close/);
  assert.match(preview.licence, /Acme/);
  assert.match(preview.hash, /^[0-9a-f]{64}$/);
  assert.equal(preview.replaces, null);
  assert.equal(preview.downgrade, false);
  assert.deepEqual(installed(await app.list()), [], "a preview installs nothing");
  assert.equal((await app.values({ package: "acme.scaled", limit: 5 })).status, 404);

  const done = await app.install(body);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(installed(done.body as unknown as PackageList), [["acme.scaled", "1.0.0", true]]);
  const res = await app.values({ package: "acme.scaled", "p.factor": 3, limit: 5 });
  assert.equal(res.status, 200);
  const { outputs } = (await res.json()) as { outputs: { scaled: { time: number; value: number }[] } };
  const closes = HST.slice(-4).map((b) => b.close);
  assert.deepEqual(
    outputs.scaled.slice(0, 4).map((p) => [p.time, Number(p.value.toFixed(10))]),
    HST.slice(-4).map((b, i) => [utc(b.time), Number((closes[i] * 3).toFixed(10))]),
  );
  // The forming bar, from the live quote.
  assert.equal(Number(outputs.scaled[4].value.toFixed(10)), 3.6);
});

test("a ZIP that is not a working package is refused with the reason, and nothing is installed", { timeout: 30000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const files = scaledPackage();
  const manifest = JSON.parse(files["manifest.json"]);
  const { "README.md": _, ...noReadme } = files;
  const refusals: [string, Buffer, number, RegExp][] = [
    ["not a ZIP", Buffer.from("hello"), 422, /not a ZIP/],
    ["a bad manifest", packageZip({ ...files, "manifest.json": JSON.stringify({ ...manifest, apiVersion: 2 }) }), 422, /^manifest\.json: Only apiVersion 1/],
    ["a manifest that is not JSON", packageZip({ ...files, "manifest.json": "{" }), 422, /not valid JSON/],
    ["an extra file", packageZip(files, [{ name: "notes.txt", text: "hi" }]), 422, /notes\.txt.*only manifest\.json, calculate\.js, README\.md and LICENSE/],
    ["a folder in the ZIP", zip(Object.entries(files).map(([name, text]) => ({ name: `scaled/${name}`, text }))), 422, /scaled\/manifest\.json/],
    ["a missing file", packageZip(noReadme), 422, /lacks README\.md/],
    ["a file too big", packageZip({ ...files, "README.md": "x".repeat(256_001) }), 422, /README\.md is larger than 256 KB/],
    ["a file bigger than its header says", zip(Object.entries(files).map(([name, text]) => (name === "README.md" ? { name, text: "x".repeat(300_000), claimedSize: 10 } : { name, text }))), 422, /README.md is damaged, or larger than 256 KB/],
    ["a damaged file", zip(Object.entries(files).map(([name, text]) => ({ name, text, badCrc: name === "LICENSE" }))), 422, /^LICENSE is damaged.$/],
    ["a ZIP too big", packageZip(files, [{ name: "LICENSE.big", text: Buffer.alloc(2 * 1024 * 1024), store: true }]), 413, /larger than 2 MiB/],
    ["a link", zip([...Object.entries(noReadme).map(([name, text]) => ({ name, text })), { name: "README.md", text: "/etc/passwd", symlink: true }]), 422, /README\.md is a link/],
    ["encryption", zip(Object.entries(files).map(([name, text]) => ({ name, text, encrypted: name === "calculate.js" }))), 422, /encrypted/],
    ["a calculation that throws", packageZip({ ...files, "calculate.js": "exports.calculate = function () { throw new Error('nope'); };" }), 422, /^The trial run failed\. The calculation threw: nope/],
    ["a calculation that never ends", packageZip({ ...files, "calculate.js": "exports.calculate = function () { for (;;) {} };" }), 422, /^The trial run failed\. The calculation took longer than 500 ms/],
    ["output the manifest does not list", packageZip({ ...files, "calculate.js": "exports.calculate = function () { return { outputs: { other: [] } }; };" }), 422, /^The trial run failed\. Invalid output/],
    ["a bundled package's id", packageZip({ ...files, "manifest.json": JSON.stringify({ ...manifest, id: "quotebridge.ma" }) }), 409, /quotebridge\.ma is a bundled package's id/],
  ];
  for (const [what, body, status, error] of refusals) {
    for (const path of ["/api/indicators/packages/preview", "/api/indicators/packages/install"]) {
      const res = await app.send(path, body);
      assert.equal(res.status, status, `${what} at ${path}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error ?? "", error, what);
    }
  }
  assert.deepEqual(installed(await app.list()), []);
  assert.equal(await app.list().then((l) => l.packages.find((p) => p.manifest.id === "quotebridge.ma")!.bundled), true, "the bundled package is untouched");
});

test("a newer version replaces the installed one, its preview naming what it replaces; an older one needs a second confirmation", { timeout: 30000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const v1 = packageZip(scaledPackage("1.0.0"));
  assert.equal((await app.install(v1)).status, 200);
  const before = (await app.list()).packages.find((p) => p.manifest.id === "acme.scaled")!;
  // Installing the same files again changes nothing.
  assert.equal((await app.install(v1)).status, 200);

  const v2 = packageZip(scaledPackage("2.0.0", { offset: true }));
  const preview = await app.preview(v2);
  assert.equal(preview.manifest.version, "2.0.0");
  assert.equal(preview.replaces?.manifest.version, "1.0.0");
  assert.equal(preview.replaces?.hash, before.hash);
  assert.deepEqual(preview.manifest.parameters.map((p) => p.id), ["factor", "offset"]);
  assert.equal(preview.downgrade, false);
  const upgraded = await app.install(v2);
  assert.equal(upgraded.status, 200);
  assert.deepEqual(installed(upgraded.body as unknown as PackageList), [["acme.scaled", "2.0.0", true]], "one version per id");
  const res = await app.values({ package: "acme.scaled", "p.factor": 1, "p.offset": 10, limit: 2 });
  assert.equal(res.status, 200);
  const answer = (await res.json()) as { version: string; outputs: { scaled: { value: number }[] } };
  assert.equal(answer.version, "2.0.0");
  assert.equal(Number(answer.outputs.scaled[1].value.toFixed(10)), 11.2, "the new version computes the values");

  // The same version with other content.
  const changed = await app.send("/api/indicators/packages/preview", packageZip(scaledPackage("2.0.0", { offset: true, licence: "MIT, changed" })));
  assert.equal(changed.status, 409);
  assert.match(changed.body.error ?? "", /Scaled close 2\.0\.0 is installed with other content/);
  assert.equal((await app.install(packageZip(scaledPackage("2.0.0", { licence: "MIT, changed" })))).status, 409);

  // An older version: previewed as a downgrade, refused until confirmed.
  const older = await app.preview(v1);
  assert.equal(older.downgrade, true);
  assert.equal(older.replaces?.manifest.version, "2.0.0");
  const refused = await app.install(v1);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.downgrade, true);
  assert.match(refused.body.error ?? "", /Scaled close 2\.0\.0 is installed, newer than 1\.0\.0\. Confirm/);
  assert.deepEqual(installed(await app.list()), [["acme.scaled", "2.0.0", true]]);
  const confirmed = await app.install(v1, "?downgrade=1");
  assert.equal(confirmed.status, 200);
  assert.deepEqual(installed(confirmed.body as unknown as PackageList), [["acme.scaled", "1.0.0", true]]);
});

test("an upgrade keeps the package switched off when it was", { timeout: 30000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  assert.equal((await app.install(packageZip(scaledPackage("1.0.0")))).status, 200);
  const off = await fetch(`${app.origin}/api/indicators/packages/enabled`, { method: "POST", headers: { cookie: app.cookie, origin: app.origin, "content-type": "application/json" }, body: JSON.stringify({ id: "acme.scaled", enabled: false }) });
  assert.equal(off.status, 200);
  const upgraded = await app.install(packageZip(scaledPackage("1.1.0")));
  assert.deepEqual(installed(upgraded.body as unknown as PackageList), [["acme.scaled", "1.1.0", false]]);
});

test("an installed package can be deleted: charts read it as Not available until it is installed again; a bundled one can't be deleted", { timeout: 30000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const ws = new WebSocket(`${app.origin.replace("http", "ws")}/live`, { headers: { origin: app.origin, cookie: app.cookie } });
  t.after(() => ws.terminate());
  const messages: { type?: string }[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise((resolve) => ws.once("open", resolve));

  const body = packageZip(scaledPackage());
  assert.equal((await app.install(body)).status, 200);
  assert.equal((await app.values({ package: "acme.scaled", limit: 3 })).status, 200);
  messages.length = 0;

  const deleted = await app.remove("acme.scaled");
  assert.equal(deleted.status, 200);
  assert.deepEqual(installed(deleted.body), []);
  const gone = await app.values({ package: "acme.scaled", limit: 3 });
  assert.equal(gone.status, 404);
  assert.equal(((await gone.json()) as { notAvailable?: boolean }).notAvailable, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(messages.some((m) => m.type === "packages"), "windows hear that the packages changed");

  assert.equal((await app.install(body)).status, 200);
  assert.equal((await app.values({ package: "acme.scaled", limit: 3 })).status, 200, "installed again, it is back");

  const bundled = await app.remove("quotebridge.rsi");
  assert.equal(bundled.status, 409);
  assert.match(bundled.body.error ?? "", /RSI ships with the app and cannot be deleted\. Disable it instead\./);
  assert.equal((await app.remove("nobody.nothing")).status, 404);
  assert.equal((await app.list()).packages.filter((p) => p.bundled).length, 8);
});

test("a remote browser can't preview, install or delete packages: 403", { timeout: 30000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const remote = await app.signIn(REMOTE_TOKEN);
  const body = packageZip(scaledPackage());
  for (const path of ["/api/indicators/packages/preview", "/api/indicators/packages/install"]) {
    const res = await app.send(path, body, remote);
    assert.equal(res.status, 403, path);
    assert.match(res.body.error ?? "", /Only the app window can install/);
  }
  assert.equal((await app.install(body)).status, 200);
  assert.equal((await app.remove("acme.scaled", remote)).status, 403);
  assert.deepEqual(installed(await app.list()), [["acme.scaled", "1.0.0", true]]);
});

test("installed packages, and whether each is enabled, survive a restart", { timeout: 30000 }, async (t) => {
  const folder = await tempFolder(t);
  const first = await start(t, folder);
  assert.equal((await first.install(packageZip(scaledPackage("1.2.0")))).status, 200);
  assert.equal((await first.install(packageZip(anotherPackage()))).status, 200);
  const off = await fetch(`${first.origin}/api/indicators/packages/enabled`, { method: "POST", headers: { cookie: first.cookie, origin: first.origin, "content-type": "application/json" }, body: JSON.stringify({ id: "acme.another", enabled: false }) });
  assert.equal(off.status, 200);
  const hash = (await first.list()).packages.find((p) => p.manifest.id === "acme.scaled")!.hash;
  await first.stop();

  const again = await start(t, folder);
  const list = await again.list();
  assert.deepEqual(installed(list), [["acme.another", "1.0.0", false], ["acme.scaled", "1.2.0", true]], "installed ones after the bundled, by name");
  assert.equal(list.packages.find((p) => p.manifest.id === "acme.scaled")!.hash, hash, "the same files");
  assert.equal((await again.values({ package: "acme.scaled", limit: 3 })).status, 200);
  // Its version is still taken by these files.
  assert.equal((await again.send("/api/indicators/packages/preview", packageZip(scaledPackage("1.2.0", { licence: "other" })))).status, 409);
});

/** A second package, "Another", id acme.another. */
function anotherPackage() {
  const files = scaledPackage("1.0.0", { name: "Another" });
  return { ...files, "manifest.json": JSON.stringify({ ...JSON.parse(files["manifest.json"]), id: "acme.another" }) };
}
