// The dashboard's live client: snapshots from /live, reconnect with backoff, session end, stop.
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

function setup(options: { sessionValid?: () => Promise<boolean> } = {}) {
  const sockets: FakeSocket[] = [];
  const snapshots: unknown[] = [];
  const statuses: LiveStatus[] = [];
  const timers = new FakeTimers();
  const client = new LiveClient({
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onSnapshot: (s) => snapshots.push(s),
    onStatus: (s) => statuses.push(s),
    sessionValid: options.sessionValid ?? (async () => true),
    timers,
  });
  return { client, sockets, snapshots, statuses, timers, latest: () => sockets.at(-1)! };
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
