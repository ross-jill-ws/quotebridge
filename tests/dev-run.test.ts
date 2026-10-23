// `npm run dev`: which data folder and ports a dev run uses, the --real port check, and the restart debounce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { build } from "esbuild";
import { dashboardBuildOptions } from "../scripts/dashboard-build.js";
import { planDevRun } from "../scripts/dev/dev-plan.js";
import { realPortsRefusal } from "../scripts/dev/port-check.js";
import { startReloadServer } from "../scripts/dev/reload-server.js";
import { RestartScheduler } from "../scripts/dev/restart-scheduler.js";
import { ManualClock } from "./fake-server-process.js";
import { freePort } from "./free-port.js";

const PLACES = { appData: String.raw`C:\Users\me\AppData\Roaming`, temp: String.raw`C:\Users\me\AppData\Local\Temp` };

test("by default a dev run uses fake terminals, the dev ports and a scratch data folder", () => {
  const plan = planDevRun([], {}, PLACES);
  assert.equal(plan.real, false);
  assert.equal(plan.app, false);
  assert.equal(plan.dataFolder, String.raw`C:\Users\me\AppData\Local\Temp\quotebridge-dev`);
  assert.deepEqual(plan.ports, { ea: 6655, http: 6680 });
});

test("--app runs the same inside the Electron window", () => {
  const plan = planDevRun(["--app"], {}, PLACES);
  assert.equal(plan.app, true);
  assert.equal(plan.real, false);
  assert.equal(plan.dataFolder, String.raw`C:\Users\me\AppData\Local\Temp\quotebridge-dev`);
  assert.deepEqual(plan.ports, { ea: 6655, http: 6680 });
});

test("--real uses the ports from settings and its own data folder beside, never inside, the installed app's", () => {
  const plan = planDevRun(["--real"], {}, PLACES);
  assert.equal(plan.real, true);
  assert.equal(plan.dataFolder, String.raw`C:\Users\me\AppData\Roaming\QuoteBridge-dev`);
  assert.equal(plan.ports, undefined);
});

test("a fake run and a --real run signal reloads on ports of their own, so both can run at once", () => {
  assert.equal(planDevRun([], {}, PLACES).reloadPort, 6681);
  assert.equal(planDevRun(["--app"], {}, PLACES).reloadPort, 6681);
  assert.equal(planDevRun(["--real"], {}, PLACES).reloadPort, 6682);
  assert.equal(planDevRun(["--real"], { QUOTEBRIDGE_DEV_RELOAD_PORT: "7681" }, PLACES).reloadPort, 7681);
});

test("the environment can choose another data folder and ports, but never the installed app's data folder", () => {
  const plan = planDevRun(["--real"], { QUOTEBRIDGE_DATA_FOLDER: String.raw`D:\qb-dev`, QUOTEBRIDGE_EA_PORT: "7655" }, PLACES);
  assert.equal(plan.dataFolder, String.raw`D:\qb-dev`);
  assert.deepEqual(plan.ports, { ea: 7655, http: undefined });
  assert.deepEqual(planDevRun([], { QUOTEBRIDGE_HTTP_PORT: "7680" }, PLACES).ports, { ea: 6655, http: 7680 });
  for (const folder of [String.raw`C:\Users\me\AppData\Roaming\QuoteBridge`, "c:\\users\\ME\\appdata\\roaming\\quotebridge\\","C:/Users/me/AppData/Roaming/QuoteBridge"]) {
    assert.throws(() => planDevRun([], { QUOTEBRIDGE_DATA_FOLDER: folder }, PLACES), /installed app's data folder/);
  }
});

test("an unknown option stops the run with the usage", () => {
  assert.throws(() => planDevRun(["--fake"], {}, PLACES), /--fake.*npm run dev/s);
});

test("--real refuses to start while another program holds the EA or HTTP port, and names it", async () => {
  const [ea, http] = [await freePort(), await freePort()];
  assert.equal(await realPortsRefusal({ ea, http }), null);
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(ea, "127.0.0.1", resolve));
  try {
    const refusal = await realPortsRefusal({ ea, http });
    assert.match(refusal ?? "", new RegExp(`EA port ${ea}.*in use`));
    assert.doesNotMatch(refusal ?? "", new RegExp(`HTTP port ${http}`));
    assert.match(refusal ?? "", /installed QuoteBridge.*legacy server/s);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
  assert.equal(await realPortsRefusal({ ea, http }), null);
});

test("a burst of changes restarts once, after the changes have been quiet for a moment", () => {
  const clock = new ManualClock();
  let restarts = 0;
  const scheduler = new RestartScheduler(async () => void restarts++, { quietMs: 200, clock });
  scheduler.changed();
  clock.advance(150);
  scheduler.changed();
  clock.advance(150);
  scheduler.changed();
  clock.advance(199);
  assert.equal(restarts, 0);
  clock.advance(1);
  assert.equal(restarts, 1);
  clock.advance(10_000);
  assert.equal(restarts, 1);
});

test("changes during a restart bring exactly one more restart once it has finished", async () => {
  const clock = new ManualClock();
  const finish: (() => void)[] = [];
  let restarts = 0;
  const scheduler = new RestartScheduler(() => (restarts++, new Promise<void>((resolve) => finish.push(resolve))), { quietMs: 200, clock });
  scheduler.changed();
  clock.advance(200);
  assert.equal(restarts, 1);
  scheduler.changed();
  clock.advance(500);
  scheduler.changed();
  clock.advance(500);
  assert.equal(restarts, 1, "never overlaps a running restart");
  finish[0]();
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(0);
  assert.equal(restarts, 2);
  finish[1]();
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(10_000);
  assert.equal(restarts, 2);
});

test("a failed restart is reported and the next change restarts again", async () => {
  const clock = new ManualClock();
  const errors: unknown[] = [];
  let restarts = 0;
  const scheduler = new RestartScheduler(
    async () => {
      if (++restarts === 1) throw Error("boom");
    },
    { quietMs: 200, clock, onError: (e) => errors.push(e) },
  );
  scheduler.changed();
  clock.advance(200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((errors[0] as Error).message, "boom");
  scheduler.changed();
  clock.advance(200);
  assert.equal(restarts, 2);
});

test("only a dev dashboard build listens for the reload signal; the production bundle has no reload code", async () => {
  const bundle = async (options: Parameters<typeof dashboardBuildOptions>[0]) => {
    const result = await build({ ...dashboardBuildOptions(options), write: false, logLevel: "silent" });
    return result.outputFiles.find((f) => f.path.endsWith("app.js"))!.text;
  };
  const production = await bundle({});
  assert.doesNotMatch(production, /EventSource|quotebridge-dev-reload|location\.reload/);
  const dev = await bundle({ reloadUrl: "http://127.0.0.1:6681/events" });
  assert.match(dev, /new EventSource\("http:\/\/127\.0\.0\.1:6681\/events"\)/);
  assert.match(dev, /location\.reload\(\)/);
});

test("the dev reload server tells every open page to reload, or where to go after a server restart", async () => {
  const reloads = await startReloadServer(await freePort());
  const received: string[] = [];
  const response = await fetch(reloads.url, { headers: { origin: "http://127.0.0.1:6680" } });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const next = async () => {
    while (!received.join("").includes("\n\n")) received.push((await reader.read()).value ?? "");
    const text = received.join("");
    const end = text.indexOf("\n\n");
    received.splice(0, received.length, text.slice(end + 2));
    return text.slice(0, end);
  };
  await new Promise((resolve) => setTimeout(resolve, 50));
  reloads.reload();
  assert.equal(await next(), "event: reload\ndata: ");
  reloads.navigate("http://127.0.0.1:6680/session?token=abc");
  assert.equal(await next(), "event: navigate\ndata: http://127.0.0.1:6680/session?token=abc");
  await reader.cancel();
  await reloads.close();
});

test("a reload port already in use says so, and how to choose another", async (t) => {
  const first = await startReloadServer(await freePort());
  t.after(() => first.close());
  const port = Number(new URL(first.url).port);
  await assert.rejects(startReloadServer(port), new RegExp(`port ${port} is in use.*another dev run.*QUOTEBRIDGE_DEV_RELOAD_PORT`, "s"));
});

test("the app's main process gets its commands on a separate control stream", async () => {
  const reloads = await startReloadServer(await freePort());
  const response = await fetch(reloads.controlUrl);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  reloads.reload();
  reloads.control("restart-server");
  let text = "";
  while (!text.includes("\n\n")) text += (await reader.read()).value ?? "";
  assert.equal(text, "event: restart-server\ndata: \n\n");
  await reader.cancel();
  await reloads.close();
});
