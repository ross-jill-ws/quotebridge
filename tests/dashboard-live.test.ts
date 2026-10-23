// The dashboard's live client: snapshots from /live, reconnect with backoff, session end, stop; the indicator keys a
// window shows, and the server's notices that their values changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveClient, type LiveSocket, type LiveStatus } from "../src/dashboard/live-client.js";

/** A socket shaped like the browser WebSocket, driven by the test. */
class FakeSocket implements LiveSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  drop() {
    this.closed = true;
    this.onclose?.();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/** Timers moved by hand. */
class FakeTimers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; run: () => void }>();
  setTimeout = (run: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, run });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.pending.delete(id as number);
  };
  /** Delays of the timers still waiting, from now. */
  get waiting() {
    return [...this.pending.values()].map((t) => t.at - this.now);
  }
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.run();
      }
    }
  }
}

function setup(options: { sessionValid?: () => Promise<boolean>; onPackages?: () => void } = {}) {
  const sockets: FakeSocket[] = [];
  const snapshots: unknown[] = [];
  const changed: string[][] = [];
  const statuses: LiveStatus[] = [];
  const timers = new FakeTimers();
  const client = new LiveClient({
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onSnapshot: (s) => snapshots.push(s),
    onIndicators: (keys) => changed.push(keys),
    onPackages: options.onPackages,
    onStatus: (s) => statuses.push(s),
    sessionValid: options.sessionValid ?? (async () => true),
    timers,
  });
  return { client, sockets, snapshots, changed, statuses, timers, latest: () => sockets.at(-1)! };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the client connects, goes live on open and passes each snapshot on", () => {
  const { client, sockets, snapshots, statuses, latest } = setup();
  client.start();
  assert.equal(sockets.length, 1);
  assert.deepEqual(statuses, ["connecting"]);

  latest().open();
  latest().message({ time: 1, feeds: [] });
  latest().message({ time: 2, feeds: [] });

  assert.deepEqual(statuses, ["connecting", "live"]);
  assert.deepEqual(snapshots, [
    { time: 1, feeds: [] },
    { time: 2, feeds: [] },
  ]);
});

test("a lost connection is retried after 1 s, then 2, 4, 8 and at most 10 s between attempts", async () => {
  const { client, sockets, statuses, timers, latest } = setup();
  client.start();
  latest().open();
  latest().drop();
  await settle();
  assert.equal(statuses.at(-1), "reconnecting");

  const delays: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    delays.push(...timers.waiting);
    const before = sockets.length;
    timers.advance(timers.waiting[0]!);
    assert.equal(sockets.length, before + 1, "a new socket after the delay");
    latest().drop(); // the server is still down
    await settle();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000]);
});

test("after a successful reconnect the next loss starts again at 1 s", async () => {
  const { client, statuses, timers, latest } = setup();
  client.start();
  latest().drop();
  await settle();
  timers.advance(1000);
  latest().drop();
  await settle();
  timers.advance(2000);
  latest().open();
  assert.equal(statuses.at(-1), "live");

  latest().drop();
  await settle();
  assert.deepEqual(timers.waiting, [1000]);
});

test("when the window session no longer works the client stops retrying and says so", async () => {
  const { client, sockets, statuses, timers, latest } = setup({ sessionValid: async () => false });
  client.start();
  latest().open();
  latest().drop();
  await settle();

  assert.equal(statuses.at(-1), "session-ended");
  assert.deepEqual(timers.waiting, []);
  timers.advance(60_000);
  assert.equal(sockets.length, 1);
});

test("a server that cannot be reached at all is retried, not taken for an ended session", async () => {
  const { client, statuses, timers, latest } = setup({ sessionValid: async () => Promise.reject(Error("connection refused")) });
  client.start();
  latest().drop();
  await settle();
  assert.equal(statuses.at(-1), "reconnecting");
  assert.deepEqual(timers.waiting, [1000]);
});

test("stop closes the socket and cancels any retry", async () => {
  const live = setup();
  live.client.start();
  live.latest().open();
  live.client.stop();
  assert.equal(live.latest().closed, true);
  await settle();
  assert.deepEqual(live.timers.waiting, []);

  const retrying = setup();
  retrying.client.start();
  retrying.latest().drop();
  await settle();
  retrying.client.stop();
  retrying.timers.advance(60_000);
  assert.equal(retrying.sockets.length, 1);
});

test("a message that is not JSON is skipped; later snapshots still arrive", () => {
  const { client, snapshots, latest } = setup();
  client.start();
  latest().open();
  latest().message("not json");
  latest().message({ time: 3, feeds: [] });
  assert.deepEqual(snapshots, [{ time: 3, feeds: [] }]);
});

test("the window tells the server which indicator keys it shows, once connected and again after a reconnect", async () => {
  const { client, latest, timers } = setup();
  client.start();
  client.show(["a", "b"]);
  assert.deepEqual(latest().sent, [], "nothing is sent before the socket opens");
  latest().open();
  assert.deepEqual(latest().sent.map((m) => JSON.parse(m)), [{ type: "show", keys: ["a", "b"] }]);
  client.show(["b"]);
  assert.deepEqual(JSON.parse(latest().sent.at(-1)!), { type: "show", keys: ["b"] });

  latest().drop();
  await settle();
  timers.advance(1000);
  latest().open();
  assert.deepEqual(latest().sent.map((m) => JSON.parse(m)), [{ type: "show", keys: ["b"] }]);
});

test("the server's notice that indicator values changed is passed on apart from the snapshots", () => {
  const { client, latest, snapshots, changed } = setup();
  client.start();
  latest().open();
  latest().message({ type: "indicators", changed: ["a"] });
  latest().message({ time: 1, feeds: [] });
  assert.deepEqual(changed, [["a"]]);
  assert.deepEqual(snapshots, [{ time: 1, feeds: [] }]);
});

test("the window reports the packages its chart uses, once connected and again after a reconnect", async () => {
  const { client, latest, timers } = setup();
  client.start();
  client.reportCharts(["quotebridge.ma"]);
  latest().open();
  assert.deepEqual(latest().sent.map((m) => JSON.parse(m)), [{ type: "charts", packages: ["quotebridge.ma"] }]);
  client.reportCharts(["quotebridge.ma", "quotebridge.eo"]);
  assert.deepEqual(JSON.parse(latest().sent.at(-1)!), { type: "charts", packages: ["quotebridge.ma", "quotebridge.eo"] });

  latest().drop();
  await settle();
  timers.advance(1000);
  latest().open();
  assert.deepEqual(latest().sent.map((m) => JSON.parse(m)), [{ type: "charts", packages: ["quotebridge.ma", "quotebridge.eo"] }]);
});

test("the server's notice that the packages changed is passed on apart from the snapshots", () => {
  const packages: number[] = [];
  const { client, latest, snapshots } = setup({ onPackages: () => packages.push(1) });
  client.start();
  latest().open();
  latest().message({ type: "packages" });
  assert.deepEqual(packages, [1]);
  assert.deepEqual(snapshots, []);
});
